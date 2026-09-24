// Runs pending SQL migrations from sql/migrations/ in order.
// Usage: npm run db:migrate
// Tracks applied migrations in a `migrations` table.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../src/config/env');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'sql', 'migrations');

async function main() {
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    multipleStatements: true,
  });

  // Ensure tracking table exists
  await conn.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name       VARCHAR(255) NOT NULL UNIQUE,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
  `);

  // Get already-applied migrations
  const [applied] = await conn.query('SELECT name FROM migrations');
  const appliedSet = new Set(applied.map((r) => r.name));

  // Read and sort migration files
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`  apply ${file} ...`);
    await conn.query(sql);
    await conn.query('INSERT INTO migrations (name) VALUES (?)', [file]);
    console.log(`  done  ${file}`);
    ran++;
  }

  if (ran === 0) console.log('Nothing to migrate.');
  else console.log(`\n${ran} migration(s) applied.`);

  await conn.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
