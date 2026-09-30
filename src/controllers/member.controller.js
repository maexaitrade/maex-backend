const { pool } = require('../config/db');
const { getTeamBusiness } = require('../services/rank.service');
const { ensureWallet } = require('../services/wallet.service');
const { round2 } = require('../utils/money');
const { badRequest } = require('../utils/httpError');
const settings = require('../services/settings.service');
const { activeNetwork, isValidAddress, publicNetwork } = require('../utils/cryptoNetwork');

// GET /api/settings — public-facing platform values the member UI needs
// (minimums, fees, network). Admin edits these in the settings table.
async function publicSettings(_req, res) {
  const s = await settings.getSettings();
  const network = publicNetwork(s);
  res.json({
    min_deposit: Number(s.min_deposit ?? 100),
    min_withdraw: Number(s.min_withdraw ?? 50),
    withdraw_charge: Number(s.withdraw_charge ?? 6),
    active_crypto_network: network.code,
    active_crypto_network_label: network.label,
    deposit_network: network.code,
    deposit_network_label: network.label,
    deposit_via: s.deposit_via || 'admin',
    admin_deposit_address: network.address,
    deposit_address_placeholder: network.address_placeholder,
    explorer_tx_base: network.explorer_tx_base,
    explorer_address_base: network.explorer_address_base,
  });
}

// GET /api/me/dashboard
async function dashboard(req, res) {
  const userId = req.user.id;
  const s = await settings.getSettings();
  const network = publicNetwork(s);

  const conn = await pool.getConnection();
  try {
    await ensureWallet(conn, userId);
    const [[wallet]] = await conn.query('SELECT * FROM wallets WHERE user_id = ?', [userId]);
    const [[{ wallet_address }]] = await conn.query('SELECT wallet_address FROM users WHERE id = ?', [userId]);

    const [investments] = await conn.query(
      `SELECT i.id, i.amount, i.daily_roi_rate, i.cap_amount, i.total_earned, i.status,
              i.purchased_at, p.name AS package_name
       FROM investments i JOIN packages p ON p.id = i.package_id
       WHERE i.user_id = ? ORDER BY i.purchased_at DESC`,
      [userId]
    );
    const withProgress = investments.map((i) => ({
      ...i,
      cap_progress_pct: round2((Number(i.total_earned) / Number(i.cap_amount)) * 100),
      remaining_to_cap: round2(Number(i.cap_amount) - Number(i.total_earned)),
    }));

    // Income breakdown from the ledger.
    const [breakdown] = await conn.query(
      `SELECT type, COALESCE(SUM(amount), 0) AS total
       FROM transactions WHERE user_id = ? AND direction = 'credit'
       GROUP BY type`,
      [userId]
    );
    const income = { roi: 0, referral: 0, booster: 0, reward: 0, deposit: 0 };
    for (const b of breakdown) if (b.type in income) income[b.type] = Number(b.total);

    const [[rank]] = await conn.query(
      `SELECT r.name, r.reward_amount FROM users u
       LEFT JOIN ranks r ON r.id = u.current_rank_id WHERE u.id = ?`,
      [userId]
    );
    const teamBusiness = await getTeamBusiness(conn, userId);

    res.json({
      wallet,
      wallet_address: wallet_address || null,
      wallet_address_valid: Boolean(wallet_address && isValidAddress(wallet_address, network.code)),
      active_crypto_network: network.code,
      active_crypto_network_label: network.label,
      investments: withProgress,
      income,
      rank: rank && rank.name ? rank.name : null,
      team_business: teamBusiness,
    });
  } finally {
    conn.release();
  }
}

// GET /api/me/team
async function team(req, res) {
  const userId = req.user.id;
  const [levels] = await pool.query(
    `SELECT g.depth, u.id, u.name, u.email, u.created_at,
            COALESCE(SUM(CASE WHEN d.status = 'confirmed' THEN d.amount END), 0) AS total_deposit
     FROM genealogy g
     JOIN users u ON u.id = g.descendant_id
     LEFT JOIN deposits d ON d.user_id = u.id
     WHERE g.ancestor_id = ? AND g.depth BETWEEN 1 AND 3
     GROUP BY g.depth, u.id
     ORDER BY g.depth, u.id`,
    [userId]
  );

  const grouped = { 1: [], 2: [], 3: [] };
  for (const row of levels) grouped[row.depth].push(row);

  const conn = await pool.getConnection();
  let teamBusiness;
  try {
    teamBusiness = await getTeamBusiness(conn, userId);
  } finally {
    conn.release();
  }

  res.json({
    counts: { level1: grouped[1].length, level2: grouped[2].length, level3: grouped[3].length },
    levels: grouped,
    team_business: teamBusiness,
  });
}

// GET /api/me/income?type=roi&page=1
async function income(req, res) {
  const userId = req.user.id;
  const { type } = req.query;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = 25;
  const offset = (page - 1) * pageSize;

  const where = ['user_id = ?'];
  const params = [userId];
  if (type) { where.push('type = ?'); params.push(type); }

  const [rows] = await pool.query(
    `SELECT id, type, direction, amount, balance_after, reference_table, reference_id, created_at
     FROM transactions WHERE ${where.join(' AND ')}
     ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  res.json({ page, page_size: pageSize, items: rows });
}

// PATCH /api/me/profile  body: { wallet_address }
async function updateProfile(req, res) {
  const userId = req.user.id;
  const { wallet_address } = req.body || {};
  if (!wallet_address) throw badRequest('wallet_address is required');
  const s = await settings.getSettings();
  const network = activeNetwork(s);
  const value = String(wallet_address).trim();
  if (!isValidAddress(value, network)) {
    throw badRequest(`invalid ${publicNetwork(s).label} wallet address`);
  }
  await pool.query('UPDATE users SET wallet_address = ? WHERE id = ?', [value, userId]);
  res.json({ ok: true, wallet_address: value, network });
}

// DELETE /api/me/profile/wallet
async function deleteWallet(req, res) {
  const userId = req.user.id;
  await pool.query('UPDATE users SET wallet_address = NULL WHERE id = ?', [userId]);
  res.json({ ok: true });
}

module.exports = { dashboard, team, income, updateProfile, deleteWallet, publicSettings };
