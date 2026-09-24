// Creates an admin user.
// Usage: node scripts/createAdmin.js "Admin Name" admin@example.com secret123
const bcrypt = require('bcryptjs');
const { pool, withTransaction } = require('../src/config/db');
const { ensureWallet } = require('../src/services/wallet.service');
const { insertIntoTree } = require('../src/services/genealogy.service');

async function main() {
  const [name, email, password] = process.argv.slice(2);
  if (!name || !email || !password) {
    console.error('Usage: node scripts/createAdmin.js "Name" email password');
    process.exit(1);
  }

  const [dup] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (dup.length) {
    console.error('A user with that email already exists.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  const id = await withTransaction(async (conn) => {
    const [r] = await conn.query(
      "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
      [name, email, hash]
    );
    await ensureWallet(conn, r.insertId);
    await insertIntoTree(conn, r.insertId, null);
    return r.insertId;
  });

  // eslint-disable-next-line no-console
  console.log(`Admin created: id=${id}, email=${email}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
