/**
 * FTP password encryption for stored FtpConfig rows (Website Audit, SEO site access).
 * Uses AES-256-CBC if FTP_ENCRYPTION_KEY is set (must be 32 chars).
 * Falls back to plaintext for local-only dev use.
 */
const crypto = require('crypto');

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

module.exports = { encryptPassword, decryptPassword };
