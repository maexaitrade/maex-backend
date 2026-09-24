// Manually run the daily ROI job (useful for demos/testing).
// Usage: node scripts/runRoi.js [YYYY-MM-DD]
const { pool } = require('../src/config/db');
const { runDailyRoi } = require('../src/services/roi.service');

async function main() {
  const date = process.argv[2];
  const summary = await runDailyRoi(date);
  // eslint-disable-next-line no-console
  console.log('Daily ROI summary:', summary);
  await pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
