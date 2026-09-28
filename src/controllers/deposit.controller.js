const { pool } = require('../config/db');
const env = require('../config/env');
const { isTronAddress } = require('../utils/tron');
const { badRequest } = require('../utils/httpError');
const { createPayment } = require('../services/nowpayments.service');
const settings = require('../services/settings.service');

// Minimum deposit amount from settings (admin-editable), default 100.
async function getMinDeposit() {
  const s = await settings.getSettings();
  return Number(s.min_deposit ?? 100);
}

// Flip any still-pending NOWPayments deposits whose validity window has passed
// to 'expired'. NOWPayments keeps unpaid payments in "waiting" forever, so we
// enforce the deadline ourselves. Scoped to one user when userId is given.
async function expireStale(userId) {
  const params = [];
  let sql =
    "UPDATE deposits SET status = 'expired' " +
    "WHERE status = 'pending' AND pay_valid_until IS NOT NULL AND pay_valid_until < NOW()";
  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
  const [res] = await pool.query(sql, params);
  return res.affectedRows;
}

// POST /api/deposits  body: { amount, tx_hash?, from_address? }
// Records a pending deposit. Admin confirms it later (which credits the wallet
// and triggers referral + rank payouts).
async function create(req, res) {
  const userId = req.user.id;
  const { amount, tx_hash, from_address } = req.body || {};
  const amt = Number(amount);
  if (!amt || amt <= 0) throw badRequest('amount must be a positive number');
  const minDeposit = await getMinDeposit();
  if (amt < minDeposit) throw badRequest(`minimum deposit is ${minDeposit}`);
  if (from_address && !isTronAddress(from_address)) throw badRequest('from_address must be a valid TRC-20 (TRON) address');

  if (tx_hash) {
    const [dup] = await pool.query(
      "SELECT id FROM deposits WHERE tx_hash = ? AND status != 'rejected'",
      [tx_hash]
    );
    if (dup.length) throw badRequest('This transaction hash has already been submitted');
  }

  const [result] = await pool.query(
    `INSERT INTO deposits (user_id, amount, tx_hash, from_address, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [userId, amt, tx_hash || null, from_address || null]
  );
  res.status(201).json({ id: result.insertId, status: 'pending', amount: amt });
}

// GET /api/deposits/address — returns the admin deposit address for direct deposits
async function getDepositAddress(_req, res) {
  const s = await settings.getSettings();
  const address = s.admin_deposit_address || '';
  if (!address) throw badRequest('deposit address not configured — contact admin');
  res.json({ address, network: s.deposit_network || 'TRC-20' });
}

// POST /api/deposits/nowpayments  — create a NOWPayments USDT deposit
async function initNowPayments(req, res) {
  if (env.deposit.via !== 'gateway') throw badRequest('Gateway deposits are disabled');
  const userId = req.user.id;
  const { amount } = req.body || {};
  const amt = Number(amount);
  if (!amt || amt <= 0) throw badRequest('amount must be a positive number');
  const minDeposit = await getMinDeposit();
  if (amt < minDeposit) throw badRequest(`minimum deposit is ${minDeposit}`);
  if (!process.env.NOWPAYMENTS_API_KEY) throw badRequest('payment gateway not configured');

  // Insert pending deposit first to get an ID we use as order_id
  const [result] = await pool.query(
    "INSERT INTO deposits (user_id, amount, status) VALUES (?, ?, 'pending')",
    [userId, amt]
  );
  const depositId = result.insertId;

  const callbackUrl = `${process.env.APP_URL}/api/webhooks/nowpayments`;

  let payment;
  try {
    payment = await createPayment({ amount: amt, orderId: depositId, callbackUrl });
  } catch (err) {
    // Clean up the pending deposit if NOWPayments failed
    await pool.query('DELETE FROM deposits WHERE id = ?', [depositId]);
    throw err;
  }

  await pool.query(
    `UPDATE deposits
       SET tx_hash = ?, pay_address = ?, pay_amount_crypto = ?,
           pay_valid_until = DATE_ADD(NOW(), INTERVAL ? HOUR)
     WHERE id = ?`,
    [String(payment.payment_id), payment.pay_address, payment.pay_amount, env.deposit.validHours, depositId]
  );

  const [[row]] = await pool.query('SELECT pay_valid_until FROM deposits WHERE id = ?', [depositId]);

  res.status(201).json({
    deposit_id: depositId,
    payment_id: payment.payment_id,
    pay_address: payment.pay_address,
    pay_amount: payment.pay_amount,
    pay_currency: payment.pay_currency,
    status: payment.payment_status,
    valid_until: row ? row.pay_valid_until : null,
    valid_hours: env.deposit.validHours,
  });
}

// GET /api/deposits  — the caller's own deposits
async function listMine(req, res) {
  // Mark any of this user's deposits that ran past their validity window first,
  // so the list reflects the true status even if the IPN never arrived.
  await expireStale(req.user.id);
  const [rows] = await pool.query(
    'SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC',
    [req.user.id]
  );
  res.json({ items: rows });
}

module.exports = { create, initNowPayments, listMine, expireStale, getDepositAddress };
