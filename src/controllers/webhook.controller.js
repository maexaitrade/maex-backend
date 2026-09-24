const { pool, withTransaction } = require('../config/db');
const { verifyIpn } = require('../services/nowpayments.service');
const { applyLedger } = require('../services/wallet.service');
const { payReferralOnDeposit } = require('../services/referral.service');

// Statuses that mean payment is done and we should confirm the deposit
const FINISHED_STATUSES = new Set(['finished', 'confirmed']);
const FAILED_STATUSES = new Set(['failed', 'refunded']);
const EXPIRED_STATUSES = new Set(['expired']);

async function nowpaymentsIpn(req, res) {
  const sig = req.headers['x-nowpayments-sig'];
  const rawBody = req.rawBody; // set by express raw body middleware

  if (!sig || !verifyIpn(rawBody, sig)) {
    console.warn('[nowpayments-ipn] invalid signature');
    return res.status(400).json({ error: 'invalid signature' });
  }

  const data = JSON.parse(rawBody);
  const { payment_id, payment_status, order_id, actually_paid, price_amount } = data;

  console.log(`[nowpayments-ipn] payment_id=${payment_id} status=${payment_status} order_id=${order_id}`);

  const depositId = Number(order_id);
  if (!depositId) return res.json({ ok: true });

  if (FINISHED_STATUSES.has(payment_status)) {
    await withTransaction(async (conn) => {
      // Credit on a real payment even if we locally marked it 'expired' — the
      // money actually arrived, so honour it. Only 'confirmed' is skipped
      // (idempotency) and 'rejected' stays rejected.
      const [rows] = await conn.query(
        "SELECT * FROM deposits WHERE id = ? AND status IN ('pending','expired') FOR UPDATE",
        [depositId]
      );
      const deposit = rows[0];
      if (!deposit) return; // already confirmed/rejected or not found

      await conn.query(
        "UPDATE deposits SET status = 'confirmed', confirmed_at = NOW(), tx_hash = ? WHERE id = ?",
        [String(payment_id), depositId]
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

      await conn.query(
        "INSERT INTO audit_logs (actor_id, action, detail) VALUES (NULL, 'deposit.confirm', ?)",
        [JSON.stringify({ depositId, amount: deposit.amount, payment_id, via: 'nowpayments' })]
      );
    });
  } else if (FAILED_STATUSES.has(payment_status)) {
    await pool.query(
      "UPDATE deposits SET status = 'rejected' WHERE id = ? AND status = 'pending'",
      [depositId]
    );
    await pool.query(
      "INSERT INTO audit_logs (actor_id, action, detail) VALUES (NULL, 'deposit.reject', ?)",
      [JSON.stringify({ depositId, reason: payment_status, via: 'nowpayments' })]
    );
  } else if (EXPIRED_STATUSES.has(payment_status)) {
    await pool.query(
      "UPDATE deposits SET status = 'expired' WHERE id = ? AND status = 'pending'",
      [depositId]
    );
  }

  res.json({ ok: true });
}

module.exports = { nowpaymentsIpn };
