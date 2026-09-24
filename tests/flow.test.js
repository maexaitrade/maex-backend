const {
  api, pool, resetDb, createAdmin, register, fund, buy, bearer, closePool,
} = require('./helpers');
const { runDailyRoi } = require('../src/services/roi.service');

let admin;
beforeAll(async () => {
  await resetDb();
  admin = await createAdmin();
});
afterAll(async () => { await closePool(); });

describe('deposit confirmation + referral payout', () => {
  test('confirming a downline deposit pays the active up-line L1 referral', async () => {
    const sponsor = await register('Sponsor', 'sp@t.com');
    await fund(sponsor.token, 1000, admin.token);
    await buy(sponsor.token, 1000); // sponsor is now an active earner

    const member = await register('Member', 'mem@t.com', sponsor.id);
    await fund(member.token, 1000, admin.token); // triggers referral to sponsor

    const [refs] = await pool.query(
      'SELECT * FROM referral_earnings WHERE user_id = ? AND level = 1',
      [sponsor.id]
    );
    expect(refs).toHaveLength(1);
    expect(Number(refs[0].amount)).toBe(30); // 3% of 1000

    const dash = await api.get('/api/me/dashboard').set(bearer(sponsor.token));
    expect(dash.body.income.referral).toBe(30);
  });

  test('inactive up-line (no package) earns no referral', async () => {
    const inactive = await register('Inactive', 'ina@t.com'); // never buys a package
    const child = await register('Child', 'ch@t.com', inactive.id);
    await fund(child.token, 1000, admin.token);

    const [refs] = await pool.query('SELECT * FROM referral_earnings WHERE user_id = ?', [inactive.id]);
    expect(refs).toHaveLength(0);
  });

  test('rejecting a deposit does not credit the wallet', async () => {
    const u = await register('Rej', 'rej@t.com');
    const dep = await api.post('/api/deposits').set(bearer(u.token)).send({ amount: 500 });
    const res = await api.patch(`/api/admin/deposits/${dep.body.id}`)
      .set(bearer(admin.token)).send({ action: 'reject' });
    expect(res.body.status).toBe('rejected');
    const [[w]] = await pool.query('SELECT balance FROM wallets WHERE user_id = ?', [u.id]);
    expect(Number(w.balance)).toBe(0);
  });
});

describe('package purchase', () => {
  test('buying sets a 2x cap and correct ROI rate; over-buy is rejected', async () => {
    const u = await register('Buyer', 'buy@t.com');
    await fund(u.token, 1000, admin.token);

    const ok = await buy(u.token, 1000);
    expect(ok.status).toBe(201);
    expect(ok.body.cap_amount).toBe(2000);
    expect(ok.body.daily_roi_rate).toBe(1);

    // balance is now 0 -> a second purchase must fail
    const fail = await buy(u.token, 500);
    expect(fail.status).toBe(400);
  });

  test('premium package (> $5000) gets the 1.5% rate', async () => {
    const u = await register('Whale', 'whale@t.com');
    await fund(u.token, 6000, admin.token);
    const ok = await buy(u.token, 6000);
    expect(ok.status).toBe(201);
    expect(ok.body.package).toBe('Premium');
    expect(ok.body.daily_roi_rate).toBe(1.5);
  });
});

describe('daily ROI job', () => {
  test('credits active investments and is idempotent for a date', async () => {
    const first = await runDailyRoi('2030-01-01');
    expect(first.credited).toBeGreaterThan(0);
    const totalFirst = first.totalPaid;

    const second = await runDailyRoi('2030-01-01'); // same date again
    expect(second.credited).toBe(0);
    expect(second.totalPaid).toBe(0);

    // Balances did not double up.
    const [[sum]] = await pool.query(
      "SELECT COALESCE(SUM(amount),0) AS s FROM roi_earnings WHERE roi_date = '2030-01-01'"
    );
    expect(Number(sum.s)).toBe(totalFirst);
  });

  test('ROI is trimmed so an investment never exceeds its 2x cap', async () => {
    const u = await register('Capper', 'cap@t.com');
    await fund(u.token, 1000, admin.token);
    await buy(u.token, 1000); // cap 2000, roi 10/day

    const [[inv]] = await pool.query(
      "SELECT id FROM investments WHERE user_id = ? ORDER BY id DESC LIMIT 1", [u.id]
    );
    // Push it to just below the cap.
    await pool.query('UPDATE investments SET total_earned = 1995 WHERE id = ?', [inv.id]);

    await runDailyRoi('2030-03-01');

    const [[after]] = await pool.query('SELECT total_earned, status FROM investments WHERE id = ?', [inv.id]);
    expect(Number(after.total_earned)).toBe(2000); // exactly the cap, not 2005
    expect(after.status).toBe('capped');

    const [[roi]] = await pool.query(
      "SELECT amount FROM roi_earnings WHERE investment_id = ? AND roi_date = '2030-03-01'", [inv.id]
    );
    expect(Number(roi.amount)).toBe(5); // only the remaining 5 was paid
  });
});

describe('withdrawals', () => {
  test('validates address, minimum, charge, and admin pay/reject refund', async () => {
    const u = await register('Withdrawer', 'wd@t.com');
    await fund(u.token, 1000, admin.token); // balance 1000, no package needed

    // no wallet address yet
    const noAddr = await api.post('/api/withdrawals').set(bearer(u.token)).send({ amount: 100 });
    expect(noAddr.status).toBe(400);

    await api.patch('/api/me/profile').set(bearer(u.token)).send({ wallet_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' });

    // below minimum
    const tooSmall = await api.post('/api/withdrawals').set(bearer(u.token)).send({ amount: 30 });
    expect(tooSmall.status).toBe(400);

    // valid request: 100 - 6% = 94
    const req = await api.post('/api/withdrawals').set(bearer(u.token)).send({ amount: 100 });
    expect(req.status).toBe(201);
    expect(req.body.charge).toBe(6);
    expect(req.body.net_amount).toBe(94);

    let [[w]] = await pool.query('SELECT balance FROM wallets WHERE user_id = ?', [u.id]);
    expect(Number(w.balance)).toBe(900); // debited immediately

    // admin rejects -> full gross refunded
    await api.patch(`/api/admin/withdrawals/${req.body.id}`)
      .set(bearer(admin.token)).send({ action: 'reject' });
    [[w]] = await pool.query('SELECT balance, total_withdraw FROM wallets WHERE user_id = ?', [u.id]);
    expect(Number(w.balance)).toBe(1000);
    expect(Number(w.total_withdraw)).toBe(0);

    // new request + admin pays -> total_withdraw counts, balance stays debited
    const req2 = await api.post('/api/withdrawals').set(bearer(u.token)).send({ amount: 100 });
    const pay = await api.patch(`/api/admin/withdrawals/${req2.body.id}`)
      .set(bearer(admin.token)).send({ action: 'pay', tx_hash: '0xabc' });
    expect(pay.body.status).toBe('paid');
    [[w]] = await pool.query('SELECT balance, total_withdraw FROM wallets WHERE user_id = ?', [u.id]);
    expect(Number(w.balance)).toBe(900);
    expect(Number(w.total_withdraw)).toBe(100);
  });
});
