// Creates the database and all tables from sql/schema.sql.
// Usage: npm run db:init            (safe: refuses if the DB already has data)
//        npm run db:init -- --force (DESTRUCTIVE: drops & recreates everything)
//
// schema.sql DROPs every table before recreating it, so this WIPES ALL DATA.
// It is a one-time bootstrap / intentional full reset — never part of a normal
// restart or deploy (use `npm run db:migrate` + `npm start` for those).
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../src/config/env');

const force = process.argv.includes('--force');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');

  // Connect WITHOUT selecting a database (the script creates it), and allow
  // multiple statements for the batch import.
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    multipleStatements: true,
  });

  // --- Safety guard ---------------------------------------------------------
  // Refuse to run destructively in production, or when the target database
  // already exists with a `users` table containing rows, unless --force.
  if (!force) {
    if (env.nodeEnv === 'production') {
      await conn.end();
      throw new Error(
        'Refusing to run db:init in production (it DROPS every table and wipes all data).\n' +
        'For an existing environment run `npm run db:migrate` instead.\n' +
        'If you REALLY intend a full reset, re-run with:  npm run db:init -- --force'
      );
    }

    // Does the database already exist and hold data?
    const [dbRows] = await conn.query(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [env.db.database]
    );
    if (dbRows.length > 0) {
      const [tblRows] = await conn.query(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'",
        [env.db.database]
      );
      if (tblRows.length > 0) {
        const [[{ cnt }]] = await conn.query(
          `SELECT COUNT(*) AS cnt FROM \`${env.db.database}\`.users`
        );
        if (cnt > 0) {
          await conn.end();
          throw new Error(
            `Database "${env.db.database}" already has data (${cnt} user row(s)).\n` +
            'db:init DROPS every table and would DELETE ALL of it.\n' +
            'To restart the server, just run `npm start` — no db:init needed.\n' +
            'To apply schema changes safely, run `npm run db:migrate`.\n' +
            'If you REALLY intend to wipe and reset, re-run with:  npm run db:init -- --force'
          );
        }
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(force
    ? 'Running schema.sql (--force: dropping & recreating all tables) ...'
    : 'Running schema.sql ...');
  await conn.query(sql);
  await conn.end();
  // eslint-disable-next-line no-console
  console.log('Done. Database and seed data are ready.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('initDb failed:', err.message);
  process.exit(1);
});
