const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { pool, withTransaction } = require('../config/db');
const { ensureWallet } = require('../services/wallet.service');
const { insertIntoTree } = require('../services/genealogy.service');
const { badRequest, unauthorized, notFound, forbidden } = require('../utils/httpError');

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
  });
}

// POST /api/auth/register  body: { name, email, password, phone?, sponsorId? }
async function register(req, res) {
  const { name, email, password, phone } = req.body || {};
  const rawRef = req.body.sponsorId || req.query.ref || null;
  const sponsorId = rawRef ? String(rawRef).replace(/^MAEX/i, '') || null : null;

  if (!name || !email || !password) throw badRequest('name, email and password are required');
  if (String(password).length < 6) throw badRequest('password must be at least 6 characters');

  const [dup] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (dup.length) throw badRequest('email already registered');

  let sponsor = null;
  if (sponsorId) {
    const [rows] = await pool.query('SELECT id FROM users WHERE id = ?', [sponsorId]);
    if (!rows.length) throw notFound('sponsor not found');
    sponsor = rows[0];
  }

  const passwordHash = await bcrypt.hash(String(password), 10);

  const user = await withTransaction(async (conn) => {
    const [result] = await conn.query(
      `INSERT INTO users (sponsor_id, name, email, phone, password_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [sponsor ? sponsor.id : null, name, email, phone || null, passwordHash]
    );
    const id = result.insertId;
    await ensureWallet(conn, id);
    await insertIntoTree(conn, id, sponsor ? sponsor.id : null);
    return { id, role: 'member' };
  });

  res.status(201).json({
    token: signToken(user),
    user: { id: user.id, name, email, role: 'member' },
  });
}

// POST /api/auth/login  body: { email, password }
async function login(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) throw badRequest('email and password are required');

  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  const user = rows[0];
  if (!user) throw unauthorized('invalid credentials');
  if (user.status === 'blocked') throw unauthorized('account blocked');

  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) throw unauthorized('invalid credentials');

  res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
}

// POST /api/auth/create-admin  body: { setup_key, name, email, password }
// Protected by ADMIN_SETUP_KEY in .env. Disabled if the key is not configured.
async function createAdmin(req, res) {
  const { setup_key: setupKey, name, email, password } = req.body || {};

  if (!env.adminSetupKey) {
    throw forbidden('admin setup is disabled (ADMIN_SETUP_KEY not configured)');
  }
  if (!setupKey || String(setupKey) !== env.adminSetupKey) {
    throw forbidden('invalid setup key');
  }
  if (!name || !email || !password) throw badRequest('name, email and password are required');
  if (String(password).length < 6) throw badRequest('password must be at least 6 characters');

  const [dup] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (dup.length) throw badRequest('email already registered');

  const passwordHash = await bcrypt.hash(String(password), 10);

  const user = await withTransaction(async (conn) => {
    const [result] = await conn.query(
      "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
      [name, email, passwordHash]
    );
    const id = result.insertId;
    await ensureWallet(conn, id);
    await insertIntoTree(conn, id, null);
    return { id, role: 'admin' };
  });

  res.status(201).json({
    ok: true,
    user: { id: user.id, name, email, role: 'admin' },
  });
}

module.exports = { register, login, createAdmin };
