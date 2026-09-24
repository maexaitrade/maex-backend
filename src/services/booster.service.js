const { percentOf } = require('../utils/money');
const settings = require('./settings.service');
const { getActiveInvestment, creditWithCap } = require('./investment.service');

/**
 * Checks whether `sponsorId` has earned the booster and, if so, pays it once.
 * Rule: within `booster_days` days of the sponsor's ACCOUNT CREATION, they must
 * have `booster_directs` direct referrals whose active package is >= their own.
 * Reward = `booster_percent`% of the sponsor's package amount, credited
 * instantly (subject to the 2x cap). Paid once per investment.
 *
 * Call this after a new direct's package becomes active. Runs in the caller's txn.
 */
async function checkBooster(conn, sponsorId) {
  if (!sponsorId) return 0;
  const s = await settings.getSettings();
  const windowDays = Number(s.booster_days);
  const needed = Number(s.booster_directs);
  const percent = Number(s.booster_percent);

  // The sponsor must hold an active package: it sets both the qualifying
  // threshold (directs must match or beat it) and the payout base.
  const inv = await getActiveInvestment(conn, sponsorId);
  if (!inv) return 0;

  // Already paid for this package?
  const [existing] = await conn.query(
    'SELECT 1 FROM booster_earnings WHERE investment_id = ? LIMIT 1',
    [inv.id]
  );
  if (existing.length) return 0;

  // The 15-day clock starts at the sponsor's account creation.
  const [[sponsor]] = await conn.query('SELECT created_at FROM users WHERE id = ?', [sponsorId]);
  if (!sponsor) return 0;

  // Count qualifying directs: depth-1, with an active package >= the sponsor's,
  // purchased within `windowDays` of the sponsor's account creation.
  const [rows] = await conn.query(
    `SELECT COUNT(DISTINCT g.descendant_id) AS n
     FROM genealogy g
     JOIN investments di ON di.user_id = g.descendant_id
     WHERE g.ancestor_id = ?
       AND g.depth = 1
       AND di.amount >= ?
       AND di.purchased_at <= DATE_ADD(?, INTERVAL ? DAY)`,
    [sponsorId, inv.amount, sponsor.created_at, windowDays]
  );
  const directs = rows[0].n;
  if (directs < needed) return 0;

  const amount = percentOf(inv.amount, percent);
  const paid = await creditWithCap(conn, inv, {
    userId: sponsorId,
    type: 'booster',
    amount,
    referenceTable: 'investments',
    referenceId: inv.id,
  });

  await conn.query(
    `INSERT INTO booster_earnings (user_id, investment_id, directs_count, amount)
     VALUES (?, ?, ?, ?)`,
    [sponsorId, inv.id, directs, paid]
  );
  return paid;
}

module.exports = { checkBooster };
