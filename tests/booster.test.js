// Booster bonus tests. Rule: within 15 days of the sponsor's ACCOUNT CREATION,
// 7 direct referrals holding a package >= the sponsor's pays the sponsor 20% of
// their own package, instantly, once (subject to the 2x cap).
const {
  pool, resetDb, createAdmin, register, fund, buy, closePool,
} = require('./helpers');
const { withTransaction } = require('../src/config/db');
const { checkBooster } = require('../src/services/booster.service');

let admin;
beforeAll(async () => { await resetDb(); admin = await createAdmin(); });
afterAll(async () => { await closePool(); });

// register → fund → buy, so the user holds an active package of `amount`.
async function activate(name, email, amount, sponsorId) {
  const u = await register(name, email, sponsorId);
  await fund(u.token, amount, admin.token);
  const res = await buy(u.token, amount);
  if (res.status !== 201) throw new Error(`buy failed: ${JSON.stringify(res.body)}`);
  return u;
}
async function boosterRow(userId) {
  const [[row]] = await pool.query(
    'SELECT directs_count, amount FROM booster_earnings WHERE user_id = ?', [userId]
  );
  return row;
}
async function invId(userId) {
  const [[i]] = await pool.query(
    'SELECT id FROM investments WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]
  );
  return i.id;
}
// Force-run the booster check for a sponsor (used when we control dates directly).
const runCheck = (sponsorId) => withTransaction((conn) => checkBooster(conn, sponsorId));

describe('booster qualification', () => {
  test('7 same-package directs within the window pays 20% instantly, once ($1000 → $200)', async () => {
    const sponsor = await activate('S', 's@bo.com', 1000); // created now
    for (let i = 0; i < 7; i += 1) await activate(`sd${i}`, `sd${i}@bo.com`, 1000, sponsor.id);

    const row = await boosterRow(sponsor.id);
    expect(row).toBeTruthy();
    expect(Number(row.amount)).toBe(200); // 20% of the sponsor's $1000
    expect(row.directs_count).toBeGreaterThanOrEqual(7);

    const [[cnt]] = await pool.query('SELECT COUNT(*) n FROM booster_earnings WHERE user_id = ?', [sponsor.id]);
    expect(Number(cnt.n)).toBe(1); // exactly one payout
  });

  test('directs on a HIGHER package count; reward is 20% of the SPONSOR package', async () => {
    const sponsor = await activate('H', 'h@bo.com', 1000);
    for (let i = 0; i < 7; i += 1) await activate(`hd${i}`, `hd${i}@bo.com`, 2000, sponsor.id);
    expect(Number((await boosterRow(sponsor.id)).amount)).toBe(200); // 20% of 1000, not 2000
  });

  test('a direct on a LOWER package does not count toward the 7', async () => {
    const sponsor = await activate('L', 'l@bo.com', 1000);
    for (let i = 0; i < 6; i += 1) await activate(`ld${i}`, `ld${i}@bo.com`, 1000, sponsor.id); // 6 qualify
    await activate('low', 'low@bo.com', 500, sponsor.id); // 7th is below → doesn't count
    expect(await boosterRow(sponsor.id)).toBeFalsy();
  });

  test('a sponsor with no active package earns no booster', async () => {
    const sponsor = await register('NP', 'np@bo.com'); // never buys a package
    for (let i = 0; i < 7; i += 1) await activate(`npd${i}`, `npd${i}@bo.com`, 1000, sponsor.id);
    expect(await boosterRow(sponsor.id)).toBeFalsy();
  });
});

describe('the 15-day window runs from account creation', () => {
  test('directs acquired after the 15-day window do NOT trigger the booster', async () => {
    const sponsor = await activate('W', 'w@bo.com', 1000);
    // Age the account 20 days so today's direct purchases fall outside the window.
    await pool.query('UPDATE users SET created_at = DATE_SUB(NOW(), INTERVAL 20 DAY) WHERE id = ?', [sponsor.id]);
    for (let i = 0; i < 7; i += 1) await activate(`wd${i}`, `wd${i}@bo.com`, 1000, sponsor.id);
    expect(await boosterRow(sponsor.id)).toBeFalsy();
  });

  test('window boundary: day 15 qualifies, day 16 does not', async () => {
    const sponsor = await activate('B', 'b@bo.com', 1000);
    // Fixed account-creation date; age it into the past so the setup buys (real
    // "now") land outside the window and never pay early.
    await pool.query("UPDATE users SET created_at = '2020-01-01 00:00:00' WHERE id = ?", [sponsor.id]);

    const ids = [];
    for (let i = 0; i < 7; i += 1) {
      const d = await activate(`bd${i}`, `bd${i}@bo.com`, 1000, sponsor.id);
      ids.push(await invId(d.id));
    }
    // 6 directs well inside the window; the 7th one day OVER (Jan 17 = day 16).
    await pool.query("UPDATE investments SET purchased_at = '2020-01-05 00:00:00' WHERE id IN (?)", [ids.slice(0, 6)]);
    await pool.query("UPDATE investments SET purchased_at = '2020-01-17 00:00:00' WHERE id = ?", [ids[6]]);

    expect(await runCheck(sponsor.id)).toBe(0); // only 6 within window
    expect(await boosterRow(sponsor.id)).toBeFalsy();

    // Move the 7th to Jan 16 exactly (created_at + 15 days) — now it qualifies.
    await pool.query("UPDATE investments SET purchased_at = '2020-01-16 00:00:00' WHERE id = ?", [ids[6]]);
    expect(await runCheck(sponsor.id)).toBe(200);
    expect(Number((await boosterRow(sponsor.id)).amount)).toBe(200);
  });
});

describe('payout mechanics', () => {
  test('the booster pays only once even as more directs join', async () => {
    const sponsor = await activate('I', 'i@bo.com', 1000);
    for (let i = 0; i < 7; i += 1) await activate(`id${i}`, `id${i}@bo.com`, 1000, sponsor.id);
    await activate('id7', 'id7@bo.com', 1000, sponsor.id); // 8th direct joins

    const [[cnt]] = await pool.query('SELECT COUNT(*) n FROM booster_earnings WHERE user_id = ?', [sponsor.id]);
    expect(Number(cnt.n)).toBe(1); // still just one booster payout
  });

  test('booster is trimmed so it never exceeds the 2x cap', async () => {
    const sponsor = await activate('C', 'c@bo.com', 1000); // cap 2000
    // Age the account so the setup buys do not pay the booster early; referral
    // income during setup is irrelevant because we set total_earned directly.
    await pool.query('UPDATE users SET created_at = DATE_SUB(NOW(), INTERVAL 20 DAY) WHERE id = ?', [sponsor.id]);

    const ids = [];
    for (let i = 0; i < 7; i += 1) {
      const d = await activate(`cd${i}`, `cd${i}@bo.com`, 1000, sponsor.id);
      ids.push(await invId(d.id));
    }
    // Bring the directs' purchases inside the window (10 days after creation).
    await pool.query('UPDATE investments SET purchased_at = DATE_SUB(NOW(), INTERVAL 10 DAY) WHERE id IN (?)', [ids]);

    // Leave only $100 of cap room; the $200 booster must be trimmed to $100.
    const sInv = await invId(sponsor.id);
    await pool.query('UPDATE investments SET total_earned = 1900 WHERE id = ?', [sInv]);
    await pool.query('UPDATE wallets SET total_earned = 1900 WHERE user_id = ?', [sponsor.id]);

    expect(await runCheck(sponsor.id)).toBe(100); // trimmed
    const [[after]] = await pool.query('SELECT total_earned, status FROM investments WHERE id = ?', [sInv]);
    expect(Number(after.total_earned)).toBe(2000);
    expect(after.status).toBe('capped');
  });
});

describe('who counts toward the 7', () => {
  test('only DIRECT (depth-1) referrals count — deeper downline does not', async () => {
    const sponsor = await activate('DP', 'dp@bo.com', 1000);
    // 6 directs of the sponsor...
    const d0 = await activate('dp0', 'dp0@bo.com', 1000, sponsor.id);
    for (let i = 1; i < 6; i += 1) await activate(`dp${i}`, `dp${i}@bo.com`, 1000, sponsor.id);
    // ...and 3 more people UNDER d0 (depth-2 of the sponsor). They must NOT count.
    for (let i = 0; i < 3; i += 1) await activate(`gp${i}`, `gp${i}@bo.com`, 1000, d0.id);

    // Sponsor has 9 qualifying people in the tree but only 6 are directs.
    expect(await boosterRow(sponsor.id)).toBeFalsy();
  });

  test('a direct who never bought a package does not count', async () => {
    const sponsor = await activate('NoBuy', 'nb@bo.com', 1000);
    for (let i = 0; i < 6; i += 1) await activate(`nbd${i}`, `nbd${i}@bo.com`, 1000, sponsor.id); // 6 qualify
    // A 7th direct signs up and even funds, but never activates a package.
    const idle = await register('idle', 'idle@bo.com', sponsor.id);
    await fund(idle.token, 1000, admin.token);
    expect(await boosterRow(sponsor.id)).toBeFalsy(); // still only 6 qualifying directs
  });

  test('a single direct with two investments is counted once (DISTINCT)', async () => {
    const sponsor = await activate('Dist', 'dist@bo.com', 1000);
    for (let i = 0; i < 5; i += 1) await activate(`dt${i}`, `dt${i}@bo.com`, 1000, sponsor.id); // 5 directs
    // One direct with TWO qualifying investments → 7 investment rows, 6 people.
    const dbl = await register('dbl', 'dbl@bo.com', sponsor.id);
    await fund(dbl.token, 2000, admin.token);
    await buy(dbl.token, 1000);
    await buy(dbl.token, 1000);

    // If directs were counted per-investment this would be 7 and pay; with
    // DISTINCT it is 6 distinct directs → no booster.
    expect(await boosterRow(sponsor.id)).toBeFalsy();
  });

  test('exactly 6 directs pays nothing; the 7th tips it over', async () => {
    const sponsor = await activate('Thr', 'thr@bo.com', 1000);
    for (let i = 0; i < 6; i += 1) await activate(`thd${i}`, `thd${i}@bo.com`, 1000, sponsor.id);
    expect(await boosterRow(sponsor.id)).toBeFalsy(); // 6 → not yet

    await activate('thd6', 'thd6@bo.com', 1000, sponsor.id); // the 7th
    expect(Number((await boosterRow(sponsor.id)).amount)).toBe(200); // now it pays
  });
});
