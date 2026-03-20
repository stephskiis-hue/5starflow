const express  = require('express');
const twilio   = require('twilio');
const nodemailer = require('nodemailer');
const router   = express.Router();
const prisma   = require('../lib/prismaClient');
const { getTwilioCreds, toE164 } = require('../services/smsService');
const { getGmailCreds, ensureFreshToken } = require('../services/emailService');
const { getStatusTier } = require('../services/loyaltyService');
const { jobberGraphQL } = require('../services/jobberClient');

// ---------------------------------------------------------------------------
// GET /api/leaderboard
// Returns all active (non-opted-out) clients ranked by totalPoints DESC.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const userId  = req.user?.userId || '';
    const clients = await prisma.loyaltyClient.findMany({
      where:   { userId, optedOut: false },
      orderBy: { totalPoints: 'desc' },
    });

    const total  = clients.length;
    const ranked = clients.map((c, i) => ({
      rank:                 i + 1,
      jobberClientId:       c.jobberClientId,
      displayName:          c.displayName,
      totalPoints:          c.totalPoints,
      hasPendingMultiplier: c.hasPendingMultiplier,
      referralSlug:         c.referralSlug,
      status:               getStatusTier(i + 1, total),
    }));

    res.json(ranked);
  } catch (err) {
    console.error('[leaderboard] GET / error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/leaderboard/opt-out
// Body: { jobberClientId, optOut: true|false }
// Toggles the optedOut flag for a client. optOut=true removes from leaderboard.
// ---------------------------------------------------------------------------
router.post('/opt-out', async (req, res) => {
  const { jobberClientId, optOut } = req.body;
  const userId = req.user?.userId || '';

  if (!jobberClientId) return res.status(400).json({ error: 'jobberClientId required' });

  try {
    const record = await prisma.loyaltyClient.findUnique({
      where: { userId_jobberClientId: { userId, jobberClientId } },
    });
    if (!record) return res.status(404).json({ error: 'Client not found in leaderboard' });

    await prisma.loyaltyClient.update({
      where: { id: record.id },
      data:  { optedOut: optOut === true },
    });

    console.log(
      `[leaderboard] ${record.displayName} opted ${optOut ? 'OUT of' : 'back into'} the leaderboard`
    );
    res.json({ ok: true, optedOut: optOut === true });
  } catch (err) {
    console.error('[leaderboard] POST /opt-out error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/leaderboard/reward
// Body: { jobberClientId, channel: "sms"|"email", rewardText: "..." }
// Fetches client contact info from Jobber then sends reward message.
// ---------------------------------------------------------------------------
const GET_CLIENT_CONTACT = `
  query GetClientContact($clientId: EncodedId!) {
    client(id: $clientId) {
      name
      phones { number primary smsAllowed }
      emails { address primary }
    }
  }
`;

router.post('/reward', async (req, res) => {
  const { jobberClientId, channel, rewardText } = req.body;
  const userId = req.user?.userId || '';

  if (!jobberClientId || !channel) {
    return res.status(400).json({ error: 'jobberClientId and channel are required' });
  }

  // Fetch client from Jobber for contact details
  let clientData;
  try {
    const result = await jobberGraphQL(GET_CLIENT_CONTACT, { clientId: jobberClientId }, userId);
    clientData   = result?.client;
  } catch (err) {
    return res.status(500).json({ error: 'Jobber fetch failed: ' + err.message });
  }
  if (!clientData) return res.status(404).json({ error: 'Client not found in Jobber' });

  const firstName = (clientData.name || '').split(/\s+/)[0] || 'there';
  const msg = rewardText ||
    `Hey ${firstName}! You've earned a special reward from No-Bs Yardwork. Thank you for being a top client!`;

  if (process.env.DRY_RUN === 'true') {
    console.log(`[leaderboard] DRY RUN — would send ${channel} reward to ${clientData.name}: "${msg}"`);
    return res.json({ ok: true, dryRun: true });
  }

  try {
    if (channel === 'sms') {
      const phones = clientData.phones || [];
      const phone  = (phones.find(p => p.primary) || phones[0])?.number;
      if (!phone) return res.status(400).json({ error: 'Client has no phone number' });

      const creds  = await getTwilioCreds(userId);
      const client = twilio(creds.accountSid, creds.authToken);
      await client.messages.create({ body: msg, from: creds.fromNumber, to: toE164(phone) });

    } else if (channel === 'email') {
      const emails = clientData.emails || [];
      const email  = emails.find(e => e.primary)?.address || emails[0]?.address;
      if (!email) return res.status(400).json({ error: 'Client has no email address' });

      const creds = await getGmailCreds(userId);
      if (!creds)  return res.status(400).json({ error: 'Gmail not connected — connect via Settings' });

      const accessToken = await ensureFreshToken(userId, creds);
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          type:         'OAuth2',
          user:         creds.user,
          clientId:     process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          refreshToken: creds.refreshToken,
          accessToken,
        },
      });
      await transporter.sendMail({
        from:    `"${creds.fromName}" <${creds.user}>`,
        to:      email,
        subject: 'A reward from No-Bs Yardwork',
        text:    msg,
      });

    } else {
      return res.status(400).json({ error: 'channel must be "sms" or "email"' });
    }

    console.log(`[leaderboard] Reward ${channel} sent to ${clientData.name}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[leaderboard] POST /reward error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
