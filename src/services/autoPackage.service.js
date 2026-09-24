// Auto-activates a package for a user when a deposit is confirmed,
// if their deposit amount matches a package range and they have no active investment.
const { round2 } = require('../utils/money');
const settings = require('./settings.service');
const { checkBooster } = require('./booster.service');

function matchPackage(packages, amount) {
  return packages.find(
    (p) => amount >= Number(p.min_amount) && (p.max_amount == null || amount <= Number(p.max_amount))
  );
}

// Directly activates a package from a deposit — does NOT go through wallet balance.
// Wallet is only for earned income (ROI, referrals, rewards).
async function autoActivatePackage(conn, userId, depositAmount) {
  const [packages] = await conn.query(
    'SELECT * FROM packages WHERE is_active = 1 ORDER BY min_amount'
  );
  const pkg = matchPackage(packages, depositAmount);
  if (!pkg) return null; // deposit amount doesn't fit any package range

  const s = await settings.getSettings();
  const capMultiplier = Number(s.cap_multiplier);
  const amount = round2(depositAmount);

  const [ins] = await conn.query(
    `INSERT INTO investments (user_id, package_id, amount, daily_roi_rate, cap_amount, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [userId, pkg.id, amount, pkg.daily_roi_percent, round2(amount * capMultiplier)]
  );

  const [[user]] = await conn.query('SELECT sponsor_id FROM users WHERE id = ?', [userId]);
  if (user?.sponsor_id) await checkBooster(conn, user.sponsor_id);

  return { investmentId: ins.insertId, package: pkg.name, amount };
}

module.exports = { autoActivatePackage };
