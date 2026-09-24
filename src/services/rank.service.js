const { getActiveInvestment, creditWithCap } = require('./investment.service');

/**
 * Team business = total confirmed deposits of the entire downline (all levels).
 */
async function getTeamBusiness(conn, userId) {
  const [rows] = await conn.query(
    `SELECT COALESCE(SUM(d.amount), 0) AS business
     FROM genealogy g
     JOIN deposits d ON d.user_id = g.descendant_id AND d.status = 'confirmed'
     WHERE g.ancestor_id = ? AND g.depth >= 1`,
    [userId]
  );
  return Number(rows[0].business);
}

/**
 * Recomputes a user's rank from team business and awards any newly crossed
 * rank reward (once each). Updates users.current_rank_id to the highest rank.
 * Rewards count toward the 2x cap. Runs in the caller's txn.
 */
async function recomputeRank(conn, userId) {
  const business = await getTeamBusiness(conn, userId);

  const [ranks] = await conn.query(
    'SELECT * FROM ranks WHERE business_required <= ? ORDER BY sort_order ASC',
    [business]
  );
  if (!ranks.length) return { business, awarded: [] };

  const awarded = [];
  let highestRankId = null;

  for (const rank of ranks) {
    highestRankId = rank.id;
    const [dup] = await conn.query(
      'SELECT 1 FROM user_rewards WHERE user_id = ? AND rank_id = ? LIMIT 1',
      [userId, rank.id]
    );
    if (dup.length) continue;

    const inv = await getActiveInvestment(conn, userId);
    const paid = await creditWithCap(conn, inv, {
      userId,
      type: 'reward',
      amount: Number(rank.reward_amount),
      referenceTable: 'ranks',
      referenceId: rank.id,
    });
    await conn.query(
      `INSERT INTO user_rewards
         (user_id, rank_id, business_at_qualification, reward_amount)
       VALUES (?, ?, ?, ?)`,
      [userId, rank.id, business, paid]
    );
    awarded.push({ rank: rank.name, paid });
  }

  if (highestRankId) {
    await conn.query('UPDATE users SET current_rank_id = ? WHERE id = ?', [highestRankId, userId]);
  }
  return { business, awarded };
}

module.exports = { getTeamBusiness, recomputeRank };
