const prisma = require('../lib/prismaClient');
const { jobberGraphQL } = require('./jobberClient');
const { discoverMarketingConsentFields } = require('./jobberSchema');
const { pickPrimary, computeEligibility } = require('./campaignUtils');
const { toE164 } = require('./smsService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let syncState = { status: 'idle', startedAt: null, completedAt: null, synced: 0, pages: 0, error: null };
function getSyncStatus() { return { ...syncState }; }

function extractConsentValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    if (typeof v.status === 'string') return v.status;
    if (typeof v.value === 'string') return v.value;
  }
  try { return JSON.stringify(v); } catch { return String(v); }
}

function buildClientsQuery({ sms, email }) {
  const clientConsentFields = [];
  if (sms?.on === 'client' && sms.field) clientConsentFields.push(sms.field);
  if (email?.on === 'client' && email.field) clientConsentFields.push(email.field);

  const phoneConsentFields = [];
  if (sms?.on === 'phone' && sms.field) phoneConsentFields.push(sms.field);

  const emailObjConsentFields = [];
  if (email?.on === 'email' && email.field) emailObjConsentFields.push(email.field);

  const clientConsent = clientConsentFields.length ? '\n        ' + clientConsentFields.join('\n        ') : '';
  const phoneConsent  = phoneConsentFields.length ? ' ' + phoneConsentFields.join(' ') : '';
  const emailConsent  = emailObjConsentFields.length ? ' ' + emailObjConsentFields.join(' ') : '';

  return `
    query CampaignSyncClients($cursor: String) {
      clients(first: 50, after: $cursor) {
        nodes {
          id
          name
          tags(first: 50) { nodes { label } }
          phones { number primary smsAllowed${phoneConsent} }
          emails { address primary${emailConsent} }${clientConsent}
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
}

async function syncClientsForUser(userId, { dryRun = false, minAvailablePoints = 1000 } = {}) {
  const accounts = await prisma.jobberAccount.findMany({ where: { userId } });
  if (accounts.length === 0) throw new Error('No Jobber account connected for this user');

  syncState = { status: 'running', startedAt: new Date(), completedAt: null, synced: 0, pages: 0, error: null };

  try {
    let consent;
    try {
      consent = await discoverMarketingConsentFields(userId);
    } catch (err) {
      console.warn('[campaignSync] Consent discovery failed — falling back to env overrides only:', err.message);
      const smsOn = (process.env.JOBBER_SMS_CONSENT_ON || '').toLowerCase();
      const emailOn = (process.env.JOBBER_EMAIL_CONSENT_ON || '').toLowerCase();
      consent = {
        sms:   { on: smsOn === 'phone' ? 'phone' : 'client', field: process.env.JOBBER_SMS_CONSENT_FIELD || null },
        email: { on: emailOn === 'email' ? 'email' : 'client', field: process.env.JOBBER_EMAIL_CONSENT_FIELD || null },
        phoneType: null,
        emailType: null,
      };
    }
    console.log('[campaignSync] Consent discovery:', JSON.stringify(consent));

    const query = buildClientsQuery(consent);

    let totalSynced = 0;
    let totalPages = 0;

    // Current jobberClient.js picks the first account for the userId internally.
    // If you connect multiple Jobber orgs per user, this will need to be extended.
    const account = accounts[0];

    let cursor = null;
    let hasNext = true;

    while (hasNext) {
      // eslint-disable-next-line no-await-in-loop
      const { data, extensions } = await jobberGraphQL(query, { cursor }, userId, { returnExtensions: true });

      const nodes = data?.clients?.nodes || [];
      const pageInfo = data?.clients?.pageInfo || {};

      totalPages += 1;

      const throttle = extensions?.cost?.throttleStatus || null;
      if (throttle) {
        const { currentlyAvailable, restoreRate } = throttle;
        if (typeof currentlyAvailable === 'number' && currentlyAvailable < minAvailablePoints && typeof restoreRate === 'number' && restoreRate > 0) {
          const waitMs = Math.ceil(((minAvailablePoints - currentlyAvailable) / restoreRate) * 1000) + 250;
          console.log(`[campaignSync] Throttle buffer low (${currentlyAvailable} pts) — waiting ${waitMs}ms`);
          // eslint-disable-next-line no-await-in-loop
          await sleep(waitMs);
        }
      }

      if (nodes.length > 0) {
        const ids = nodes.map((c) => c.id).filter(Boolean);
        // eslint-disable-next-line no-await-in-loop
        const existing = await prisma.campaignClient.findMany({
          where: { jobberAccountId: account.id, jobberClientId: { in: ids } },
          select: { jobberClientId: true, optedOut: true },
        }).catch(() => []);
        const optedOutMap = new Map(existing.map((r) => [r.jobberClientId, r.optedOut === true]));

        const upserts = nodes.map((c) => {
          const phones = Array.isArray(c.phones) ? c.phones : [];
          const emails = Array.isArray(c.emails) ? c.emails : [];

          const primaryPhone = pickPrimary(phones);
          const primaryEmail = pickPrimary(emails);

          const phone = primaryPhone?.number ? toE164(primaryPhone.number) : null;
          const emailAddrRaw = primaryEmail?.address ? String(primaryEmail.address).trim() : '';
          const emailAddr = emailAddrRaw ? emailAddrRaw : null;

          const smsAllowedFlag = primaryPhone?.smsAllowed === true;

          const smsConsentStatus =
            consent.sms?.on === 'client'
              ? extractConsentValue(consent.sms.field ? c[consent.sms.field] : null)
              : extractConsentValue(consent.sms.field ? primaryPhone?.[consent.sms.field] : null);

          const emailConsentStatus =
            consent.email?.on === 'client'
              ? extractConsentValue(consent.email.field ? c[consent.email.field] : null)
              : extractConsentValue(consent.email.field ? primaryEmail?.[consent.email.field] : null);

          const optedOut = optedOutMap.get(c.id) === true;

          const { isSmsEligible, isEmailEligible } = computeEligibility({
            phone,
            email: emailAddr,
            smsAllowedFlag,
            smsConsentStatus,
            emailConsentStatus,
            optedOut,
          });

          const tags = (c.tags?.nodes || []).map((t) => t.label).filter(Boolean);

          const createData = {
            userId,
            jobberAccountId: account.id,
            jobberClientId: c.id,
            fullName: c.name || 'Unknown',
            primaryPhone: phone,
            primaryEmail: emailAddr,
            smsAllowedFlag,
            smsConsentStatus,
            emailConsentStatus,
            isSmsEligible,
            isEmailEligible,
            tags,
            syncedAt: new Date(),
            // optedOut/optedOutAt intentionally left to defaults on create
          };

          const updateData = {
            fullName: c.name || 'Unknown',
            primaryPhone: phone,
            primaryEmail: emailAddr,
            smsAllowedFlag,
            smsConsentStatus,
            emailConsentStatus,
            isSmsEligible,
            isEmailEligible,
            tags,
            syncedAt: new Date(),
          };

          if (dryRun) {
            console.log('[campaignSync] DRY RUN upsert:', JSON.stringify({ key: { jobberAccountId: account.id, jobberClientId: c.id }, update: updateData }));
            return null;
          }

          return prisma.campaignClient.upsert({
            where: { jobberAccountId_jobberClientId: { jobberAccountId: account.id, jobberClientId: c.id } },
            create: createData,
            update: updateData,
          });
        }).filter(Boolean);

        if (!dryRun) {
          // Concurrency guard — avoid blasting the DB with 50 independent queries at once.
          const CONCURRENCY = parseInt(process.env.SYNC_UPSERT_CONCURRENCY, 10) || 10;
          for (let i = 0; i < upserts.length; i += CONCURRENCY) {
            // eslint-disable-next-line no-await-in-loop
            await Promise.all(upserts.slice(i, i + CONCURRENCY));
          }
        }
        totalSynced += nodes.length;
      }

      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
      hasNext = !!cursor;
      syncState = { ...syncState, synced: totalSynced, pages: totalPages };
    }

    syncState = { ...syncState, status: 'done', completedAt: new Date(), synced: totalSynced, pages: totalPages, error: null };
    console.log(`[campaignSync] Sync complete — clients processed: ${totalSynced}, pages: ${totalPages}`);
    return { synced: totalSynced, pages: totalPages };
  } catch (err) {
    syncState = { ...syncState, status: 'error', completedAt: new Date(), error: err.message || 'Sync failed' };
    console.error('[campaignSync] Sync error:', err.message);
    throw err;
  }
}

module.exports = {
  syncClientsForUser,
  getSyncStatus,
};
