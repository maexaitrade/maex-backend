// ROI engine tests — rate tiers, the $5000 boundary, daily accrual + rounding,
// the 2x cap edges, the ledger side-effects, the purchased_at guard, and the
// catch-up-on-startup logic that fills days missed during downtime.
const {
  api, pool, resetDb, createAdmin, register, fund, buy, bearer, closePool,
} = require('./helpers');
const { runDailyRoi, runRoiCatchUp } = require('../src/services/roi.service');
const { round2 } = require('../src/utils/money');

// --- date helpers (UTC, matching roi.service's todayStr) --------------------
const iso = (d) => d.toISOString().slice(0, 10);
const todayIso = () => iso(new Date());
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
}

// Close the shared pool exactly once, after every test in this file.
afterAll(async () => { await closePool(); });

async function walletOf(userId) {
  const [[w]] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [userId]);
  return w;
}
async function latestInvestment(userId) {
  const [[inv]] = await pool.query(
    'SELECT * FROM investments WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]
  );
  return inv;
}
// Register → fund → buy, returning the user plus their new investment row.
async function activate(adminToken, name, email, amount) {
  const u = await register(name, email);
  await fund(u.token, amount, adminToken);
  const res = await buy(u.token, amount);
  if (res.status !== 201) throw new Error(`buy failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...u, inv: await latestInvestment(u.id), buyBody: res.body };
}

// ===========================================================================
describe('ROI rate tiers by deposit amount ($5000 boundary)', () => {
  let admin;
  beforeAll(async () => { await resetDb(); admin = await createAdmin(); });

  test.each([
    [100, 'Starter', 1],       // low tier minimum
    [2500, 'Starter', 1],
    [5000, 'Starter', 1],      // boundary — still 1%
    [5000.01, 'Premium', 1.5], // just above — 1.5%
    [6000, 'Premium', 1.5],
    [20000, 'Premium', 1.5],
  ])('deposit $%s → %s @ %s%% daily', async (amount, pkg, rate) => {
    const u = await register(`Tier${amount}`, `tier${amount}@t.com`);
    await fund(u.token, amount, admin.token);
    const res = await buy(u.token, amount);
    expect(res.status).toBe(201);
    expect(res.body.package).toBe(pkg);
    expect(res.body.daily_roi_rate).toBe(rate);
    expect(res.body.cap_amount).toBe(round2(amount * 2)); // 2x cap snapshot
  });

  test('deposit below $100 matches no package and is rejected', async () => {
    const u = await register('Tiny', 'tiny@t.com');
    await fund(u.token, 50, admin.token);
    const res = await buy(u.token, 50);
    expect(res.status).toBe(400);
    expect(await latestInvestment(u.id)).toBeUndefined();
  });
});

// ===========================================================================
describe('daily ROI amount, rounding, and ledger side-effects', () => {
  let admin;
  beforeAll(async () => { await resetDb(); admin = await createAdmin(); });

  test('1% of $2000 credits exactly $20/day to balance, total_earned, and ledger', async () => {
    const u = await activate(admin.token, 'Roi2000', 'roi2000@t.com', 2000);
    const w0 = await walletOf(u.id);

    await runDailyRoi('2040-01-01');

    const w1 = await walletOf(u.id);
    expect(round2(Number(w1.balance) - Number(w0.balance))).toBe(20);
    expect(round2(Number(w1.total_earned) - Number(w0.total_earned))).toBe(20);

    const [[roi]] = await pool.query(
      "SELECT amount FROM roi_earnings WHERE investment_id = ? AND roi_date = '2040-01-01'", [u.inv.id]
    );
    expect(Number(roi.amount)).toBe(20);

    const [[tx]] = await pool.query(
      "SELECT type, direction, amount, balance_after FROM transactions WHERE user_id = ? AND type = 'roi' ORDER BY id DESC LIMIT 1",
      [u.id]
    );
    expect(tx.direction).toBe('credit');
    expect(Number(tx.amount)).toBe(20);
    expect(Number(tx.balance_after)).toBe(Number(w1.balance)); // ledger matches wallet
  });

  test('1.5% of $5001 rounds half-up to $75.02', async () => {
    const u = await activate(admin.token, 'Round', 'round@t.com', 5001);
    const w0 = await walletOf(u.id);
    await runDailyRoi('2040-02-01');
    const w1 = await walletOf(u.id);
    expect(round2(Number(w1.total_earned) - Number(w0.total_earned))).toBe(75.02);
  });

  test('a user with no active package receives no ROI', async () => {
    const u = await register('NoPkg', 'nopkg@t.com');
    await fund(u.token, 500, admin.token); // funded but never buys
    const w0 = await walletOf(u.id);
    await runDailyRoi('2040-03-01');
    const w1 = await walletOf(u.id);
    expect(Number(w1.total_earned)).toBe(0);
    expect(Number(w1.balance)).toBe(Number(w0.balance)); // untouched
  });
});

// ===========================================================================
describe('2x cap edges', () => {
  let admin;
  beforeAll(async () => { await resetDb(); admin = await createAdmin(); });

  test('the day that crosses the cap is trimmed to land exactly on 2x', async () => {
    const u = await activate(admin.token, 'Cap', 'cap@t.com', 1000); // roi 10/day, cap 2000
    await pool.query('UPDATE investments SET total_earned = 1995 WHERE id = ?', [u.inv.id]);

    await runDailyRoi('2040-04-01'); // would be +10 -> 2005, trimmed to 2000
    const inv = await latestInvestment(u.id);
    expect(Number(inv.total_earned)).toBe(2000);
    expect(inv.status).toBe('capped');

    const [[roi]] = await pool.query(
      "SELECT amount FROM roi_earnings WHERE investment_id = ? AND roi_date = '2040-04-01'", [u.inv.id]
    );
    expect(Number(roi.amount)).toBe(5); // only the remaining $5 was paid, not $10
  });

  test('an already-capped investment is skipped entirely (no ROI, no row)', async () => {
    const u = await activate(admin.token, 'Capped', 'capped@t.com', 1000);
    await pool.query("UPDATE investments SET total_earned = 2000, status = 'capped' WHERE id = ?", [u.inv.id]);
    const w0 = await walletOf(u.id);

    await runDailyRoi('2040-05-01');

    const w1 = await walletOf(u.id);
    expect(Number(w1.total_earned)).toBe(Number(w0.total_earned));
    const [rows] = await pool.query(
      "SELECT * FROM roi_earnings WHERE investment_id = ? AND roi_date = '2040-05-01'", [u.inv.id]
    );
    expect(rows).toHaveLength(0);
  });

  test('running the same date twice never double-credits', async () => {
    const u = await activate(admin.token, 'Idem', 'idem@t.com', 1000);
    await runDailyRoi('2040-06-01');
    const w1 = await walletOf(u.id);
    const second = await runDailyRoi('2040-06-01'); // same day again
    const w2 = await walletOf(u.id);
    expect(Number(w2.total_earned)).toBe(Number(w1.total_earned)); // unchanged
    // this user's investment contributed nothing on the re-run
    const [[cnt]] = await pool.query(
      "SELECT COUNT(*) n FROM roi_earnings WHERE investment_id = ? AND roi_date = '2040-06-01'", [u.inv.id]
    );
    expect(Number(cnt.n)).toBe(1);
    expect(second.totalPaid).toBe(0);
  });
});

// ===========================================================================
describe('purchased_at guard', () => {
  let admin;
  beforeAll(async () => { await resetDb(); admin = await createAdmin(); });

  test('ROI never accrues for a date before the plan was purchased', async () => {
    const u = await activate(admin.token, 'Guard', 'guard@t.com', 1000); // 10/day
    await pool.query("UPDATE investments SET purchased_at = '2041-06-10 12:00:00' WHERE id = ?", [u.inv.id]);
    const w0 = await walletOf(u.id);

    await runDailyRoi('2041-06-09'); // day BEFORE purchase
    const w1 = await walletOf(u.id);
    expect(Number(w1.total_earned)).toBe(Number(w0.total_earned)); // nothing paid
    const [pre] = await pool.query(
      "SELECT * FROM roi_earnings WHERE investment_id = ? AND roi_date = '2041-06-09'", [u.inv.id]
    );
    expect(pre).toHaveLength(0); // not even a 0-row claim

    await runDailyRoi('2041-06-10'); // purchase day — now it pays
    const w2 = await walletOf(u.id);
    expect(round2(Number(w2.total_earned) - Number(w0.total_earned))).toBe(10);
  });
});

// ===========================================================================
describe('catch-up over missed days (runRoiCatchUp)', () => {
  let admin;
  // Fresh DB per test so the GLOBAL MAX(roi_date) that catch-up keys off is
  // fully controlled and tests stay independent.
  beforeEach(async () => { await resetDb(); admin = await createAdmin(); });

  // Marks a date as already-processed for an investment (sets the "last" cursor).
  async function seedMarker(inv, userId, date) {
    await pool.query(
      'INSERT INTO roi_earnings (investment_id, user_id, roi_date, amount) VALUES (?, ?, ?, 0)',
      [inv, userId, date]
    );
  }

  test('with no history, catch-up processes exactly today (one day)', async () => {
    const u = await activate(admin.token, 'C1', 'c1@t.com', 1000);
    const res = await runRoiCatchUp();
    expect(res.days).toBe(1);
    expect(res.to).toBe(todayIso());
    const [[cnt]] = await pool.query(
      'SELECT COUNT(*) n FROM roi_earnings WHERE investment_id = ? AND roi_date = ?', [u.inv.id, todayIso()]
    );
    expect(Number(cnt.n)).toBe(1);
    expect(Number((await walletOf(u.id)).total_earned)).toBe(10);
  });

  test('fills a multi-day gap: 3 missed days each credited once', async () => {
    const u = await activate(admin.token, 'C2', 'c2@t.com', 1000);
    await pool.query('UPDATE investments SET purchased_at = ? WHERE id = ?', [`${daysAgo(30)} 00:00:00`, u.inv.id]);
    await seedMarker(u.inv.id, u.id, daysAgo(3)); // last processed = 3 days ago

    const res = await runRoiCatchUp(); // should do daysAgo(2), daysAgo(1), today
    expect(res.days).toBe(3);
    expect(res.from).toBe(daysAgo(2));
    expect(res.to).toBe(todayIso());

    const [[cnt]] = await pool.query(
      'SELECT COUNT(*) n FROM roi_earnings WHERE investment_id = ? AND roi_date IN (?,?,?)',
      [u.inv.id, daysAgo(2), daysAgo(1), todayIso()]
    );
    expect(Number(cnt.n)).toBe(3);
    expect(Number((await walletOf(u.id)).total_earned)).toBe(30); // 3 x $10
  });

  test('catch-up is idempotent — a second run credits nothing', async () => {
    const u = await activate(admin.token, 'C3', 'c3@t.com', 1000);
    await pool.query('UPDATE investments SET purchased_at = ? WHERE id = ?', [`${daysAgo(30)} 00:00:00`, u.inv.id]);
    await seedMarker(u.inv.id, u.id, daysAgo(2));

    const first = await runRoiCatchUp();
    const earnedAfterFirst = Number((await walletOf(u.id)).total_earned);
    const second = await runRoiCatchUp(); // nothing left to do
    expect(second.days).toBe(0);
    expect(Number((await walletOf(u.id)).total_earned)).toBe(earnedAfterFirst);
    expect(first.days).toBeGreaterThan(0);
  });

  test('catch-up respects purchased_at: a plan bought mid-gap skips earlier days', async () => {
    // An old plan sets the global "last processed" cursor 4 days back...
    const old = await activate(admin.token, 'Old', 'old@t.com', 1000);
    await pool.query('UPDATE investments SET purchased_at = ? WHERE id = ?', [`${daysAgo(30)} 00:00:00`, old.inv.id]);
    await seedMarker(old.inv.id, old.id, daysAgo(4));

    // ...a new plan is only 2 days old.
    const fresh = await activate(admin.token, 'Fresh', 'fresh@t.com', 1000);
    await pool.query('UPDATE investments SET purchased_at = ? WHERE id = ?', [`${daysAgo(2)} 00:00:00`, fresh.inv.id]);

    await runRoiCatchUp(); // processes daysAgo(3), daysAgo(2), daysAgo(1), today

    // fresh plan earns only from its purchase date forward: daysAgo(2), daysAgo(1), today = 3 days
    const [[freshCnt]] = await pool.query(
      'SELECT COUNT(*) n FROM roi_earnings WHERE investment_id = ?', [fresh.inv.id]
    );
    expect(Number(freshCnt.n)).toBe(3);
    const [before] = await pool.query(
      'SELECT * FROM roi_earnings WHERE investment_id = ? AND roi_date = ?', [fresh.inv.id, daysAgo(3)]
    );
    expect(before).toHaveLength(0); // nothing for the day before purchase
    expect(Number((await walletOf(fresh.id)).total_earned)).toBe(30);
  });

  test('catch-up is bounded by maxDays so a long outage cannot runaway', async () => {
    const u = await activate(admin.token, 'C5', 'c5@t.com', 1000);
    await pool.query('UPDATE investments SET purchased_at = ? WHERE id = ?', [`${daysAgo(60)} 00:00:00`, u.inv.id]);
    await seedMarker(u.inv.id, u.id, daysAgo(10)); // 10-day gap

    const res = await runRoiCatchUp(3); // cap the work at 3 days
    expect(res.days).toBe(3);
    expect(res.from).toBe(daysAgo(9));
    expect(Number((await walletOf(u.id)).total_earned)).toBe(30); // only 3 days paid
  });
});
