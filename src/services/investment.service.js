const { round2 } = require('../utils/money');
const { applyLedger } = require('./wallet.service');

// Returns the user's current active investment (locked), or null.
// A user's "current package" = their most recent active investment.
async function getActiveInvestment(conn, userId) {
  const [rows] = await conn.query(
    `SELECT * FROM investments
     WHERE user_id = ? AND status = 'active'
     ORDER BY purchased_at DESC, id DESC
     LIMIT 1 FOR UPDATE`,
    [userId]
  );
  return rows[0] || null;
}

/**
 * Credits an earning (roi | referral | booster | reward) but never lets an
 * investment's total earnings exceed its 2x cap. Returns the amount actually
 * paid (may be less than requested, or 0 if the investment is already capped).
 *
 * Pass the locked investment row so ROI can target a specific one; working
 * income passes the user's current active investment.
 */
async function creditWithCap(conn, investment, { userId, type, amount, referenceTable, referenceId }) {
  if (!investment) return 0; // no active package => no earnings accrue
  const remaining = round2(Number(investment.cap_amount) - Number(investment.total_earned));
  if (remaining <= 0) {
    if (investment.status !== 'capped') {
      await conn.query('UPDATE investments SET status = ? WHERE id = ?', ['capped', investment.id]);
    }
    return 0;
  }

  const pay = round2(Math.min(Number(amount), remaining));
  if (pay <= 0) return 0;

  await applyLedger(conn, {
    userId,
    type,
    direction: 'credit',
    amount: pay,
    referenceTable,
    referenceId,
    bucket: 'earned',
  });

  const newTotal = round2(Number(investment.total_earned) + pay);
  const capped = newTotal >= Number(investment.cap_amount);
  await conn.query(
    'UPDATE investments SET total_earned = ?, status = ? WHERE id = ?',
    [newTotal, capped ? 'capped' : 'active', investment.id]
  );
  investment.total_earned = newTotal;
  if (capped) investment.status = 'capped';
  return pay;
}

module.exports = { getActiveInvestment, creditWithCap };
