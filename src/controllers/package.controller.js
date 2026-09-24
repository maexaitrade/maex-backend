const { pool, withTransaction } = require('../config/db');
const { round2 } = require('../utils/money');
const settings = require('../services/settings.service');
const { applyLedger, lockWallet } = require('../services/wallet.service');
const { checkBooster } = require('../services/booster.service');
const { badRequest, notFound } = require('../utils/httpError');

// GET /api/packages
async function list(_req, res) {
  const [rows] = await pool.query(
    'SELECT id, name, min_amount, max_amount, daily_roi_percent FROM packages WHERE is_active = 1 ORDER BY min_amount'
  );
  res.json({ items: rows });
}

// Picks the package whose range contains the amount.
function matchPackage(packages, amount) {
  return packages.find(
    (p) => amount >= Number(p.min_amount) && (p.max_amount == null || amount <= Number(p.max_amount))
  );
}

// POST /api/packages/buy  body: { amount }
// If the user has an active investment, tops it up (adds to existing amount,
// recalculates cap, auto-upgrades tier if total crosses a threshold).
// If no active investment, creates a new one. ROI applies from the next day.
async function buy(req, res) {
  const userId = req.user.id;
  const topUpAmount = round2(Number(req.body?.amount));
  if (!topUpAmount || topUpAmount <= 0) throw badRequest('amount must be a positive number');

  const s = await settings.getSettings();
  const capMultiplier = Number(s.cap_multiplier);
  const [packages] = await pool.query('SELECT * FROM packages WHERE is_active = 1 ORDER BY min_amount');

  const result = await withTransaction(async (conn) => {
    const wallet = await lockWallet(conn, userId);
    if (Number(wallet.balance) < topUpAmount) {
      throw badRequest('insufficient wallet balance — confirm a deposit first');
    }

    // Check for an existing active investment to top up.
    const [activeRows] = await conn.query(
      "SELECT * FROM investments WHERE user_id = ? AND status = 'active' ORDER BY purchased_at DESC LIMIT 1 FOR UPDATE",
      [userId]
    );
    const existing = activeRows[0] || null;

    if (existing) {
      // Top-up: accumulate into the existing investment.
      const newAmount = round2(Number(existing.amount) + topUpAmount);
      const newCap = round2(newAmount * capMultiplier);

      // Auto-upgrade tier if the new total crosses a package threshold.
      const newPkg = matchPackage(packages, newAmount)
        || packages.find((p) => p.id === existing.package_id);
      const tierChanged = newPkg.id !== existing.package_id;

      await conn.query(
        `UPDATE investments SET amount = ?, cap_amount = ?, package_id = ?, daily_roi_rate = ? WHERE id = ?`,
        [newAmount, newCap, newPkg.id, newPkg.daily_roi_percent, existing.id]
      );
      await applyLedger(conn, {
        userId, type: 'purchase', direction: 'debit', amount: topUpAmount,
        referenceTable: 'investments', referenceId: existing.id,
      });

      const [[user]] = await conn.query('SELECT sponsor_id FROM users WHERE id = ?', [userId]);
      if (user?.sponsor_id) await checkBooster(conn, user.sponsor_id);

      return { investmentId: existing.id, topUp: true, tierChanged, package: newPkg.name, amount: newAmount, cap_amount: newCap, daily_roi_rate: Number(newPkg.daily_roi_percent) };
    }

    // No active investment — create a new one.
    const pkg = matchPackage(packages, topUpAmount);
    if (!pkg) throw badRequest('amount does not match any package range (min $' + packages[0]?.min_amount + ')');

    const [ins] = await conn.query(
      `INSERT INTO investments (user_id, package_id, amount, daily_roi_rate, cap_amount, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [userId, pkg.id, topUpAmount, pkg.daily_roi_percent, round2(topUpAmount * capMultiplier)]
    );
    await applyLedger(conn, {
      userId, type: 'purchase', direction: 'debit', amount: topUpAmount,
      referenceTable: 'investments', referenceId: ins.insertId,
    });

    const [[user]] = await conn.query('SELECT sponsor_id FROM users WHERE id = ?', [userId]);
    if (user?.sponsor_id) await checkBooster(conn, user.sponsor_id);

    return { investmentId: ins.insertId, topUp: false, tierChanged: false, package: pkg.name, amount: topUpAmount, cap_amount: round2(topUpAmount * capMultiplier), daily_roi_rate: Number(pkg.daily_roi_percent) };
  });

  res.status(201).json(result);
}

module.exports = { list, buy };
