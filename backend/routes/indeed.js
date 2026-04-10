const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/prismaClient');
const {
  VALID_STATUSES,
  parseAndImportCSV,
  getApplicants,
  getStats,
  updateStatus,
  pollIndeedEmails,
} = require('../services/indeedService');

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
router.get('/stats', async (req, res) => {
  try {
    const stats = await getStats(req.user.userId);
    res.json(stats);
  } catch (err) {
    console.error('[indeed] /stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Applicants — list (paginated + filtered)
// ---------------------------------------------------------------------------
router.get('/applicants', async (req, res) => {
  try {
    const result = await getApplicants(req.user.userId, req.query);
    res.json(result);
  } catch (err) {
    console.error('[indeed] /applicants error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Applicants — bulk status update (must be before :id routes)
// ---------------------------------------------------------------------------
router.post('/applicants/bulk-status', async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status. Must be: ${VALID_STATUSES.join(', ')}` });

    const result = await prisma.indeedApplicant.updateMany({
      where: { id: { in: ids }, userId: req.user.userId },
      data: { status },
    });
    res.json({ ok: true, updated: result.count });
  } catch (err) {
    console.error('[indeed] bulk-status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Applicant — single detail with notes
// ---------------------------------------------------------------------------
router.get('/applicants/:id', async (req, res) => {
  try {
    const applicant = await prisma.indeedApplicant.findUnique({ where: { id: req.params.id } });
    if (!applicant || applicant.userId !== req.user.userId) {
      return res.status(404).json({ error: 'Applicant not found' });
    }

    const notes = await prisma.indeedNote.findMany({
      where: { applicantId: req.params.id, userId: req.user.userId },
      orderBy: { createdAt: 'desc' },
    });

    // Get job posting title
    const job = await prisma.indeedJobPosting.findUnique({ where: { id: applicant.jobPostingId } });

    res.json({ ...applicant, jobTitle: job?.title || 'Unknown', notes });
  } catch (err) {
    console.error('[indeed] /applicants/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Applicant — update status
// ---------------------------------------------------------------------------
router.patch('/applicants/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const updated = await updateStatus(req.params.id, req.user.userId, status);
    res.json({ ok: true, applicant: updated });
  } catch (err) {
    console.error('[indeed] status update error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Applicant — delete
// ---------------------------------------------------------------------------
router.delete('/applicants/:id', async (req, res) => {
  try {
    const applicant = await prisma.indeedApplicant.findUnique({ where: { id: req.params.id } });
    if (!applicant || applicant.userId !== req.user.userId) {
      return res.status(404).json({ error: 'Applicant not found' });
    }
    await prisma.indeedNote.deleteMany({ where: { applicantId: req.params.id } });
    await prisma.indeedApplicant.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[indeed] delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Applicant — manual add
// ---------------------------------------------------------------------------
router.post('/applicants', async (req, res) => {
  try {
    const { name, email, phone, experienceYears, experienceSummary, jobPostingId } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!jobPostingId) return res.status(400).json({ error: 'Job posting is required' });

    const applicant = await prisma.indeedApplicant.create({
      data: {
        userId: req.user.userId,
        jobPostingId,
        name,
        email:             email || null,
        phone:             phone || null,
        experienceYears:   experienceYears ? parseFloat(experienceYears) : null,
        experienceSummary: experienceSummary || null,
        source:            'manual',
        status:            'new',
      },
    });
    res.json({ ok: true, applicant });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Applicant with this email already exists for this job posting' });
    console.error('[indeed] add error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// CSV Import
// ---------------------------------------------------------------------------
router.post('/import-csv', async (req, res) => {
  try {
    const { csvData, jobPostingId } = req.body;
    if (!csvData) return res.status(400).json({ error: 'csvData is required' });
    if (!jobPostingId) return res.status(400).json({ error: 'jobPostingId is required' });

    const result = await parseAndImportCSV(csvData, req.user.userId, jobPostingId);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[indeed] import-csv error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
router.get('/applicants/:id/notes', async (req, res) => {
  try {
    const notes = await prisma.indeedNote.findMany({
      where: { applicantId: req.params.id, userId: req.user.userId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(notes);
  } catch (err) {
    console.error('[indeed] notes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/applicants/:id/notes', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Note content is required' });

    const note = await prisma.indeedNote.create({
      data: {
        userId: req.user.userId,
        applicantId: req.params.id,
        content: content.trim(),
      },
    });
    res.json({ ok: true, note });
  } catch (err) {
    console.error('[indeed] add note error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Job Postings
// ---------------------------------------------------------------------------
router.get('/jobs', async (req, res) => {
  try {
    const jobs = await prisma.indeedJobPosting.findMany({
      where: { userId: req.user.userId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(jobs);
  } catch (err) {
    console.error('[indeed] /jobs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/jobs', async (req, res) => {
  try {
    const { title, location, jobType, indeedUrl } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const job = await prisma.indeedJobPosting.create({
      data: {
        userId: req.user.userId,
        title,
        location: location || '',
        jobType:  jobType || 'full-time',
        indeedUrl: indeedUrl || null,
      },
    });
    res.json({ ok: true, job });
  } catch (err) {
    console.error('[indeed] add job error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/jobs/:id', async (req, res) => {
  try {
    const existing = await prisma.indeedJobPosting.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.user.userId) {
      return res.status(404).json({ error: 'Job posting not found' });
    }
    const { title, location, jobType, indeedUrl, isActive } = req.body;
    const job = await prisma.indeedJobPosting.update({
      where: { id: req.params.id },
      data: {
        ...(title !== undefined && { title }),
        ...(location !== undefined && { location }),
        ...(jobType !== undefined && { jobType }),
        ...(indeedUrl !== undefined && { indeedUrl }),
        ...(isActive !== undefined && { isActive }),
      },
    });
    res.json({ ok: true, job });
  } catch (err) {
    console.error('[indeed] update job error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/jobs/:id', async (req, res) => {
  try {
    const existing = await prisma.indeedJobPosting.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.user.userId) {
      return res.status(404).json({ error: 'Job posting not found' });
    }
    await prisma.indeedJobPosting.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[indeed] archive job error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
router.get('/settings', async (req, res) => {
  try {
    const settings = await prisma.indeedSettings.findUnique({ where: { userId: req.user.userId } });
    res.json(settings || { webhookSecret: null, indeedEmployerUrl: null, notifyEmail: null });
  } catch (err) {
    console.error('[indeed] settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const { webhookSecret, indeedEmployerUrl, notifyEmail } = req.body;
    const settings = await prisma.indeedSettings.upsert({
      where: { userId: req.user.userId },
      update: {
        ...(webhookSecret !== undefined && { webhookSecret }),
        ...(indeedEmployerUrl !== undefined && { indeedEmployerUrl }),
        ...(notifyEmail !== undefined && { notifyEmail }),
      },
      create: {
        userId: req.user.userId,
        webhookSecret: webhookSecret || null,
        indeedEmployerUrl: indeedEmployerUrl || null,
        notifyEmail: notifyEmail || null,
      },
    });
    res.json({ ok: true, settings });
  } catch (err) {
    console.error('[indeed] settings update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Connection status (for connections page card)
// ---------------------------------------------------------------------------
router.get('/connection-status', async (req, res) => {
  try {
    const settings = await prisma.indeedSettings.findFirst({ where: { userId: req.user.userId } });
    const applicantCount = await prisma.indeedApplicant.count({ where: { userId: req.user.userId } });
    const jobCount = await prisma.indeedJobPosting.count({ where: { userId: req.user.userId, isActive: true } });

    res.json({
      configured: !!(settings && (settings.webhookSecret || settings.notifyEmail)),
      applicantCount,
      jobCount,
      webhookUrl: `${process.env.APP_URL || ''}/webhook/indeed`,
    });
  } catch (err) {
    console.error('[indeed] connection-status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Email polling — manual trigger
// ---------------------------------------------------------------------------
router.post('/poll-emails', async (req, res) => {
  try {
    const result = await pollIndeedEmails(req.user.userId);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[indeed] poll-emails error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
