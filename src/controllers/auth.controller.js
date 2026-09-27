const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { pool, withTransaction } = require('../config/db');
const { ensureWallet } = require('../services/wallet.service');
const { insertIntoTree } = require('../services/genealogy.service');
const mailer = require('../services/email.service');
const { badRequest, unauthorized, notFound, forbidden } = require('../utils/httpError');

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
  });
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function randomOtp() {
  return String(crypto.randomInt(100000, 1000000)); // 6-digit
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
  const otp = randomOtp();

  // Stage the registration — the real user row is NOT created until the OTP is
  // verified. Re-registering the same email overwrites the pending row + OTP.
  await pool.query(
    `INSERT INTO pending_registrations (email, name, phone, password_hash, sponsor_id, otp, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))
     ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone), password_hash=VALUES(password_hash),
       sponsor_id=VALUES(sponsor_id), otp=VALUES(otp), expires_at=VALUES(expires_at)`,
    [email, name, phone || null, passwordHash, sponsor ? sponsor.id : null, otp]
  );

  await mailer.sendOtp({ to: String(email).trim(), name, email, password: String(password), otp });

  res.status(200).json({
    otpRequired: true,
    email,
    message: 'Verification code sent to your email. Enter it to activate your account.',
  });
}

// POST /api/auth/verify-otp  body: { email, otp }
// Confirms the OTP, creates the real account, and logs the user in.
async function verifyOtp(req, res) {
  const { email, otp } = req.body || {};
  if (!email || !otp) throw badRequest('email and otp are required');

  const [rows] = await pool.query('SELECT * FROM pending_registrations WHERE email = ?', [email]);
  const pending = rows[0];
  if (!pending) throw badRequest('no pending signup for this email — please register again');
  if (new Date(pending.expires_at) < new Date()) throw badRequest('code expired — please register again');
  if (String(pending.otp) !== String(otp).trim()) throw badRequest('incorrect verification code');

  // Guard against a race where the email got registered meanwhile.
  const [dup] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (dup.length) throw badRequest('email already registered');

  const user = await withTransaction(async (conn) => {
    const [result] = await conn.query(
      `INSERT INTO users (sponsor_id, name, email, phone, password_hash, email_verified)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [pending.sponsor_id || null, pending.name, pending.email, pending.phone || null, pending.password_hash]
    );
    const id = result.insertId;
    await ensureWallet(conn, id);
    await insertIntoTree(conn, id, pending.sponsor_id || null);
    await conn.query('DELETE FROM pending_registrations WHERE id = ?', [pending.id]);
    return { id, name: pending.name, email: pending.email, role: 'member' };
  });

  res.status(201).json({
    ok: true,
    token: signToken(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
}

// POST /api/auth/resend-otp  body: { email }
async function resendOtp(req, res) {
  const { email } = req.body || {};
  if (!email) throw badRequest('email is required');

  const [rows] = await pool.query('SELECT * FROM pending_registrations WHERE email = ?', [email]);
  const pending = rows[0];
  if (pending) {
    const otp = randomOtp();
    await pool.query(
      'UPDATE pending_registrations SET otp = ?, expires_at = DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE id = ?',
      [otp, pending.id]
    );
    await mailer.sendOtp({ to: String(email).trim(), name: pending.name, email, password: '(unchanged)', otp });
  }
  res.json({ ok: true, message: 'If a signup is pending for that email, a new code has been sent.' });
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

  // Members must verify their email before signing in (admins are pre-verified).
  if (user.role !== 'admin' && !user.email_verified) {
    throw forbidden('Please verify your email first — check your inbox for the verification link.');
  }

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
      "INSERT INTO users (name, email, password_hash, role, email_verified) VALUES (?, ?, ?, 'admin', 1)",
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

// POST /api/auth/forgot-password  body: { email }
// Always responds success (never reveals whether an email is registered).
async function forgotPassword(req, res) {
  const { email } = req.body || {};
  if (!email) throw badRequest('email is required');

  const [rows] = await pool.query('SELECT id, name, email FROM users WHERE email = ?', [email]);
  const user = rows[0];

  if (user) {
    const token = randomToken();
    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))',
      [user.id, token]
    );
    const resetUrl = `${env.webUrl}/reset-password?token=${token}`;
    await mailer.sendReset({ to: user.email, name: user.name, resetUrl });
  }

  res.json({ ok: true, message: 'If that email is registered, a reset link has been sent.' });
}

// POST /api/auth/reset-password  body: { token, password }
async function resetPassword(req, res) {
  const { token, password } = req.body || {};
  if (!token || !password) throw badRequest('token and password are required');
  if (String(password).length < 6) throw badRequest('password must be at least 6 characters');

  const [rows] = await pool.query(
    'SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > NOW()',
    [token]
  );
  const row = rows[0];
  if (!row) throw badRequest('reset link is invalid or has expired');

  const passwordHash = await bcrypt.hash(String(password), 10);
  await withTransaction(async (conn) => {
    await conn.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, row.user_id]);
    await conn.query('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [row.id]);
  });

  res.json({ ok: true, message: 'Password updated. You can now sign in.' });
}

module.exports = { register, login, createAdmin, verifyOtp, resendOtp, forgotPassword, resetPassword };
