const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const app = require('../src/app');
const env = require('../src/config/env');
const { pool, withTransaction } = require('../src/config/db');
const { ensureWallet } = require('../src/services/wallet.service');
const { insertIntoTree } = require('../src/services/genealogy.service');
const settings = require('../src/services/settings.service');

const api = request(app);

// Rebuilds the isolated test database from schema.sql (tables dropped/recreated;
// the database itself is kept so the app's connection pool stays valid).
async function resetDb() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  const sql = raw.split('maex_trade').join(env.db.database); // point schema at the test DB
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    multipleStatements: true,
  });
  await conn.query(sql);
  await conn.end();
  settings.clearCache();
}

// Inserts an admin directly and returns a logged-in token.
async function createAdmin(email = 'admin@test.local', password = 'admin123') {
  const hash = await bcrypt.hash(password, 8);
  const id = await withTransaction(async (conn) => {
    const [r] = await conn.query(
      "INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', ?, ?, 'admin')",
      [email, hash]
    );
    await ensureWallet(conn, r.insertId);
    await insertIntoTree(conn, r.insertId, null);
    return r.insertId;
  });
  const res = await api.post('/api/auth/login').send({ email, password });
  return { id, token: res.body.token };
}

// Registers a member (optionally under a sponsor) and returns { id, token }.
async function register(name, email, sponsorId) {
  const url = sponsorId ? `/api/auth/register?ref=${sponsorId}` : '/api/auth/register';
  const res = await api.post(url).send({ name, email, password: 'secret1' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id, token: res.body.token };
}

// Convenience: submit a deposit and have the admin confirm it.
async function fund(token, amount, adminToken) {
  const dep = await api.post('/api/deposits').set('authorization', `Bearer ${token}`).send({ amount });
  const confirm = await api
    .patch(`/api/admin/deposits/${dep.body.id}`)
    .set('authorization', `Bearer ${adminToken}`)
    .send({ action: 'confirm' });
  return { depositId: dep.body.id, confirm };
}

async function buy(token, amount) {
  return api.post('/api/packages/buy').set('authorization', `Bearer ${token}`).send({ amount });
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });

async function closePool() {
  await pool.end();
}

module.exports = { api, pool, resetDb, createAdmin, register, fund, buy, bearer, closePool };
