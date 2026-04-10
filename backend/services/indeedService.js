const prisma = require('../lib/prismaClient');

// ---------------------------------------------------------------------------
// Valid statuses for applicants
// ---------------------------------------------------------------------------
const VALID_STATUSES = ['new', 'reviewed', 'shortlisted', 'rejected', 'hired'];

// ---------------------------------------------------------------------------
// CSV Import — parse Indeed-exported CSV and bulk-insert applicants
// ---------------------------------------------------------------------------

/**
 * Parse an Indeed CSV export and import applicants into the database.
 * Indeed CSVs typically have: Name, Email, Phone, Date Applied, Experience, etc.
 * Handles header case-insensitivity and missing columns gracefully.
 *
 * @param {string}  csvString    - raw CSV text
 * @param {string}  userId       - portal user ID
 * @param {string}  jobPostingId - target job posting ID
 * @returns {{ imported: number, skipped: number, errors: string[] }}
 */
async function parseAndImportCSV(csvString, userId, jobPostingId) {
  const lines = csvString.trim().split(/\r?\n/);
  if (lines.length < 2) return { imported: 0, skipped: 0, errors: ['CSV has no data rows'] };

  // Parse header row — normalize to lowercase for flexible matching
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));

  // Map common Indeed CSV column names to our fields
  const colMap = {
    name:       headers.findIndex(h => h === 'name' || h === 'candidate name' || h === 'applicant name' || h === 'full name'),
    email:      headers.findIndex(h => h === 'email' || h === 'email address' || h === 'candidate email'),
    phone:      headers.findIndex(h => h === 'phone' || h === 'phone number' || h === 'candidate phone'),
    appliedAt:  headers.findIndex(h => h === 'date applied' || h === 'applied' || h === 'application date' || h === 'date'),
    experience: headers.findIndex(h => h === 'experience' || h === 'years of experience' || h === 'experience years' || h === 'years experience'),
    resume:     headers.findIndex(h => h === 'resume' || h === 'resume url' || h === 'resume link' || h === 'cv'),
  };

  if (colMap.name === -1) {
    return { imported: 0, skipped: 0, errors: ['Could not find a "Name" column in the CSV header'] };
  }

  let imported = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVRow(lines[i]);
    if (!row || row.length === 0) continue;

    const name = (row[colMap.name] || '').trim();
    if (!name) { skipped++; continue; }

    const email = colMap.email >= 0 ? (row[colMap.email] || '').trim() || null : null;
    const phone = colMap.phone >= 0 ? (row[colMap.phone] || '').trim() || null : null;
    const expRaw = colMap.experience >= 0 ? (row[colMap.experience] || '').trim() : null;
    const resumeUrl = colMap.resume >= 0 ? (row[colMap.resume] || '').trim() || null : null;

    // Parse experience — extract first number found
    let experienceYears = null;
    if (expRaw) {
      const match = expRaw.match(/(\d+\.?\d*)/);
      if (match) experienceYears = parseFloat(match[1]);
    }

    // Parse applied date
    let appliedAt = new Date();
    if (colMap.appliedAt >= 0) {
      const dateStr = (row[colMap.appliedAt] || '').trim();
      if (dateStr) {
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) appliedAt = parsed;
      }
    }

    try {
      await prisma.indeedApplicant.upsert({
        where: { email_jobPostingId: { email: email || `no-email-row-${i}`, jobPostingId } },
        update: {}, // skip if already exists
        create: {
          userId,
          jobPostingId,
          name,
          email,
          phone,
          resumeUrl,
          experienceYears,
          source: 'csv',
          status: 'new',
          appliedAt,
        },
      });
      imported++;
    } catch (err) {
      if (err.code === 'P2002') {
        skipped++;
      } else {
        errors.push(`Row ${i + 1} (${name}): ${err.message}`);
      }
    }
  }

  return { imported, skipped, errors };
}

/**
 * Simple CSV row parser that handles quoted fields with commas.
 */
function parseCSVRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Fetch paginated, filtered applicants.
 */
async function getApplicants(userId, { status, jobPostingId, search, sortBy, sortOrder, page, limit } = {}) {
  const where = { userId };

  if (status && VALID_STATUSES.includes(status)) where.status = status;
  if (jobPostingId) where.jobPostingId = jobPostingId;
  if (search) {
    where.OR = [
      { name:  { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search, mode: 'insensitive' } },
    ];
  }

  const take = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const skip = ((Math.max(parseInt(page, 10) || 1, 1)) - 1) * take;

  // Sort options
  const validSorts = { appliedAt: 'appliedAt', experience: 'experienceYears', name: 'name', status: 'status', createdAt: 'createdAt' };
  const orderField = validSorts[sortBy] || 'appliedAt';
  const orderDir = sortOrder === 'asc' ? 'asc' : 'desc';

  const [applicants, total] = await Promise.all([
    prisma.indeedApplicant.findMany({ where, orderBy: { [orderField]: orderDir }, skip, take }),
    prisma.indeedApplicant.count({ where }),
  ]);

  return { applicants, total, page: Math.floor(skip / take) + 1, pages: Math.ceil(total / take) };
}

/**
 * Get dashboard stat counts grouped by status.
 */
async function getStats(userId) {
  const counts = await prisma.indeedApplicant.groupBy({
    by: ['status'],
    where: { userId },
    _count: true,
  });

  const stats = { total: 0, new: 0, reviewed: 0, shortlisted: 0, rejected: 0, hired: 0 };
  for (const row of counts) {
    stats[row.status] = row._count;
    stats.total += row._count;
  }

  const activeJobs = await prisma.indeedJobPosting.count({ where: { userId, isActive: true } });
  stats.activeJobs = activeJobs;

  return stats;
}

/**
 * Update applicant status with validation.
 */
async function updateStatus(id, userId, newStatus) {
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  const applicant = await prisma.indeedApplicant.findUnique({ where: { id } });
  if (!applicant || applicant.userId !== userId) {
    throw new Error('Applicant not found');
  }
  return prisma.indeedApplicant.update({
    where: { id },
    data:  { status: newStatus },
  });
}

/**
 * Process an Indeed Apply webhook payload into an applicant record.
 * Matches job posting by title or URL, upserts by email+jobPostingId.
 */
async function processWebhookPayload(payload, userId) {
  const applicant = payload.applicant || payload;
  const jobInfo   = payload.job || {};

  const name  = [applicant.firstName, applicant.lastName].filter(Boolean).join(' ') || applicant.name || 'Unknown';
  const email = applicant.email || null;
  const phone = applicant.phone || null;

  // Try to match to existing job posting
  let jobPosting = null;
  if (jobInfo.title) {
    jobPosting = await prisma.indeedJobPosting.findFirst({
      where: { userId, title: { contains: jobInfo.title, mode: 'insensitive' } },
    });
  }

  // Auto-create job posting if not found
  if (!jobPosting) {
    jobPosting = await prisma.indeedJobPosting.create({
      data: {
        userId,
        title:     jobInfo.title || 'Unassigned',
        location:  jobInfo.location || '',
        indeedUrl: jobInfo.url || null,
      },
    });
  }

  return prisma.indeedApplicant.upsert({
    where: { email_jobPostingId: { email: email || `webhook-${Date.now()}`, jobPostingId: jobPosting.id } },
    update: { name, phone },
    create: {
      userId,
      jobPostingId: jobPosting.id,
      name,
      email,
      phone,
      resumeUrl:    applicant.resumeUrl || null,
      source:       'webhook',
      status:       'new',
      appliedAt:    new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Email polling — parse Indeed notification emails from Gmail
// ---------------------------------------------------------------------------

/**
 * Fetch Indeed notification emails from Gmail API and parse applicants.
 * Requires gmail.readonly scope on the GmailCredential.
 *
 * @param {string} userId
 * @returns {{ processed: number, skipped: number, errors: string[] }}
 */
async function pollIndeedEmails(userId) {
  const { getGmailCreds, ensureFreshToken } = require('./emailService');
  const axios = require('axios');

  const creds = await getGmailCreds(userId);
  if (!creds || !creds.refreshToken) {
    return { processed: 0, skipped: 0, errors: ['Gmail not connected'] };
  }

  const accessToken = await ensureFreshToken(userId, creds);

  // Search for Indeed application emails
  const query = encodeURIComponent('from:indeed.com subject:"applied" newer_than:7d');
  let messagesResp;
  try {
    messagesResp = await axios.get(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=50`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    // If scope is insufficient, return a clear error
    if (msg.includes('Insufficient Permission') || msg.includes('403')) {
      return { processed: 0, skipped: 0, errors: ['Gmail read permission not granted. Reconnect Gmail with read access to enable email polling.'] };
    }
    return { processed: 0, skipped: 0, errors: [msg] };
  }

  const messages = messagesResp.data?.messages || [];
  if (!messages.length) return { processed: 0, skipped: 0, errors: [] };

  let processed = 0;
  let skipped = 0;
  const errors = [];

  for (const msg of messages) {
    // Check dedup log
    const existing = await prisma.indeedEmailLog.findUnique({ where: { messageId: msg.id } });
    if (existing) { skipped++; continue; }

    try {
      // Fetch full message
      const fullMsg = await axios.get(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      const parsed = parseIndeedEmail(fullMsg.data);
      if (!parsed) {
        await prisma.indeedEmailLog.create({ data: { userId, messageId: msg.id, parsed: false } });
        skipped++;
        continue;
      }

      // Find or create job posting
      let jobPosting = null;
      if (parsed.jobTitle) {
        jobPosting = await prisma.indeedJobPosting.findFirst({
          where: { userId, title: { contains: parsed.jobTitle, mode: 'insensitive' } },
        });
      }
      if (!jobPosting) {
        jobPosting = await prisma.indeedJobPosting.create({
          data: { userId, title: parsed.jobTitle || 'Unassigned', location: parsed.location || '' },
        });
      }

      // Upsert applicant
      const emailKey = parsed.email || `email-${msg.id}`;
      await prisma.indeedApplicant.upsert({
        where: { email_jobPostingId: { email: emailKey, jobPostingId: jobPosting.id } },
        update: { name: parsed.name, phone: parsed.phone },
        create: {
          userId,
          jobPostingId:      jobPosting.id,
          name:              parsed.name || 'Unknown',
          email:             parsed.email,
          phone:             parsed.phone,
          experienceYears:   parsed.experienceYears,
          experienceSummary: parsed.experienceSummary,
          source:            'email',
          status:            'new',
          appliedAt:         parsed.appliedAt || new Date(),
        },
      });

      await prisma.indeedEmailLog.create({ data: { userId, messageId: msg.id, parsed: true } });
      processed++;
    } catch (err) {
      if (err.code === 'P2002') {
        skipped++;
      } else {
        errors.push(`Message ${msg.id}: ${err.message}`);
      }
      // Still log it so we don't retry
      await prisma.indeedEmailLog.create({ data: { userId, messageId: msg.id, parsed: false } }).catch(() => {});
    }
  }

  return { processed, skipped, errors };
}

/**
 * Parse an Indeed notification email into applicant data.
 * Indeed emails have subject lines like: "John Smith applied to Lawn Care Technician"
 * Body contains applicant details, experience, and contact info.
 *
 * @param {object} gmailMessage - full Gmail API message object
 * @returns {{ name, email, phone, jobTitle, location, experienceYears, experienceSummary, appliedAt } | null}
 */
function parseIndeedEmail(gmailMessage) {
  const headers = gmailMessage.payload?.headers || [];
  const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
  const dateStr = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';

  // Extract name and job title from subject: "FirstName LastName applied to Job Title"
  const subjectMatch = subject.match(/^(.+?)\s+(?:applied to|has applied for|applied for)\s+(.+?)(?:\s*[-–—]|$)/i);
  if (!subjectMatch) return null;

  const name = subjectMatch[1].trim();
  const jobTitle = subjectMatch[2].trim();

  // Get email body text
  const body = extractTextFromParts(gmailMessage.payload);

  // Parse contact info from body
  const emailMatch = body.match(/(?:Email|E-mail)\s*[:\-]\s*([^\s<>\n]+@[^\s<>\n]+)/i) ||
                     body.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  const phoneMatch = body.match(/(?:Phone|Tel|Mobile)\s*[:\-]\s*([\d\s()+\-]{7,})/i) ||
                     body.match(/((?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);

  // Parse experience
  const expMatch = body.match(/(\d+\.?\d*)\+?\s*(?:years?|yrs?)\s*(?:of\s*)?(?:experience|exp)/i);
  const expSummaryMatch = body.match(/(?:Experience|Summary|Background)\s*[:\-]\s*([^\n]{10,200})/i);

  // Parse location
  const locationMatch = body.match(/(?:Location|City|Address)\s*[:\-]\s*([^\n]{3,100})/i);

  return {
    name,
    email:             emailMatch ? emailMatch[1].trim() : null,
    phone:             phoneMatch ? phoneMatch[1].trim() : null,
    jobTitle,
    location:          locationMatch ? locationMatch[1].trim() : null,
    experienceYears:   expMatch ? parseFloat(expMatch[1]) : null,
    experienceSummary: expSummaryMatch ? expSummaryMatch[1].trim() : null,
    appliedAt:         dateStr ? new Date(dateStr) : new Date(),
  };
}

/**
 * Recursively extract plain text from Gmail message parts.
 */
function extractTextFromParts(payload) {
  if (!payload) return '';

  // Direct body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }

  // Multi-part — prefer text/plain
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64url').toString('utf8');
    }
    // Fall back to text/html stripped of tags
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, 'base64url').toString('utf8');
      return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    }
    // Recurse into nested parts
    for (const part of payload.parts) {
      const text = extractTextFromParts(part);
      if (text) return text;
    }
  }

  return '';
}

module.exports = {
  VALID_STATUSES,
  parseAndImportCSV,
  getApplicants,
  getStats,
  updateStatus,
  processWebhookPayload,
  pollIndeedEmails,
  parseIndeedEmail,
};
