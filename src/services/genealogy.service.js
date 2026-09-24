// Closure-table helpers for the referral tree.

/**
 * Registers a new user in the genealogy closure table.
 * Adds the self row (depth 0) plus, if there is a sponsor, a row linking the
 * new user to every ancestor of the sponsor (depth + 1), and the sponsor
 * itself at depth 1.
 */
async function insertIntoTree(conn, userId, sponsorId) {
  // self reference (depth 0) — makes subtree queries simpler
  await conn.query(
    'INSERT INTO genealogy (ancestor_id, descendant_id, depth) VALUES (?, ?, 0)',
    [userId, userId]
  );
  if (!sponsorId) return;

  // For each ancestor A of the sponsor (including the sponsor at depth 0),
  // the new user is A's descendant at depth+1.
  await conn.query(
    `INSERT INTO genealogy (ancestor_id, descendant_id, depth)
     SELECT g.ancestor_id, ?, g.depth + 1
     FROM genealogy g
     WHERE g.descendant_id = ?`,
    [userId, sponsorId]
  );
}

// Returns up-line ancestors of a user at depths 1..maxDepth, ordered by depth.
async function getAncestors(conn, userId, maxDepth) {
  const [rows] = await conn.query(
    `SELECT ancestor_id AS user_id, depth
     FROM genealogy
     WHERE descendant_id = ? AND depth BETWEEN 1 AND ?
     ORDER BY depth ASC`,
    [userId, maxDepth]
  );
  return rows;
}

// Counts direct referrals (depth 1) of a user.
async function countDirects(conn, userId) {
  const [rows] = await conn.query(
    'SELECT COUNT(*) AS n FROM genealogy WHERE ancestor_id = ? AND depth = 1',
    [userId]
  );
  return rows[0].n;
}

module.exports = { insertIntoTree, getAncestors, countDirects };
