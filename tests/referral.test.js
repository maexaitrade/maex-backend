// Referral income tests — level-wise payout (L1 3%, L2 1.5%, L3 1.5%) that
// fires ONLY when a downline's deposit is confirmed (not on signup), respects
// the "up-line must be active" rule, the 2x cap, and stops at level 3.
const {
  api, pool, resetDb, createAdmin, register, fund, buy, bearer, closePool,
} = require('./helpers');
const { round2 } = require('../src/utils/money');

let admin;
beforeAll(async () => { await resetDb(); admin = await createAdmin(); });
afterAll(async () => { await closePool(); });

async function earnedOf(userId) {
  const [[w]] = await pool.query('SELECT total_earned FROM wallets WHERE user_id = ?', [userId]);
  return Number(w.total_earned);
}
async function refRows(depositId) {
  const [rows] = await pool.query(
    'SELECT user_id, level, percent, amount FROM referral_earnings WHERE deposit_id = ? ORDER BY level',
    [depositId]
  );
  return rows;
}
// Register → fund → buy so the user is an ACTIVE earner (can receive referral).
async function activate(name, email, amount, sponsorId) {
  const u = await register(name, email, sponsorId);
  await fund(u.token, amount, admin.token);
  const res = await buy(u.token, amount);
  if (res.status !== 201) throw new Error(`buy failed: ${JSON.stringify(res.body)}`);
  return u;
}
// Submit a deposit without confirming it.
async function submitDeposit(token, amount) {
  const res = await api.post('/api/deposits').set(bearer(token)).send({ amount });
  return res.body.id;
}
async function confirmDeposit(id) {
  return api.patch(`/api/admin/deposits/${id}`).set(bearer(admin.token)).send({ action: 'confirm' });
}

describe('level-wise referral split on a confirmed deposit', () => {
  test('L1=3%, L2=1.5%, L3=1.5% credited to the right up-lines', async () => {
    // chain: A -> B -> C -> D  (A,B,C active so they can earn)
    const A = await activate('A', 'a@ref.com', 1000);
    const B = await activate('B', 'b@ref.com', 1000, A.id);
    const C = await activate('C', 'c@ref.com', 1000, B.id);
    const D = await register('D', 'd@ref.com', C.id);

    const before = { A: await earnedOf(A.id), B: await earnedOf(B.id), C: await earnedOf(C.id) };

    // D deposits $1000 and it is confirmed → referral flows up 3 levels.
    const depId = await submitDeposit(D.token, 1000);
    await confirmDeposit(depId);

    const rows = await refRows(depId);
    expect(rows).toHaveLength(3);
    // level 1 -> C (direct), level 2 -> B, level 3 -> A
    expect(rows).toEqual([
      expect.objectContaining({ user_id: C.id, level: 1, amount: 30 }),
      expect.objectContaining({ user_id: B.id, level: 2, amount: 15 }),
      expect.objectContaining({ user_id: A.id, level: 3, amount: 15 }),
    ]);

    expect(round2(await earnedOf(C.id) - before.C)).toBe(30); // 3% of 1000
    expect(round2(await earnedOf(B.id) - before.B)).toBe(15); // 1.5%
    expect(round2(await earnedOf(A.id) - before.A)).toBe(15); // 1.5%
  });
});

describe('referral fires on deposit confirmation only — never on signup', () => {
  test('signup alone pays no referral; a pending deposit pays nothing; confirming pays L1', async () => {
    const sponsor = await activate('Sp', 'sp@ref.com', 1000);
    const member = await register('Mem', 'mem@ref.com', sponsor.id);

    // 1) just signed up -> nothing
    let [[cnt]] = await pool.query('SELECT COUNT(*) n FROM referral_earnings WHERE user_id = ?', [sponsor.id]);
    expect(Number(cnt.n)).toBe(0);
    const earnedAfterSignup = await earnedOf(sponsor.id);

    // 2) member submits a deposit but it is NOT confirmed yet -> still nothing
    const depId = await submitDeposit(member.token, 1000);
    expect(await earnedOf(sponsor.id)).toBe(earnedAfterSignup);
    let rows = await refRows(depId);
    expect(rows).toHaveLength(0);

    // 3) admin confirms -> sponsor now earns L1 = 3% of 1000 = 30
    await confirmDeposit(depId);
    rows = await refRows(depId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: sponsor.id, level: 1, amount: 30 });
    expect(round2(await earnedOf(sponsor.id) - earnedAfterSignup)).toBe(30);
  });

  test('a rejected deposit pays no referral', async () => {
    const sponsor = await activate('SpR', 'spr@ref.com', 1000);
    const member = await register('MemR', 'memr@ref.com', sponsor.id);
    const before = await earnedOf(sponsor.id);

    const depId = await submitDeposit(member.token, 1000);
    await api.patch(`/api/admin/deposits/${depId}`).set(bearer(admin.token)).send({ action: 'reject' });

    expect(await refRows(depId)).toHaveLength(0);
    expect(await earnedOf(sponsor.id)).toBe(before);
  });
});

describe('eligibility and boundaries', () => {
  test('an inactive up-line earns nothing, but active up-lines at other levels still get paid', async () => {
    const A = await activate('Ea', 'ea@ref.com', 1000);          // L2 up-line, ACTIVE
    const B = await register('Eb', 'eb@ref.com', A.id);          // L1 up-line, NO package (inactive)
    const C = await register('Ec', 'ec@ref.com', B.id);

    const beforeA = await earnedOf(A.id);
    const depId = await submitDeposit(C.token, 1000);
    await confirmDeposit(depId);

    const rows = await refRows(depId);
    // B (inactive, level 1) earns nothing; A (active, level 2) is paid.
    const byUser = Object.fromEntries(rows.map((r) => [r.user_id, r]));
    expect(byUser[B.id]).toBeUndefined();
    expect(byUser[A.id]).toMatchObject({ level: 2, amount: 15 });
    expect(round2(await earnedOf(A.id) - beforeA)).toBe(15);
  });

  test('referral stops at level 3 even when the up-line tree is much deeper', async () => {
    // Build a 6-deep up-line above the depositor:
    //   U1 -> U2 -> U3 -> U4 -> U5 -> U6 -> depositor
    // Every up-line is ACTIVE, so the ONLY reason 4/5/6 earn nothing is the
    // 3-level cap (not the active-earner rule).
    const U1 = await activate('D1', 'd1@ref.com', 1000);
    const U2 = await activate('D2', 'd2@ref.com', 1000, U1.id);
    const U3 = await activate('D3', 'd3@ref.com', 1000, U2.id);
    const U4 = await activate('D4', 'd4@ref.com', 1000, U3.id);
    const U5 = await activate('D5', 'd5@ref.com', 1000, U4.id);
    const U6 = await activate('D6', 'd6@ref.com', 1000, U5.id);
    const dep = await register('D7', 'd7@ref.com', U6.id);

    // The genealogy tree really DOES go 6 levels up (nothing is truncated there)...
    const [[deep]] = await pool.query(
      'SELECT depth FROM genealogy WHERE ancestor_id = ? AND descendant_id = ?',
      [U1.id, dep.id]
    );
    expect(deep.depth).toBe(6);

    const depId = await submitDeposit(dep.token, 1000);
    await confirmDeposit(depId);

    // ...but the PAYOUT walks only three levels: exactly L1/L2/L3, to U6/U5/U4.
    // (We assert on referral_earnings rows, not total_earned, because deep
    //  deposits also trigger rank rewards up the tree — a separate income type.)
    const rows = await refRows(depId);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual([
      expect.objectContaining({ user_id: U6.id, level: 1, amount: 30 }), // 3%
      expect.objectContaining({ user_id: U5.id, level: 2, amount: 15 }), // 1.5%
      expect.objectContaining({ user_id: U4.id, level: 3, amount: 15 }), // 1.5%
    ]);

    // Levels 4, 5 and 6 get NO referral row for this deposit — we stop at 3.
    const paidUsers = rows.map((r) => r.user_id);
    expect(paidUsers).not.toContain(U3.id); // level 4
    expect(paidUsers).not.toContain(U2.id); // level 5
    expect(paidUsers).not.toContain(U1.id); // level 6
  });

  test('referral is trimmed so an up-line never exceeds its 2x cap', async () => {
    const sponsor = await activate('Cap', 'cap@ref.com', 100); // cap = 200
    const member = await register('CapM', 'capm@ref.com', sponsor.id);

    // push the sponsor to $5 short of the cap
    const [[inv]] = await pool.query(
      'SELECT id FROM investments WHERE user_id = ? ORDER BY id DESC LIMIT 1', [sponsor.id]
    );
    await pool.query('UPDATE investments SET total_earned = 195 WHERE id = ?', [inv.id]);
    await pool.query('UPDATE wallets SET total_earned = 195 WHERE user_id = ?', [sponsor.id]);

    // a $1000 deposit would give L1 = $30, but only $5 of cap remains
    const depId = await submitDeposit(member.token, 1000);
    await confirmDeposit(depId);

    const rows = await refRows(depId);
    expect(rows[0].amount).toBe(5); // trimmed to the remaining cap
    const [[after]] = await pool.query('SELECT total_earned, status FROM investments WHERE id = ?', [inv.id]);
    expect(Number(after.total_earned)).toBe(200);
    expect(after.status).toBe('capped');
  });

  test('each separate deposit generates its own referral payout', async () => {
    const sponsor = await activate('Multi', 'multi@ref.com', 1000);
    const member = await register('MultiM', 'multim@ref.com', sponsor.id);
    const before = await earnedOf(sponsor.id);

    const d1 = await submitDeposit(member.token, 1000);
    await confirmDeposit(d1);
    const d2 = await submitDeposit(member.token, 2000);
    await confirmDeposit(d2);

    expect((await refRows(d1))[0].amount).toBe(30); // 3% of 1000
    expect((await refRows(d2))[0].amount).toBe(60); // 3% of 2000
    expect(round2(await earnedOf(sponsor.id) - before)).toBe(90); // 30 + 60
  });
});
