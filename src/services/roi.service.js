const { pool, withTransaction } = require('../config/db');
const { percentOf } = require('../utils/money');
const { creditWithCap } = require('./investment.service');

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/**
 * Credits daily ROI to every active investment for the given date.
 * Each investment is processed in its own transaction so one failure does not
 * roll back the whole batch. Idempotent: a UNIQUE(investment_id, roi_date)
 * row is claimed with INSERT IGNORE before any money is credited.
 *
 * @returns summary { date, processed, credited, totalPaid, capped }
 */
async function runDailyRoi(date = todayStr()) {
  // Only investments that already existed on `date` accrue ROI for it — this
  // keeps back-fill / catch-up runs from paying ROI for days before purchase.
  const [invs] = await pool.query(
    "SELECT id FROM investments WHERE status = 'active' AND DATE(purchased_at) < ?",
    [date]
  );

  let credited = 0;
  let capped = 0;
  let totalPaid = 0;

  // Process in parallel batches to handle large user bases efficiently.
  const BATCH_SIZE = 50;
  const results = [];
  for (let i = 0; i < invs.length; i += BATCH_SIZE) {
    const batch = invs.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(({ id }) =>
        withTransaction(async (conn) => {
          const [claim] = await conn.query(
            `INSERT IGNORE INTO roi_earnings (investment_id, user_id, roi_date, amount)
             SELECT id, user_id, ?, 0 FROM investments WHERE id = ?`,
            [date, id]
          );
          if (claim.affectedRows === 0) return null; // already processed

          const [rows] = await conn.query(
            "SELECT * FROM investments WHERE id = ? AND status = 'active' FOR UPDATE",
            [id]
          );
          const inv = rows[0];
          if (!inv) return null;

          const roi = percentOf(inv.amount, inv.daily_roi_rate);
          const paid = await creditWithCap(conn, inv, {
            userId: inv.user_id,
            type: 'roi',
            amount: roi,
            referenceTable: 'investments',
            referenceId: inv.id,
          });

          await conn.query(
            'UPDATE roi_earnings SET amount = ? WHERE investment_id = ? AND roi_date = ?',
            [paid, id, date]
          );

          return { paid, capped: inv.status === 'capped' };
        }).catch((err) => {
          console.error(`[roi] investment ${id} failed:`, err.message);
          return null;
        })
      )
    );
    results.push(...batchResults);
  }

  for (const r of results) {
    if (!r) continue;
    if (r.paid > 0) { credited += 1; totalPaid += r.paid; }
    if (r.capped) capped += 1;
  }

  return { date, processed: invs.length, credited, totalPaid, capped };
}

/**
 * Runs the daily ROI for every calendar day that was missed since the last
 * processed date, up to and including today. Safe to call on every server
 * start: each (investment, date) is credited at most once, so re-runs and
 * partial gaps are handled idempotently. Bounded by `maxDays` so a long
 * outage can never spin forever.
 *
 * @returns summary { from, to, days, totalPaid }
 */
async function runRoiCatchUp(maxDays = 60) {
  const today = todayStr();
  // Format in SQL to a plain 'YYYY-MM-DD' string — mysql2 otherwise returns a
  // JS Date at local midnight, which shifts the day under UTC conversion.
  const [[row]] = await pool.query(
    "SELECT DATE_FORMAT(MAX(roi_date), '%Y-%m-%d') AS last FROM roi_earnings"
  );
  const last = row && row.last ? row.last : null;

  // Start the day after the last processed date; if none yet, start today.
  const cursor = new Date(`${last || today}T00:00:00Z`);
  if (last) cursor.setUTCDate(cursor.getUTCDate() + 1);
  const end = new Date(`${today}T00:00:00Z`);

  let totalPaid = 0;
  let days = 0;
  let first = null;
  while (cursor <= end && days < maxDays) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const summary = await runDailyRoi(dateStr);
    if (first === null) first = dateStr;
    totalPaid += summary.totalPaid;
    days += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { from: first, to: today, days, totalPaid };
}

module.exports = { runDailyRoi, runRoiCatchUp, todayStr };
