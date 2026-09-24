// Marks stale pending NOWPayments deposits as 'expired'.
// NOWPayments keeps unpaid payments in "waiting" indefinitely, so we enforce
// the validity window (DEPOSIT_VALID_HOURS) ourselves. Safe to run repeatedly.
// Usage:  npm run job:expire        (or schedule via cron)
const { pool } = require('../src/config/db');
const { expireStale } = require('../src/controllers/deposit.controller');

async function main() {
  const n = await expireStale(); // all users
  console.log(`Expired ${n} stale pending deposit(s).`);
  await pool.end();
}

main().catch((err) => {
  console.error('expireDeposits failed:', err.message);
  process.exit(1);
});
