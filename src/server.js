const app = require('./app');
const env = require('./config/env');
const { pool } = require('./config/db');
const { startScheduler } = require('./jobs/scheduler');
const { runRoiCatchUp } = require('./services/roi.service');

async function main() {
  // Fail fast if the DB is unreachable.
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    // eslint-disable-next-line no-console
    console.log(`[db] connected to ${env.db.host}:${env.db.port}/${env.db.database}`);
  } catch (err) {
    console.error('[db] connection failed — check your .env and that MySQL is running');
    console.error(err.message);
    process.exit(1);
  }

  // Credit any ROI days missed while the server was down (idempotent per day),
  // so daily earnings stay current even after downtime — not only at cron time.
  try {
    const caught = await runRoiCatchUp();
    if (caught.days > 0) {
      console.log(`[roi] catch-up: ${caught.days} day(s) processed, $${caught.totalPaid} credited (through ${caught.to})`);
    }
  } catch (err) {
    console.error('[roi] catch-up failed:', err.message);
  }

  if (env.cron.enabled) startScheduler();

  app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] MAEX Trade API on http://localhost:${env.port}`);
  });
}

main();
