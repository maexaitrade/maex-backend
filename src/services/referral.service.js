const { percentOf } = require('../utils/money');
const settings = require('./settings.service');
const { getAncestors } = require('./genealogy.service');
const { getActiveInvestment, creditWithCap } = require('./investment.service');

/**
 * Pays L1/L2/L3 referral income to the up-line when a deposit is confirmed.
 * Runs inside the caller's transaction. Idempotent per (deposit, level) via
 * the unique key on referral_earnings.
 */
async function payReferralOnDeposit(conn, deposit) {
  const s = await settings.getSettings();
  const percents = [Number(s.referral_l1), Number(s.referral_l2), Number(s.referral_l3)];

  const ancestors = await getAncestors(conn, deposit.user_id, 3);
  for (const anc of ancestors) {
    const percent = percents[anc.depth - 1];
    if (!percent) continue;
    const gross = percentOf(deposit.amount, percent);
    if (gross <= 0) continue;

    // Skip if we already paid this level for this deposit.
    const [dup] = await conn.query(
      'SELECT 1 FROM referral_earnings WHERE deposit_id = ? AND level = ? LIMIT 1',
      [deposit.id, anc.depth]
    );
    if (dup.length) continue;

    const inv = await getActiveInvestment(conn, anc.user_id);
    const paid = await creditWithCap(conn, inv, {
      userId: anc.user_id,
      type: 'referral',
      amount: gross,
      referenceTable: 'deposits',
      referenceId: deposit.id,
    });

    if (paid > 0) {
      await conn.query(
        `INSERT INTO referral_earnings
           (user_id, from_user_id, deposit_id, level, source_amount, percent, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [anc.user_id, deposit.user_id, deposit.id, anc.depth, deposit.amount, percent, paid]
      );
    }
  }
}

module.exports = { payReferralOnDeposit };
