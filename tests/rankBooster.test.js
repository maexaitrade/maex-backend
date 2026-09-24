const {
  api, pool, resetDb, createAdmin, register, fund, buy, bearer, closePool,
} = require('./helpers');

let admin;
beforeAll(async () => {
  await resetDb();
  admin = await createAdmin();
});
afterAll(async () => { await closePool(); });

describe('booster bonus', () => {
  test('7 same-or-higher directs within the window pays 20% once', async () => {
    const sponsor = await register('BoostSponsor', 'boost@t.com');
    await fund(sponsor.token, 100, admin.token);
    await buy(sponsor.token, 100); // active $100 package (cap 200)

    // 7 directs, each with a $100 active package
    for (let i = 0; i < 7; i += 1) {
      const d = await register(`D${i}`, `d${i}@boost.com`, sponsor.id);
      await fund(d.token, 100, admin.token);
      await buy(d.token, 100);
    }

    const [[booster]] = await pool.query(
      'SELECT directs_count, amount FROM booster_earnings WHERE user_id = ?',
      [sponsor.id]
    );
    expect(booster).toBeTruthy();
    expect(booster.directs_count).toBeGreaterThanOrEqual(7);
    expect(Number(booster.amount)).toBe(20); // 20% of $100

    // only one booster row for the investment (idempotent)
    const [[cnt]] = await pool.query(
      'SELECT COUNT(*) AS n FROM booster_earnings WHERE user_id = ?', [sponsor.id]
    );
    expect(cnt.n).toBe(1);
  });

  test('fewer than 7 directs pays no booster', async () => {
    const sponsor = await register('NoBoost', 'noboost@t.com');
    await fund(sponsor.token, 100, admin.token);
    await buy(sponsor.token, 100);
    for (let i = 0; i < 3; i += 1) {
      const d = await register(`N${i}`, `n${i}@nb.com`, sponsor.id);
      await fund(d.token, 100, admin.token);
      await buy(d.token, 100);
    }
    const [rows] = await pool.query('SELECT * FROM booster_earnings WHERE user_id = ?', [sponsor.id]);
    expect(rows).toHaveLength(0);
  });
});

describe('star rank reward', () => {
  test('crossing $5000 team business awards Star 1 once', async () => {
    const leader = await register('Leader', 'leader@t.com');
    await fund(leader.token, 5000, admin.token);
    await buy(leader.token, 5000); // active, cap 10000 (so reward is not trimmed)

    // 5 directs depositing $1000 each => $5000 team business
    for (let i = 0; i < 5; i += 1) {
      const d = await register(`T${i}`, `t${i}@team.com`, leader.id);
      await fund(d.token, 1000, admin.token);
    }

    const [[reward]] = await pool.query(
      `SELECT r.name, ur.reward_amount FROM user_rewards ur
       JOIN ranks r ON r.id = ur.rank_id WHERE ur.user_id = ?`,
      [leader.id]
    );
    expect(reward).toBeTruthy();
    expect(reward.name).toBe('Star 1');
    expect(Number(reward.reward_amount)).toBe(100);

    const dash = await api.get('/api/me/dashboard').set(bearer(leader.token));
    expect(dash.body.rank).toBe('Star 1');
    expect(dash.body.team_business).toBe(5000);

    // Re-running the deposit-driven recompute must not double-award.
    const [[cnt]] = await pool.query('SELECT COUNT(*) AS n FROM user_rewards WHERE user_id = ?', [leader.id]);
    expect(cnt.n).toBe(1);
  });
});

describe('authorization', () => {
  test('a member cannot reach an admin route', async () => {
    const u = await register('PlainMember', 'plain@t.com');
    const res = await api.get('/api/admin/reports').set(bearer(u.token));
    expect(res.status).toBe(403);
  });
});
