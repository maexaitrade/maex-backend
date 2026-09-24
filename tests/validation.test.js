// T&C validation: TRC-20 address checks, min withdraw $50, 6% withdraw charge,
// TRC-20 deposit sender, and the "2x cap then repurchase" earning cycle.
const {
  api, pool, resetDb, createAdmin, register, fund, buy, bearer, closePool,
} = require('./helpers');
const { runDailyRoi } = require('../src/services/roi.service');

const VALID_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const VALID_TRON_2 = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';

let admin;
beforeAll(async () => { await resetDb(); admin = await createAdmin(); });
afterAll(async () => { await closePool(); });

const setAddress = (token, addr) =>
  api.patch('/api/me/profile').set(bearer(token)).send({ wallet_address: addr });

describe('TRC-20 wallet address validation', () => {
  test('rejects malformed and bad-checksum addresses', async () => {
    const u = await register('Addr', 'addr@v.com');
    for (const bad of [
      'TWDaddr',                                  // too short
      '1R7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',       // wrong prefix
      'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj60',       // valid shape, bad checksum
      '0x1234567890abcdef1234567890abcdef12345678', // ETH address
      'not-an-address',
    ]) {
      const res = await setAddress(u.token, bad);
      expect(res.status).toBe(400);
    }
    const [[row]] = await pool.query('SELECT wallet_address FROM users WHERE id = ?', [u.id]);
    expect(row.wallet_address).toBeNull(); // nothing invalid was stored
  });

  test('accepts a valid TRC-20 address', async () => {
    const u = await register('Addr2', 'addr2@v.com');
    const res = await setAddress(u.token, VALID_TRON);
    expect(res.status).toBe(200);
    expect(res.body.wallet_address).toBe(VALID_TRON);
  });

  test('withdrawal is blocked until a valid address is set', async () => {
    const u = await register('NoAddr', 'noaddr@v.com');
    await fund(u.token, 200, admin.token);
    const blocked = await api.post('/api/withdrawals').set(bearer(u.token)).send({ amount: 100 });
    expect(blocked.status).toBe(400); // no address yet

    await setAddress(u.token, VALID_TRON);
    const ok = await api.post('/api/withdrawals').set(bearer(u.token)).send({ amount: 100 });
    expect(ok.status).toBe(201);
  });
});

describe('withdrawal rules: min $50 and 6% charge', () => {
  async function ready(name, email, balance) {
    const u = await register(name, email);
    await fund(u.token, balance, admin.token);
    await setAddress(u.token, VALID_TRON);
    return u;
  }

  test('below the $50 minimum is rejected; exactly $50 is allowed', async () => {
    const u = await ready('Min', 'min@v.com', 200);
    const tooSmall = await api.post('/api/withdrawals').set(bearer(u.token)).send({ amount: 49.99 });
    expect(tooSmall.status).toBe(400);

    const ok = await api.post('/api/withdrawals').set(bearer(u.token)).send({ amount: 50 });
    expect(ok.status).toBe(201);
    expect(ok.body.charge).toBe(3);       // 6% of 50
    expect(ok.body.net_amount).toBe(47);  // 50 - 3
  });

  test('6% charge and net are computed correctly', async () => {
    const u = await ready('Charge', 'charge@v.com', 500);
    const res = await api.post('/api/withdrawals').set(bearer(u.token)).send({ amount: 100 });
    expect(res.body.charge).toBe(6);
    expect(res.body.net_amount).toBe(94);
  });

  test('a request above the wallet balance is rejected', async () => {
    const u = await ready('Broke', 'broke@v.com', 60);
    const res = await api.post('/api/withdrawals').set(bearer(u.token)).send({ amount: 100 });
    expect(res.status).toBe(400);
  });
});

describe('deposits are TRC-20', () => {
  test('a deposit with an invalid from_address is rejected', async () => {
    const u = await register('Dep', 'dep@v.com');
    const bad = await api.post('/api/deposits').set(bearer(u.token))
      .send({ amount: 100, from_address: 'not-tron' });
    expect(bad.status).toBe(400);
  });

  test('a deposit with a valid (or absent) from_address is accepted', async () => {
    const u = await register('Dep2', 'dep2@v.com');
    const withAddr = await api.post('/api/deposits').set(bearer(u.token))
      .send({ amount: 100, from_address: VALID_TRON_2 });
    expect(withAddr.status).toBe(201);
    const without = await api.post('/api/deposits').set(bearer(u.token)).send({ amount: 100 });
    expect(without.status).toBe(201); // from_address is optional
  });
});

describe('2x cap then repurchase', () => {
  test('earnings stop at the 2x cap; the user must buy again to earn more', async () => {
    const u = await register('Cycle', 'cycle@v.com');
    await fund(u.token, 1000, admin.token);
    await buy(u.token, 1000); // inv1: cap 2000, 1%/day
    const [[inv1]] = await pool.query(
      'SELECT id FROM investments WHERE user_id = ? ORDER BY id DESC LIMIT 1', [u.id]
    );

    // Nudge to just below the cap, then a ROI day tips it over — trimmed to 2x.
    await pool.query('UPDATE investments SET total_earned = 1995 WHERE id = ?', [inv1.id]);
    await runDailyRoi('2050-01-01'); // +10 would be 2005 -> trimmed to 2000
    let [[a1]] = await pool.query('SELECT total_earned, status FROM investments WHERE id = ?', [inv1.id]);
    expect(Number(a1.total_earned)).toBe(2000);
    expect(a1.status).toBe('capped');

    // A capped investment earns nothing further — no active package remains.
    await runDailyRoi('2050-01-02');
    [[a1]] = await pool.query('SELECT total_earned FROM investments WHERE id = ?', [inv1.id]);
    expect(Number(a1.total_earned)).toBe(2000); // unchanged

    // Repurchase: a fresh package resets the earning cycle.
    await fund(u.token, 1000, admin.token);
    await buy(u.token, 1000); // inv2
    const [[inv2]] = await pool.query(
      'SELECT id FROM investments WHERE user_id = ? ORDER BY id DESC LIMIT 1', [u.id]
    );
    expect(inv2.id).not.toBe(inv1.id);

    await runDailyRoi('2050-01-03'); // inv2 earns again
    const [[a2]] = await pool.query('SELECT total_earned, status FROM investments WHERE id = ?', [inv2.id]);
    expect(Number(a2.total_earned)).toBe(10); // 1% of 1000, fresh cap
    expect(a2.status).toBe('active');
  });
});
