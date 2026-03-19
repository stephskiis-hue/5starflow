/**
 * websiteAudit.js
 * Website Audit feature — FTP-based HTML page management with SEO/performance auditing.
 * All routes protected by requireAuth (applied in server.js via app.use(requireAuth)).
 *
 * Mount: app.use('/api/audit', auditRouter);
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const prisma  = require('../lib/prismaClient');
const { testConnection, previewFiles, listHtmlFiles, downloadFile, uploadFile } = require('../services/ftpService');
const { auditPage } = require('../services/auditService');

// ─────────────────────────────────────────────
// Password encryption helpers
// Uses AES-256-CBC if FTP_ENCRYPTION_KEY is set (must be 32 chars).
// Falls back to plaintext for local-only dev use.
// ─────────────────────────────────────────────

const ALGO    = 'aes-256-cbc';
const ENC_KEY = process.env.FTP_ENCRYPTION_KEY; // 32-char string if set

function encryptPassword(plaintext) {
  if (!ENC_KEY) return plaintext;
  const iv      = crypto.randomBytes(16);
  const cipher  = crypto.createCipheriv(ALGO, Buffer.from(ENC_KEY), iv);
  const enc     = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decryptPassword(stored) {
  if (!ENC_KEY) return stored;
  const parts = stored.split(':');
  if (parts.length !== 2) return stored; // not encrypted — return as-is
  const [ivHex, encHex] = parts;
  try {
    const iv       = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGO, Buffer.from(ENC_KEY), iv);
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return stored;
  }
}

// ─────────────────────────────────────────────
// Helper: get active FTP config with decrypted password
// ─────────────────────────────────────────────

async function getActiveConfig(userId) {
  const row = await prisma.ftpConfig.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  if (!row) return null;
  return { ...row, password: decryptPassword(row.encryptedPassword) };
}

// ─────────────────────────────────────────────
// FTP Config Endpoints
// ─────────────────────────────────────────────

// POST /api/audit/ftp-test
// Test FTP credentials without saving. Body: { host, user, password, port }
router.post('/ftp-test', async (req, res) => {
  const { host, user, password, port } = req.body || {};
  if (!host || !user || !password) {
    return res.status(400).json({ error: 'host, user, and password are required' });
  }
  try {
    const result = await testConnection({ host, user, password, port: port || 21 });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/audit/ftp-save
// Save FTP credentials. Singleton: replaces existing config.
// Body: { host, user, password, port, rootPath }
router.post('/ftp-save', async (req, res) => {
  const { host, user, password, port, rootPath } = req.body || {};
  if (!host || !user || !password) {
    return res.status(400).json({ error: 'host, user, and password are required' });
  }
  try {
    const userId = req.user.userId;
    await prisma.ftpConfig.deleteMany({ where: { userId } });
    const config = await prisma.ftpConfig.create({
      data: {
        userId,
        host,
        user,
        encryptedPassword: encryptPassword(password),
        rootPath:          rootPath || '/public_html',
        port:              parseInt(port, 10) || 21,
      },
    });
    res.json({ success: true, id: config.id });
  } catch (err) {
    console.error('[audit] ftp-save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/audit/ftp-config
// Returns current config without password.
router.get('/ftp-config', async (req, res) => {
  try {
    const row = await prisma.ftpConfig.findFirst({ where: { userId: req.user.userId }, orderBy: { createdAt: 'desc' } });
    if (!row) return res.json({ configured: false });
    const { encryptedPassword: _, ...safe } = row;
    res.json({ configured: true, ...safe });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// Preview Endpoint (read-only, no DB writes)
// ─────────────────────────────────────────────

// POST /api/audit/preview
// Walk FTP directory tree and return file tree. No DB changes.
// Optionally uses saved ignore patterns.
router.post('/preview', async (req, res) => {
  try {
    // Allow ad-hoc credentials in body (for testing before saving)
    const userId = req.user.userId;
    let config;
    const { host, user, password, port, rootPath: bodyRoot } = req.body || {};
    if (host && user && password) {
      config = { host, user, password, port: port || 21, rootPath: bodyRoot || '/public_html' };
    } else {
      config = await getActiveConfig(userId);
      if (!config) return res.status(400).json({ error: 'No FTP config saved and no credentials provided.' });
    }

    const ignoreRows = await prisma.auditIgnore.findMany({ where: { userId } });
    const ignorePatterns = ignoreRows.map(r => r.pattern);

    const tree = await previewFiles(config, config.rootPath || '/public_html', ignorePatterns);
    res.json({ success: true, tree });
  } catch (err) {
    console.error('[audit] preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// Ignore List Endpoints
// ─────────────────────────────────────────────

// GET /api/audit/ignore
router.get('/ignore', async (req, res) => {
  try {
    const patterns = await prisma.auditIgnore.findMany({ where: { userId: req.user.userId }, orderBy: { createdAt: 'asc' } });
    res.json({ patterns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/audit/ignore
// Body: { pattern: "cgi-bin" }
router.post('/ignore', async (req, res) => {
  const { pattern } = req.body || {};
  if (!pattern) return res.status(400).json({ error: 'pattern is required' });
  try {
    const userId = req.user.userId;
    const row = await prisma.auditIgnore.upsert({
      where:  { userId_pattern: { userId, pattern } },
      update: {},
      create: { userId, pattern },
    });
    res.json({ success: true, id: row.id, pattern: row.pattern });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/audit/ignore/:id
router.delete('/ignore/:id', async (req, res) => {
  try {
    await prisma.auditIgnore.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// Scan & Page Management
// ─────────────────────────────────────────────

// POST /api/audit/scan
// List all HTML files from FTP server, upsert AuditPage rows.
router.post('/scan', async (req, res) => {
  try {
    const userId = req.user.userId;
    const config = await getActiveConfig(userId);
    if (!config) return res.status(400).json({ error: 'No FTP config saved. Call /ftp-save first.' });

    const ignoreRows = await prisma.auditIgnore.findMany({ where: { userId } });
    const ignorePatterns = ignoreRows.map(r => r.pattern);

    const files = await listHtmlFiles(config, config.rootPath, ignorePatterns);

    const hostBase = config.host.startsWith('http') ? config.host : `https://${config.host}`;

    const upserts = await Promise.all(
      files.map(file => {
        const pageUrl = hostBase + file.path.replace(config.rootPath, '');
        return prisma.auditPage.upsert({
          where:  { userId_path: { userId, path: file.path } },
          update: { filename: file.filename, pageUrl },
          create: { userId, path: file.path, filename: file.filename, status: 'discovered', pageUrl },
        });
      })
    );

    res.json({ success: true, found: files.length, pages: upserts });
  } catch (err) {
    console.error('[audit] scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/audit/pages
// All AuditPage rows (localContent excluded to keep payload lean).
router.get('/pages', async (req, res) => {
  try {
    const pages = await prisma.auditPage.findMany({
      where:   { userId: req.user.userId },
      orderBy: { path: 'asc' },
      select: {
        id: true, path: true, filename: true, status: true,
        lastPulled: true, lastPushed: true, auditScore: true,
        perfScore: true, seoScore: true, pageUrl: true,
        auditIssuesJson: true, createdAt: true, updatedAt: true,
      },
    });
    res.json({ pages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/audit/pages/:id/content
// Returns just the localContent for the editor.
router.get('/pages/:id/content', async (req, res) => {
  try {
    const page = await prisma.auditPage.findUnique({
      where:  { id: req.params.id },
      select: { id: true, filename: true, localContent: true, status: true },
    });
    if (!page) return res.status(404).json({ error: 'Page not found' });
    res.json(page);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/audit/pages/:id/pull
// Download file from FTP, store as localContent.
router.post('/pages/:id/pull', async (req, res) => {
  const { id } = req.params;
  try {
    const page   = await prisma.auditPage.findUnique({ where: { id } });
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const config = await getActiveConfig();
    if (!config) return res.status(400).json({ error: 'No FTP config saved' });

    const content = await downloadFile(config, page.path);

    const updated = await prisma.auditPage.update({
      where: { id },
      data:  { localContent: content, lastPulled: new Date(), status: 'pulled' },
    });

    res.json({ success: true, status: updated.status, size: content.length });
  } catch (err) {
    console.error(`[audit] pull ${id} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/audit/pages/:id/audit
// Run SEO + performance audit on stored localContent.
router.post('/pages/:id/audit', async (req, res) => {
  const { id } = req.params;
  try {
    const page = await prisma.auditPage.findUnique({ where: { id } });
    if (!page) return res.status(404).json({ error: 'Page not found' });
    if (!page.localContent) return res.status(400).json({ error: 'No local content — pull the page first' });

    await prisma.auditPage.update({ where: { id }, data: { status: 'auditing' } });

    const results = await auditPage({
      html:     page.localContent,
      pageUrl:  page.pageUrl || null,
      filename: page.filename,
    });

    // Merge SEO issues + AI suggestions into one issues array
    const allIssues = [
      ...results.issues,
      ...(results.aiSuggestions || []).map(s => ({
        type:     'ai',
        severity: 'suggestion',
        message:  `${s.title}: ${s.description}`,
        fix:      s.fix,
      })),
    ];

    await prisma.auditPage.update({
      where: { id },
      data: {
        status:          'audited',
        seoScore:        results.seoScore,
        perfScore:       results.perfScore,
        auditScore:      results.auditScore,
        auditIssuesJson: JSON.stringify(allIssues),
      },
    });

    res.json({
      success:    true,
      seoScore:   results.seoScore,
      perfScore:  results.perfScore,
      auditScore: results.auditScore,
      issueCount: allIssues.length,
      issues:     allIssues,
    });
  } catch (err) {
    console.error(`[audit] audit ${id} error:`, err.message);
    await prisma.auditPage.update({ where: { id }, data: { status: 'pulled' } }).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/audit/pages/:id/content
// Save edited HTML locally (does not push to server).
// Body: { content: "<html>..." }
router.put('/pages/:id/content', async (req, res) => {
  const { id } = req.params;
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content is required' });
  try {
    const page = await prisma.auditPage.findUnique({ where: { id } });
    if (!page) return res.status(404).json({ error: 'Page not found' });
    await prisma.auditPage.update({
      where: { id },
      data:  { localContent: content, status: 'edited' },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/audit/pages/:id/push
// Upload localContent back to FTP server.
router.post('/pages/:id/push', async (req, res) => {
  const { id } = req.params;
  try {
    const page = await prisma.auditPage.findUnique({ where: { id } });
    if (!page) return res.status(404).json({ error: 'Page not found' });
    if (!page.localContent) return res.status(400).json({ error: 'No local content to push' });

    const config = await getActiveConfig();
    if (!config) return res.status(400).json({ error: 'No FTP config saved' });

    await uploadFile(config, page.path, page.localContent);

    await prisma.auditPage.update({
      where: { id },
      data:  { status: 'pushed', lastPushed: new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    console.error(`[audit] push ${id} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/audit/pages/:id/mark-done
// Mark page workflow as complete.
router.post('/pages/:id/mark-done', async (req, res) => {
  const { id } = req.params;
  try {
    const page = await prisma.auditPage.findUnique({ where: { id } });
    if (!page) return res.status(404).json({ error: 'Page not found' });
    await prisma.auditPage.update({ where: { id }, data: { status: 'done' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/audit/pages/:id
// Remove a page from tracking (does not delete the file from FTP).
router.delete('/pages/:id', async (req, res) => {
  try {
    await prisma.auditPage.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/audit/summary
// Aggregate stats for dashboard card.
router.get('/summary', async (req, res) => {
  try {
    const userId = req.user.userId;
    const [total, discovered, pulled, audited, edited, pushed, done] = await Promise.all([
      prisma.auditPage.count({ where: { userId } }),
      prisma.auditPage.count({ where: { userId, status: 'discovered' } }),
      prisma.auditPage.count({ where: { userId, status: 'pulled' } }),
      prisma.auditPage.count({ where: { userId, status: 'audited' } }),
      prisma.auditPage.count({ where: { userId, status: 'edited' } }),
      prisma.auditPage.count({ where: { userId, status: 'pushed' } }),
      prisma.auditPage.count({ where: { userId, status: 'done' } }),
    ]);

    const avgScore = await prisma.auditPage.aggregate({
      _avg: { auditScore: true },
      where: { userId, auditScore: { not: null } },
    });

    res.json({
      total, discovered, pulled, audited, edited, pushed, done,
      avgAuditScore: avgScore._avg.auditScore ? Math.round(avgScore._avg.auditScore) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
