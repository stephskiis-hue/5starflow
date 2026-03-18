/**
 * ftpService.js
 * FTP operations for the Website Audit feature.
 * Uses the basic-ftp package (already installed).
 *
 * All public functions accept a config object:
 *   { host, user, password, port, rootPath }
 * Password must be decrypted plaintext — decryption happens in the route layer.
 *
 * Each function manages its own connection lifecycle (open → operate → close).
 * This avoids stale connection issues across the long idle periods typical of a dashboard.
 */

const ftp = require('basic-ftp');
const { Readable, PassThrough } = require('stream');

// ─────────────────────────────────────────────
// Internal: build a connected FTP client
// ─────────────────────────────────────────────

async function _connect(config) {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  await client.access({
    host:     config.host,
    port:     config.port || 21,
    user:     config.user,
    password: config.password,
    secure:   false,
  });
  return client;
}

// ─────────────────────────────────────────────
// testConnection — auth check only, no DB changes
// ─────────────────────────────────────────────

/**
 * Test FTP credentials. Does not save anything.
 * @param {{ host, user, password, port }} config
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function testConnection(config) {
  const client = new ftp.Client();
  try {
    await client.access({
      host:     config.host,
      port:     config.port || 21,
      user:     config.user,
      password: config.password,
      secure:   false,
    });
    return { ok: true, message: `Connected to ${config.host} as ${config.user}` };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    client.close();
  }
}

// ─────────────────────────────────────────────
// previewFiles — read-only directory walk, no DB writes
// ─────────────────────────────────────────────

/**
 * Walk the FTP directory tree and return a nested file tree structure.
 * Read-only — no DB changes, no file downloads.
 * Used by the Preview tab before the user commits to a full scan.
 *
 * @param {{ host, user, password, port }} config
 * @param {string} rootPath  e.g. "/public_html"
 * @param {string[]} [ignorePatterns]  path substrings to skip
 * @returns {Promise<Array<{ name, path, type: 'file'|'dir', size?, children? }>>}
 */
async function previewFiles(config, rootPath, ignorePatterns = []) {
  const client = await _connect(config);

  function isIgnored(filePath) {
    if (!ignorePatterns.length) return false;
    return ignorePatterns.some(p => filePath.toLowerCase().includes(p.toLowerCase()));
  }

  async function scanDir(dirPath) {
    let entries;
    try {
      entries = await client.list(dirPath);
    } catch {
      return [];
    }

    const nodes = [];
    for (const entry of entries) {
      const fullPath = dirPath.replace(/\/$/, '') + '/' + entry.name;
      if (isIgnored(fullPath)) continue;

      if (entry.type === ftp.FileType.Directory) {
        if (entry.name.startsWith('.')) continue;
        const children = await scanDir(fullPath);
        nodes.push({ name: entry.name, path: fullPath, type: 'dir', children });
      } else if (entry.type === ftp.FileType.File) {
        nodes.push({
          name: entry.name,
          path: fullPath,
          type: 'file',
          size: entry.size,
        });
      }
    }
    return nodes;
  }

  try {
    const tree = await scanDir(rootPath || '/public_html');
    return tree;
  } finally {
    client.close();
  }
}

// ─────────────────────────────────────────────
// listHtmlFiles — for scan endpoint, filters to .html/.htm only
// ─────────────────────────────────────────────

/**
 * Recursively list all .html/.htm files under rootPath.
 * Skips hidden directories, cgi-bin, and any ignore patterns.
 *
 * @param {{ host, user, password, port }} config
 * @param {string} rootPath
 * @param {string[]} [ignorePatterns]
 * @returns {Promise<Array<{ path: string, filename: string, size: number }>>}
 */
async function listHtmlFiles(config, rootPath, ignorePatterns = []) {
  const client = await _connect(config);
  const results = [];

  function isIgnored(filePath) {
    if (!ignorePatterns.length) return false;
    return ignorePatterns.some(p => filePath.toLowerCase().includes(p.toLowerCase()));
  }

  async function scanDir(dirPath) {
    if (isIgnored(dirPath)) return;
    let entries;
    try {
      entries = await client.list(dirPath);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = dirPath.replace(/\/$/, '') + '/' + entry.name;
      if (isIgnored(fullPath)) continue;

      if (entry.type === ftp.FileType.Directory) {
        if (entry.name.startsWith('.') || entry.name === 'cgi-bin') continue;
        await scanDir(fullPath);
      } else if (entry.type === ftp.FileType.File) {
        const lower = entry.name.toLowerCase();
        if (lower.endsWith('.html') || lower.endsWith('.htm')) {
          results.push({ path: fullPath, filename: entry.name, size: entry.size });
        }
      }
    }
  }

  try {
    await scanDir(rootPath || '/public_html');
    return results;
  } finally {
    client.close();
  }
}

// ─────────────────────────────────────────────
// downloadFile — pull single file as string
// ─────────────────────────────────────────────

/**
 * Download a single file and return its content as a UTF-8 string.
 * @param {{ host, user, password, port }} config
 * @param {string} remotePath
 * @returns {Promise<string>}
 */
async function downloadFile(config, remotePath) {
  const client = await _connect(config);
  try {
    const chunks = [];
    const stream = new PassThrough();
    const promise = new Promise((resolve, reject) => {
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    await client.downloadTo(stream, remotePath);
    return await promise;
  } finally {
    client.close();
  }
}

// ─────────────────────────────────────────────
// uploadFile — push string back to server
// ─────────────────────────────────────────────

/**
 * Upload a string to overwrite a file on the FTP server.
 * @param {{ host, user, password, port }} config
 * @param {string} remotePath
 * @param {string} content  UTF-8 HTML content
 * @returns {Promise<void>}
 */
async function uploadFile(config, remotePath, content) {
  const client = await _connect(config);
  try {
    const stream = Readable.from([content]);
    await client.uploadFrom(stream, remotePath);
  } finally {
    client.close();
  }
}

module.exports = {
  testConnection,
  previewFiles,
  listHtmlFiles,
  downloadFile,
  uploadFile,
};
