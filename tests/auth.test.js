const { api, pool, resetDb, register, bearer, closePool } = require('./helpers');

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await closePool(); });

describe('auth + genealogy', () => {
  test('register returns a token and creates a wallet', async () => {
    const res = await api.post('/api/auth/register').send({
      name: 'Root', email: 'root@t.com', password: 'secret1',
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe('member');

    const [[w]] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [res.body.user.id]);
    expect(Number(w.balance)).toBe(0);
  });

  test('duplicate email is rejected', async () => {
    const res = await api.post('/api/auth/register').send({
      name: 'Dup', email: 'root@t.com', password: 'secret1',
    });
    expect(res.status).toBe(400);
  });

  test('short password is rejected', async () => {
    const res = await api.post('/api/auth/register').send({
      name: 'X', email: 'x@t.com', password: '123',
    });
    expect(res.status).toBe(400);
  });

  test('login with wrong password fails, correct succeeds', async () => {
    const bad = await api.post('/api/auth/login').send({ email: 'root@t.com', password: 'nope' });
    expect(bad.status).toBe(401);
    const ok = await api.post('/api/auth/login').send({ email: 'root@t.com', password: 'secret1' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
  });

  test('sponsor chain builds a correct closure tree (levels 1-3)', async () => {
    // root(existing) -> a -> b -> c
    const a = await register('A', 'a@t.com');
    const b = await register('B', 'b@t.com', a.id);
    const c = await register('C', 'c@t.com', b.id);

    // a's team endpoint should show b at level1 and c at level2
    const team = await api.get('/api/me/team').set(bearer(a.token));
    expect(team.status).toBe(200);
    expect(team.body.counts.level1).toBe(1);
    expect(team.body.counts.level2).toBe(1);

    // genealogy depths from a's perspective
    const [rows] = await pool.query(
      'SELECT descendant_id, depth FROM genealogy WHERE ancestor_id = ? ORDER BY depth',
      [a.id]
    );
    const byId = Object.fromEntries(rows.map((r) => [r.descendant_id, r.depth]));
    expect(byId[a.id]).toBe(0);
    expect(byId[b.id]).toBe(1);
    expect(byId[c.id]).toBe(2);
  });

  test('protected route without token is 401', async () => {
    const res = await api.get('/api/me/dashboard');
    expect(res.status).toBe(401);
  });
});
