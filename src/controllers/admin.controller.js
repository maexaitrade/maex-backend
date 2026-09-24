const { pool, withTransaction } = require('../config/db');
const { round2 } = require('../utils/money');
const settings = require('../services/settings.service');
const { applyLedger, ensureWallet } = require('../services/wallet.service');
const { payReferralOnDeposit } = require('../services/referral.service');
const { recomputeRank } = require('../services/rank.service');
const { runDailyRoi } = require('../services/roi.service');
const { badRequest, notFound, conflict } = require('../utils/httpError');

async function audit(conn, actorId, action, detail) {
  await conn.query(
    'INSERT INTO audit_logs (actor_id, action, detail) VALUES (?, ?, ?)',
    [actorId, action, detail ? JSON.stringify(detail) : null]
  );
}

// ---- Deposits --------------------------------------------------------------

// GET /api/admin/deposits?status=pending
async function listDeposits(req, res) {
  const status = req.query.status || 'pending';
  const [rows] = await pool.query(
    `SELECT d.*, u.name, u.email FROM deposits d JOIN users u ON u.id = d.user_id
     WHERE d.status = ? ORDER BY d.id DESC`,
    [status]
  );
  res.json({ items: rows });
}

// PATCH /api/admin/deposits/:id  body: { action: 'confirm' | 'reject' }
async function reviewDeposit(req, res) {
  const depositId = Number(req.params.id);
  const action = req.body?.action;
  if (!['confirm', 'reject'].includes(action)) throw badRequest("action must be 'confirm' or 'reject'");

  const summary = await withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM deposits WHERE id = ? FOR UPDATE', [depositId]);
    const deposit = rows[0];
    if (!deposit) throw notFound('deposit not found');
    if (deposit.status !== 'pending') throw conflict(`deposit already ${deposit.status}`);

    if (action === 'reject') {
      await conn.query("UPDATE deposits SET status = 'rejected' WHERE id = ?", [depositId]);
      await audit(conn, req.user.id, 'deposit.reject', { depositId });
      return { status: 'rejected' };
    }

    // Confirm: credit wallet, pay referral, refresh ranks up the tree.
    await conn.query(
      "UPDATE deposits SET status = 'confirmed', confirmed_at = NOW() WHERE id = ?",
      [depositId]
    );
    await applyLedger(conn, {
      userId: deposit.user_id,
      type: 'deposit',
      direction: 'credit',
      amount: deposit.amount,
      referenceTable: 'deposits',
      referenceId: depositId,
      bucket: 'deposit',
    });
    await payReferralOnDeposit(conn, deposit);

    // Team business changed for every up-line ancestor → recompute their rank.
    const [ancestors] = await conn.query(
      'SELECT ancestor_id FROM genealogy WHERE descendant_id = ? AND depth >= 1',
      [deposit.user_id]
    );
    for (const a of ancestors) await recomputeRank(conn, a.ancestor_id);

    await audit(conn, req.user.id, 'deposit.confirm', { depositId, amount: deposit.amount });
    return { status: 'confirmed', amount: deposit.amount };
  });

  res.json({ id: depositId, ...summary });
}

// ---- Withdrawals -----------------------------------------------------------

// GET /api/admin/withdrawals?status=pending
async function listWithdrawals(req, res) {
  const status = req.query.status || 'pending';
  const [rows] = await pool.query(
    `SELECT w.*, u.name, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id
     WHERE w.status = ? ORDER BY w.id DESC`,
    [status]
  );
  res.json({ items: rows });
}

// PATCH /api/admin/withdrawals/:id  body: { action: 'pay'|'reject', tx_hash? }
async function reviewWithdrawal(req, res) {
  const id = Number(req.params.id);
  const { action, tx_hash } = req.body || {};
  if (!['pay', 'reject'].includes(action)) throw badRequest("action must be 'pay' or 'reject'");

  const result = await withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM withdrawals WHERE id = ? FOR UPDATE', [id]);
    const wd = rows[0];
    if (!wd) throw notFound('withdrawal not found');
    if (wd.status !== 'pending') throw conflict(`withdrawal already ${wd.status}`);

    if (action === 'pay') {
      await conn.query(
        "UPDATE withdrawals SET status = 'paid', tx_hash = ?, processed_at = NOW() WHERE id = ?",
        [tx_hash || null, id]
      );
      await conn.query(
        'UPDATE wallets SET total_withdraw = total_withdraw + ? WHERE user_id = ?',
        [wd.amount, wd.user_id]
      );
      await audit(conn, req.user.id, 'withdrawal.pay', { id, amount: wd.amount });
      return { status: 'paid' };
    }

    // Reject: refund the debited balance.
    await conn.query("UPDATE withdrawals SET status = 'rejected', processed_at = NOW() WHERE id = ?", [id]);
    await applyLedger(conn, {
      userId: wd.user_id,
      type: 'withdrawal',
      direction: 'credit',
      amount: wd.amount,
      referenceTable: 'withdrawals',
      referenceId: id,
    });
    await audit(conn, req.user.id, 'withdrawal.reject', { id, amount: wd.amount });
    return { status: 'rejected' };
  });

  res.json({ id, ...result });
}

// ---- Config: packages / ranks / settings -----------------------------------

async function upsertPackage(req, res) {
  const { id, name, min_amount, max_amount, daily_roi_percent, is_active } = req.body || {};
  if (!name || min_amount == null || daily_roi_percent == null) {
    throw badRequest('name, min_amount and daily_roi_percent are required');
  }
  if (id) {
    await pool.query(
      `UPDATE packages SET name=?, min_amount=?, max_amount=?, daily_roi_percent=?, is_active=?
       WHERE id=?`,
      [name, min_amount, max_amount ?? null, daily_roi_percent, is_active ? 1 : 0, id]
    );
    return res.json({ id, updated: true });
  }
  const [r] = await pool.query(
    `INSERT INTO packages (name, min_amount, max_amount, daily_roi_percent, is_active)
     VALUES (?, ?, ?, ?, ?)`,
    [name, min_amount, max_amount ?? null, daily_roi_percent, is_active === false ? 0 : 1]
  );
  res.status(201).json({ id: r.insertId });
}

async function upsertRank(req, res) {
  const { id, name, business_required, reward_amount, sort_order } = req.body || {};
  if (!name || business_required == null || reward_amount == null || sort_order == null) {
    throw badRequest('name, business_required, reward_amount and sort_order are required');
  }
  if (id) {
    await pool.query(
      'UPDATE ranks SET name=?, business_required=?, reward_amount=?, sort_order=? WHERE id=?',
      [name, business_required, reward_amount, sort_order, id]
    );
    return res.json({ id, updated: true });
  }
  const [r] = await pool.query(
    'INSERT INTO ranks (name, business_required, reward_amount, sort_order) VALUES (?, ?, ?, ?)',
    [name, business_required, reward_amount, sort_order]
  );
  res.status(201).json({ id: r.insertId });
}

async function updateSetting(req, res) {
  const { key, value } = req.body || {};
  if (!key || value == null) throw badRequest('key and value are required');
  await pool.query(
    'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
    [key, String(value)]
  );
  settings.clearCache();
  res.json({ key, value: String(value) });
}

// ---- Users & reports -------------------------------------------------------

async function listUsers(req, res) {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const q = req.query.q ? `%${req.query.q}%` : null;
  const statusFilter = ['active', 'blocked'].includes(req.query.status) ? req.query.status : null;
  const pageSize = 50;

  const conditions = [];
  const countParams = [];
  if (q) { conditions.push('(u.name LIKE ? OR u.email LIKE ?)'); countParams.push(q, q); }
  if (statusFilter) { conditions.push('u.status = ?'); countParams.push(statusFilter); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.phone, u.sponsor_id, u.status, u.wallet_address, u.created_at,
            w.balance, w.total_deposit, w.total_withdraw, w.total_earned, r.name AS rank_name
     FROM users u
     LEFT JOIN wallets w ON w.user_id = u.id
     LEFT JOIN ranks r ON r.id = u.current_rank_id
     ${where}
     ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    [...countParams, pageSize, (page - 1) * pageSize]
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM users u ${where}`,
    countParams
  );
  res.json({ page, total, items: rows });
}

async function getUserDetail(req, res) {
  const userId = Number(req.params.id);
  const [[user]] = await pool.query(
    `SELECT u.id, u.name, u.email, u.phone, u.sponsor_id, u.status, u.wallet_address,
            u.role, u.created_at,
            w.balance, w.total_deposit, w.total_withdraw, w.total_earned,
            r.name AS rank_name, r.id AS rank_id
     FROM users u
     LEFT JOIN wallets w ON w.user_id = u.id
     LEFT JOIN ranks r ON r.id = u.current_rank_id
     WHERE u.id = ?`,
    [userId]
  );
  if (!user) throw notFound('user not found');

  // Sponsor info
  let sponsor = null;
  if (user.sponsor_id) {
    const [[sp]] = await pool.query('SELECT id, name, email FROM users WHERE id = ?', [user.sponsor_id]);
    sponsor = sp || null;
  }

  // Team breakdown per level + total business
  const [teamLevels] = await pool.query(
    `SELECT g.depth,
            COUNT(*) AS members,
            COALESCE(SUM(CASE WHEN d.status = 'confirmed' THEN d.amount END), 0) AS business
     FROM genealogy g
     JOIN users u2 ON u2.id = g.descendant_id
     LEFT JOIN deposits d ON d.user_id = g.descendant_id
     WHERE g.ancestor_id = ? AND g.depth BETWEEN 1 AND 3
     GROUP BY g.depth`,
    [userId]
  );
  const teamByLevel = { 1: { members: 0, business: 0 }, 2: { members: 0, business: 0 }, 3: { members: 0, business: 0 } };
  for (const r of teamLevels) teamByLevel[r.depth] = { members: Number(r.members), business: Number(r.business) };

  // Next rank threshold
  const [[nextRank]] = await pool.query(
    `SELECT name, business_required FROM ranks
     WHERE sort_order > COALESCE((SELECT sort_order FROM ranks WHERE id = ?), 0)
     ORDER BY sort_order ASC LIMIT 1`,
    [user.rank_id || 0]
  );

  // Total team business (direct confirmed deposits across all 3 levels)
  const totalBusiness = teamByLevel[1].business + teamByLevel[2].business + teamByLevel[3].business;

  const [investments] = await pool.query(
    `SELECT i.id, i.amount, i.daily_roi_rate, i.cap_amount, i.total_earned, i.status, i.purchased_at,
            p.name AS package_name
     FROM investments i JOIN packages p ON p.id = i.package_id
     WHERE i.user_id = ? ORDER BY i.id DESC`,
    [userId]
  );
  const [deposits] = await pool.query(
    'SELECT id, amount, status, tx_hash, from_address, created_at, confirmed_at FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 15',
    [userId]
  );
  const [withdrawals] = await pool.query(
    'SELECT id, amount, charge, net_amount, status, wallet_address, tx_hash, requested_at, processed_at FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 15',
    [userId]
  );
  const [txns] = await pool.query(
    'SELECT id, type, direction, amount, balance_after, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 25',
    [userId]
  );
  const [referralEarnings] = await pool.query(
    `SELECT re.level, re.amount, re.source_amount, re.percent, re.created_at, u2.name AS from_name
     FROM referral_earnings re JOIN users u2 ON u2.id = re.from_user_id
     WHERE re.user_id = ? ORDER BY re.id DESC LIMIT 15`,
    [userId]
  );

  res.json({
    user, sponsor, investments, deposits, withdrawals,
    transactions: txns, referral_earnings: referralEarnings,
    team: teamByLevel, total_business: totalBusiness,
    next_rank: nextRank || null,
  });
}

async function updateUser(req, res) {
  const userId = Number(req.params.id);
  const { status, name, email, phone, wallet_address } = req.body || {};

  // Pure status toggle
  if (status !== undefined && !name && !email && !phone && !wallet_address) {
    if (!['active', 'blocked'].includes(status)) throw badRequest("status must be 'active' or 'blocked'");
    const [r] = await pool.query('UPDATE users SET status = ? WHERE id = ?', [status, userId]);
    if (!r.affectedRows) throw notFound('user not found');
    await withTransaction(async (conn) => { await audit(conn, req.user.id, 'user.status', { userId, status }); });
    return res.json({ id: userId, status });
  }

  // Profile update
  const fields = [];
  const vals = [];
  if (name) { fields.push('name = ?'); vals.push(name.trim()); }
  if (email) { fields.push('email = ?'); vals.push(email.trim().toLowerCase()); }
  if (phone !== undefined) { fields.push('phone = ?'); vals.push(phone || null); }
  if (wallet_address !== undefined) { fields.push('wallet_address = ?'); vals.push(wallet_address || null); }
  if (status) {
    if (!['active', 'blocked'].includes(status)) throw badRequest("status must be 'active' or 'blocked'");
    fields.push('status = ?'); vals.push(status);
  }
  if (!fields.length) throw badRequest('nothing to update');
  vals.push(userId);
  const [r] = await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, vals);
  if (!r.affectedRows) throw notFound('user not found');
  await withTransaction(async (conn) => { await audit(conn, req.user.id, 'user.profile_edit', { userId, fields: Object.keys({ name, email, phone, wallet_address, status }).filter((k) => req.body[k] !== undefined) }); });
  res.json({ id: userId, updated: true });
}

async function resetPassword(req, res) {
  const userId = Number(req.params.id);
  const { new_password } = req.body || {};
  if (!new_password || new_password.length < 6) throw badRequest('new_password must be at least 6 characters');
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(new_password, 10);
  const [r] = await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
  if (!r.affectedRows) throw notFound('user not found');
  await withTransaction(async (conn) => { await audit(conn, req.user.id, 'user.password_reset', { userId }); });
  res.json({ id: userId, reset: true });
}

async function adjustWallet(req, res) {
  const userId = Number(req.params.id);
  const { amount, direction, note } = req.body || {};
  const amt = Number(amount);
  if (!amt || amt <= 0) throw badRequest('amount must be positive');
  if (!['credit', 'debit'].includes(direction)) throw badRequest("direction must be 'credit' or 'debit'");

  const result = await withTransaction(async (conn) => {
    await ensureWallet(conn, userId);
    const [[w]] = await conn.query('SELECT balance FROM wallets WHERE user_id = ? FOR UPDATE', [userId]);
    if (!w) throw notFound('user not found');
    if (direction === 'debit' && Number(w.balance) < amt) throw badRequest('insufficient balance');

    await applyLedger(conn, {
      userId,
      type: 'adjustment',
      direction,
      amount: amt,
      referenceTable: 'audit_logs',
      referenceId: null,
      bucket: direction === 'credit' ? 'earned' : null,
    });
    await audit(conn, req.user.id, `wallet.adjust.${direction}`, { userId, amount: amt, note });
    const [[updated]] = await conn.query('SELECT balance FROM wallets WHERE user_id = ?', [userId]);
    return { balance: updated.balance };
  });
  res.json({ id: userId, direction, amount: amt, ...result });
}

// ---- Config: list endpoints ------------------------------------------------

async function listPackages(_req, res) {
  const [rows] = await pool.query('SELECT * FROM packages ORDER BY min_amount ASC');
  res.json({ items: rows });
}

async function listRanks(_req, res) {
  const [rows] = await pool.query('SELECT * FROM ranks ORDER BY sort_order ASC');
  res.json({ items: rows });
}

async function listSettings(_req, res) {
  const [rows] = await pool.query('SELECT `key`, `value` FROM settings ORDER BY `key` ASC');
  res.json({ items: rows });
}

// ---- Audit log -------------------------------------------------------------

async function listAudit(req, res) {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = 50;
  const offset = (page - 1) * pageSize;
  const [rows] = await pool.query(
    `SELECT a.id, a.action, a.detail, a.created_at, u.name AS actor_name, u.email AS actor_email
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [pageSize, offset]
  );
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM audit_logs');
  res.json({ page, total, items: rows });
}

// ---- Manual ROI run --------------------------------------------------------

async function runRoi(req, res) {
  const { date } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('date must be YYYY-MM-DD');
  const result = await runDailyRoi(date);
  await withTransaction(async (conn) => {
    await audit(conn, req.user.id, 'roi.manual_run', { date, ...result });
  });
  res.json(result);
}

async function reports(_req, res) {
  const [[users]] = await pool.query('SELECT COUNT(*) AS n FROM users');
  const [[pendingDeps]] = await pool.query("SELECT COUNT(*) AS n FROM deposits WHERE status='pending'");
  const [[pendingWds]] = await pool.query("SELECT COUNT(*) AS n FROM withdrawals WHERE status='pending'");
  const [[deposits]] = await pool.query(
    "SELECT COALESCE(SUM(amount),0) AS total FROM deposits WHERE status='confirmed'"
  );
  const [[withdrawn]] = await pool.query(
    "SELECT COALESCE(SUM(net_amount),0) AS total FROM withdrawals WHERE status='paid'"
  );
  const [payouts] = await pool.query(
    `SELECT type, COALESCE(SUM(amount),0) AS total FROM transactions
     WHERE direction='credit' AND type IN ('roi','referral','booster','reward')
     GROUP BY type`
  );
  const [recentAudit] = await pool.query(
    `SELECT a.id, a.action, a.created_at, u.name AS actor_name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.id DESC LIMIT 8`
  );
  res.json({
    users: users.n,
    pending_deposits: pendingDeps.n,
    pending_withdrawals: pendingWds.n,
    confirmed_deposits: round2(Number(deposits.total)),
    paid_withdrawals: round2(Number(withdrawn.total)),
    payouts: payouts.reduce((acc, p) => ({ ...acc, [p.type]: round2(Number(p.total)) }), {}),
    recent_audit: recentAudit,
  });
}

module.exports = {
  listDeposits, reviewDeposit,
  listWithdrawals, reviewWithdrawal,
  upsertPackage, upsertRank, updateSetting,
  listPackages, listRanks, listSettings,
  listUsers, getUserDetail, updateUser, resetPassword, adjustWallet,
  listAudit, runRoi,
  reports,
};
