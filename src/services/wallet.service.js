const { round2 } = require('../utils/money');

// Ensures a wallet row exists for the user (call inside a transaction).
async function ensureWallet(conn, userId) {
  await conn.query(
    'INSERT IGNORE INTO wallets (user_id, balance, total_deposit, total_withdraw, total_earned) VALUES (?, 0, 0, 0, 0)',
    [userId]
  );
}

// Locks and returns the wallet row for update.
async function lockWallet(conn, userId) {
  await ensureWallet(conn, userId);
  const [rows] = await conn.query('SELECT * FROM wallets WHERE user_id = ? FOR UPDATE', [userId]);
  return rows[0];
}

/**
 * Low-level ledger write: adjusts the wallet balance and writes one
 * transactions row. Returns the new balance.
 *
 * @param direction 'credit' (money in) or 'debit' (money out)
 * @param bucket    which wallet total to bump: 'earned' | 'deposit' | 'withdraw' | null
 */
async function applyLedger(conn, { userId, type, direction, amount, referenceTable = null, referenceId = null, bucket = null }) {
  const amt = round2(amount);
  if (amt <= 0) throw new Error('Ledger amount must be positive');

  const wallet = await lockWallet(conn, userId);
  const delta = direction === 'credit' ? amt : -amt;
  const newBalance = round2(Number(wallet.balance) + delta);
  if (newBalance < 0) throw new Error('Insufficient wallet balance');

  const fields = { balance: newBalance };
  if (bucket === 'earned') fields.total_earned = round2(Number(wallet.total_earned) + amt);
  if (bucket === 'deposit') fields.total_deposit = round2(Number(wallet.total_deposit) + amt);
  if (bucket === 'withdraw') fields.total_withdraw = round2(Number(wallet.total_withdraw) + amt);

  const setSql = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  await conn.query(`UPDATE wallets SET ${setSql} WHERE user_id = ?`, [...Object.values(fields), userId]);

  await conn.query(
    `INSERT INTO transactions (user_id, type, direction, amount, reference_table, reference_id, balance_after)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, type, direction, amt, referenceTable, referenceId, newBalance]
  );
  return newBalance;
}

module.exports = { ensureWallet, lockWallet, applyLedger };
