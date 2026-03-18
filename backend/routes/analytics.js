const express = require('express');
const router  = express.Router();
const { getGA4Stats } = require('../services/analyticsService');

// GET /api/analytics/stats
// Returns GA4 traffic stats for the last 7 days.
// Returns { configured: false } gracefully if env vars are missing.
router.get('/stats', async (req, res) => {
  try {
    const stats = await getGA4Stats();
    res.json(stats);
  } catch (err) {
    console.error('[analytics] /stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
