const cron = require('node-cron');
const env = require('../config/env');
const { pool } = require('../config/db');
const { runDailyRoi } = require('../services/roi.service');
const { recomputeRank } = require('../services/rank.service');
const { withTransaction } = require('../config/db');
const { expireStale } = require('../controllers/deposit.controller');

// Recomputes ranks for all users (safety net; ranks are also updated live on
// deposit confirmation).
async function recomputeAllRanks() {
  const [users] = await pool.query('SELECT id FROM users');
  for (const { id } of users) {
    await withTransaction((conn) => recomputeRank(conn, id));
  }
}

// Registers the daily jobs. Called from server.js when ENABLE_CRON=true.
function startScheduler() {
  const hour = env.cron.roiHour;
  const expr = `0 ${hour} * * *`; // every day at HH:00
  cron.schedule(expr, async () => {
    try {
      const summary = await runDailyRoi();
      // eslint-disable-next-line no-console
      console.log('[cron] daily ROI:', summary);
      await recomputeAllRanks();
      console.log('[cron] ranks recomputed');
    } catch (err) {
      console.error('[cron] job failed:', err);
    }
  });
  // eslint-disable-next-line no-console
  console.log(`[cron] daily ROI scheduled at ${hour}:00 (server time)`);

  // Expire stale pending deposits every 10 minutes (NOWPayments never does).
  cron.schedule('*/10 * * * *', async () => {
    try {
      const n = await expireStale();
      if (n > 0) console.log(`[cron] expired ${n} stale pending deposit(s)`);
    } catch (err) {
      console.error('[cron] expire deposits failed:', err);
    }
  });
  // eslint-disable-next-line no-console
  console.log('[cron] stale-deposit expiry scheduled every 10 min');
}

module.exports = { startScheduler, recomputeAllRanks };
