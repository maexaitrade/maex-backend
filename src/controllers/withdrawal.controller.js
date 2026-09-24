const { pool, withTransaction } = require('../config/db');
const { round2, percentOf } = require('../utils/money');
const settings = require('../services/settings.service');
const { applyLedger, lockWallet } = require('../services/wallet.service');
const { badRequest } = require('../utils/httpError');

// POST /api/withdrawals  body: { amount }
// Applies min-withdraw and 6% charge, debits the wallet, creates a pending
// withdrawal for admin to pay out.
async function request(req, res) {
  const userId = req.user.id;
  const amount = round2(Number(req.body?.amount));

  const s = await settings.getSettings();
  const min = Number(s.min_withdraw);
  const chargePct = Number(s.withdraw_charge);

  if (!amount || amount <= 0) throw badRequest('amount must be a positive number');
  if (amount < min) throw badRequest(`minimum withdrawal is ${min}`);

  const [[user]] = await pool.query('SELECT wallet_address FROM users WHERE id = ?', [userId]);
  if (!user || !user.wallet_address) throw badRequest('set your TRC-20 wallet address first');

  const charge = percentOf(amount, chargePct);
  const net = round2(amount - charge);

  const result = await withTransaction(async (conn) => {
    const wallet = await lockWallet(conn, userId);
    if (Number(wallet.balance) < amount) throw badRequest('insufficient balance');

    const [ins] = await conn.query(
      `INSERT INTO withdrawals (user_id, amount, charge, net_amount, wallet_address, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [userId, amount, charge, net, user.wallet_address]
    );
    const withdrawalId = ins.insertId;

    // Debit the balance now; total_withdraw is bumped only when admin pays,
    // so a rejected request simply credits the balance back.
    await applyLedger(conn, {
      userId,
      type: 'withdrawal',
      direction: 'debit',
      amount,
      referenceTable: 'withdrawals',
      referenceId: withdrawalId,
    });

    return { withdrawalId };
  });

  res.status(201).json({
    id: result.withdrawalId,
    amount,
    charge,
    net_amount: net,
    status: 'pending',
  });
}

// GET /api/withdrawals — the caller's own withdrawals
async function listMine(req, res) {
  const [rows] = await pool.query(
    'SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC',
    [req.user.id]
  );
  res.json({ items: rows });
}

module.exports = { request, listMine };
