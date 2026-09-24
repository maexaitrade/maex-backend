const mysql = require('mysql2/promise');
const env = require('./env');

// Connection pool. decimalNumbers keeps DECIMAL columns as JS numbers
// (fine for this project's magnitudes); money math is still done carefully.
const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: 50,
  queueLimit: 0,
  decimalNumbers: true,
  timezone: 'Z',
});

/**
 * Run an async function inside a single DB transaction.
 * The callback receives a dedicated connection; commit/rollback is automatic.
 */
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, withTransaction };
