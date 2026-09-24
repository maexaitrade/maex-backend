// Star-rank reward tests. Team business = ALL-level confirmed downline deposits.
// Rank thresholds/rewards: S1 $5k→$100, S2 $15k→$300, S3 $45k→$1000,
// S4 $100k→$2000, S5 $250k→$3500. Each rank is awarded once, under the 2x cap.
//
// Business is built via a DEPTH-4 depositor so the leader earns no referral
// (referral only reaches 3 levels) — leaving rewards as the leader's only income.
const {
  pool, resetDb, createAdmin, register, fund, buy, closePool,
} = require('./helpers');
const { withTransaction } = require('../src/config/db');
const { recomputeRank } = require('../src/services/rank.service');

let admin;
beforeAll(async () => { await resetDb(); admin = await createAdmin(); });
afterAll(async () => { await closePool(); });

async function activate(name, email, amount, sponsorId) {
  const u = await register(name, email, sponsorId);
  await fund(u.token, amount, admin.token);
  const res = await buy(u.token, amount);
  if (res.status !== 201) throw new Error(`buy failed: ${JSON.stringify(res.body)}`);
  return u;
}
// leader (optionally with an active package) + a depositor 4 levels below.
async function deepChain(tag, pkg) {
  const leader = pkg
    ? await activate(`${tag}L`, `${tag}l@rw.com`, pkg)
    : await register(`${tag}L`, `${tag}l@rw.com`);
  const x1 = await register(`${tag}x1`, `${tag}x1@rw.com`, leader.id);
  const x2 = await register(`${tag}x2`, `${tag}x2@rw.com`, x1.id);
  const x3 = await register(`${tag}x3`, `${tag}x3@rw.com`, x2.id);
  const m = await register(`${tag}m`, `${tag}m@rw.com`, x3.id); // depth 4 of leader
  return { leader, m };
}
const deposit = (token, amount) => fund(token, amount, admin.token); // deposit + admin confirm
async function rewardsOf(userId) {
  const [rows] = await pool.query(
    `SELECT r.name, ur.reward_amount FROM user_rewards ur
     JOIN ranks r ON r.id = ur.rank_id WHERE ur.user_id = ? ORDER BY r.sort_order`,
    [userId]
  );
  return rows.map((r) => ({ name: r.name, reward_amount: Number(r.reward_amount) }));
}
async function currentRank(userId) {
  const [[row]] = await pool.query(
    'SELECT r.name FROM users u LEFT JOIN ranks r ON r.id = u.current_rank_id WHERE u.id = ?', [userId]
  );
  return row.name; // null when no rank yet
}
const runRecompute = (userId) => withTransaction((conn) => recomputeRank(conn, userId));

describe('star rank rewards as team business grows', () => {
  test('each star is awarded with the correct reward, in order, up to Star 5', async () => {
    const { leader, m } = await deepChain('prog', 5000); // cap 10000 > total rewards 6900
    await deposit(m.token, 5000);   // business 5000   -> Star 1
    await deposit(m.token, 10000);  // business 15000  -> Star 2
    await deposit(m.token, 30000);  // business 45000  -> Star 3
    await deposit(m.token, 55000);  // business 100000 -> Star 4
    await deposit(m.token, 150000); // business 250000 -> Star 5

    expect(await rewardsOf(leader.id)).toEqual([
      { name: 'Star 1', reward_amount: 100 },
      { name: 'Star 2', reward_amount: 300 },
      { name: 'Star 3', reward_amount: 1000 },
      { name: 'Star 4', reward_amount: 2000 },
      { name: 'Star 5', reward_amount: 3500 },
    ]);
    expect(await currentRank(leader.id)).toBe('Star 5');
  });

  test('jumping past several thresholds in one deposit awards every crossed rank at once', async () => {
    const { leader, m } = await deepChain('jump', 5000);
    await deposit(m.token, 45000); // straight to $45k business

    const rows = await rewardsOf(leader.id);
    expect(rows.map((r) => r.name)).toEqual(['Star 1', 'Star 2', 'Star 3']);
    expect(rows.reduce((s, r) => s + r.reward_amount, 0)).toBe(1400); // 100+300+1000
    expect(await currentRank(leader.id)).toBe('Star 3');
  });
});

describe('thresholds and idempotency', () => {
  test('below the threshold nothing is awarded; the exact threshold qualifies', async () => {
    const { leader, m } = await deepChain('bnd', 5000);
    await deposit(m.token, 4999); // just under
    expect(await rewardsOf(leader.id)).toHaveLength(0);
    expect(await currentRank(leader.id)).toBeNull();

    await deposit(m.token, 1); // exactly $5000 (all-level, from a depth-4 member)
    expect(await rewardsOf(leader.id)).toEqual([{ name: 'Star 1', reward_amount: 100 }]);
    expect(await currentRank(leader.id)).toBe('Star 1');
  });

  test('a rank is awarded only once — more business at the same tier does not re-pay', async () => {
    const { leader, m } = await deepChain('once', 5000);
    await deposit(m.token, 5000);  // Star 1
    await deposit(m.token, 2000);  // business 7000, still Star 1
    await runRecompute(leader.id); // explicit recompute must not double-award

    expect(await rewardsOf(leader.id)).toEqual([{ name: 'Star 1', reward_amount: 100 }]);
    expect(await currentRank(leader.id)).toBe('Star 1');
  });
});

describe('edge cases', () => {
  test('rewards are trimmed by the 2x cap; the rank is still recorded', async () => {
    const { leader, m } = await deepChain('cap', 100); // cap 200
    await deposit(m.token, 45000); // Star 1+2+3 due = 1400, but only 200 of cap

    const rows = await rewardsOf(leader.id);
    // Star 1 pays 100 (200->100 left), Star 2 pays 100 (->0), Star 3 pays 0.
    expect(rows.map((r) => r.reward_amount)).toEqual([100, 100, 0]);
    expect(rows.reduce((s, r) => s + r.reward_amount, 0)).toBe(200);
    expect(await currentRank(leader.id)).toBe('Star 3'); // rank achieved even though $ capped

    const [[inv]] = await pool.query(
      'SELECT status FROM investments WHERE user_id = ? ORDER BY id DESC LIMIT 1', [leader.id]
    );
    expect(inv.status).toBe('capped');
  });

  test('team business counts ALL levels — a depth-4 deposit alone qualifies the leader', async () => {
    // deepChain puts the depositor 4 levels down; referral only reaches 3, so
    // this proves rank business (unlike referral) is not depth-limited.
    const { leader, m } = await deepChain('lvl', 5000);
    await deposit(m.token, 5000);
    expect(await currentRank(leader.id)).toBe('Star 1');
    expect((await rewardsOf(leader.id))[0].reward_amount).toBe(100);
  });

  test('a leader with no active package achieves the rank but is paid $0', async () => {
    const { leader, m } = await deepChain('np', null); // leader never bought a package
    await deposit(m.token, 5000);

    // Rank is recorded, but the reward money needs an active package to land.
    expect(await rewardsOf(leader.id)).toEqual([{ name: 'Star 1', reward_amount: 0 }]);
    expect(await currentRank(leader.id)).toBe('Star 1');
  });
});
