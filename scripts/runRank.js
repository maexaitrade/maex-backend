// Recompute ranks for all users (safety net; also runs live on deposit confirm).
// Usage: node scripts/runRank.js
const { pool } = require('../src/config/db');
const { recomputeAllRanks } = require('../src/jobs/scheduler');

async function main() {
  await recomputeAllRanks();
  // eslint-disable-next-line no-console
  console.log('Ranks recomputed for all users.');
  await pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
