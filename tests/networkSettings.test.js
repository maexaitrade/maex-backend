const {
  api, resetDb, createAdmin, register, bearer, closePool,
} = require('./helpers');

const TRON_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const BEP_ADDRESS = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const SPL_ADDRESS = '5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY';

let admin;
beforeAll(async () => { await resetDb(); admin = await createAdmin(); });
afterAll(async () => { await closePool(); });

test('admin controls one active network and members must use its address format', async () => {
  const member = await register('Network User', 'network-user@test.local');
  const tronSaved = await api.patch('/api/me/profile').set(bearer(member.token))
    .send({ wallet_address: TRON_ADDRESS });
  expect(tronSaved.status).toBe(200);

  const invalid = await api.patch('/api/admin/deposit-networks/BEP20')
    .set(bearer(admin.token)).send({ address: 'not-a-bep20-address' });
  expect(invalid.status).toBe(400);

  const saved = await api.patch('/api/admin/deposit-networks/BEP20')
    .set(bearer(admin.token)).send({ address: BEP_ADDRESS });
  expect(saved.status).toBe(200);

  const activated = await api.patch('/api/admin/deposit-networks/active')
    .set(bearer(admin.token)).send({ network: 'BEP20' });
  expect(activated.status).toBe(200);
  expect(activated.body.active_network).toBe('BEP20');

  const networks = await api.get('/api/admin/deposit-networks').set(bearer(admin.token));
  expect(networks.body.items.filter((item) => item.active)).toHaveLength(1);

  const publicSettings = await api.get('/api/settings').set(bearer(member.token));
  expect(publicSettings.body.active_crypto_network).toBe('BEP20');
  expect(publicSettings.body.admin_deposit_address).toBe(BEP_ADDRESS);

  const dashboard = await api.get('/api/me/dashboard').set(bearer(member.token));
  expect(dashboard.body.wallet_address_valid).toBe(false);

  const blocked = await api.post('/api/withdrawals').set(bearer(member.token)).send({ amount: 100 });
  expect(blocked.status).toBe(400);

  const updated = await api.patch('/api/me/profile').set(bearer(member.token))
    .send({ wallet_address: BEP_ADDRESS });
  expect(updated.status).toBe(200);
  expect(updated.body.network).toBe('BEP20');

  const deposit = await api.post('/api/deposits').set(bearer(member.token)).send({ amount: 100, tx_hash: 'network-test-tx' });
  expect(deposit.status).toBe(201);

  const list = await api.get('/api/deposits').set(bearer(member.token));
  expect(list.body.items[0].deposit_network).toBe('BEP20');
  expect(list.body.items[0].deposit_address).toBe(BEP_ADDRESS);

  const adminDepositList = await api.get('/api/admin/deposits?status=pending').set(bearer(admin.token));
  expect(adminDepositList.status).toBe(200);
  expect(adminDepositList.body.items.some((item) => item.id === deposit.body.id && item.deposit_network === 'BEP20')).toBe(true);

  const unsupportedVerify = await api.get(`/api/admin/deposits/${deposit.body.id}/verify`).set(bearer(admin.token));
  expect(unsupportedVerify.status).toBe(400);

  const confirmed = await api.patch(`/api/admin/deposits/${deposit.body.id}`)
    .set(bearer(admin.token)).send({ action: 'confirm' });
  expect(confirmed.status).toBe(200);

  const withdrawal = await api.post('/api/withdrawals').set(bearer(member.token)).send({ amount: 20 });
  expect(withdrawal.status).toBe(201);
  expect(withdrawal.body.network).toBe('BEP20');

  const memberWithdrawals = await api.get('/api/withdrawals').set(bearer(member.token));
  expect(memberWithdrawals.status).toBe(200);
  expect(memberWithdrawals.body.items[0].withdrawal_network).toBe('BEP20');

  const adminWithdrawals = await api.get('/api/admin/withdrawals?status=pending').set(bearer(admin.token));
  expect(adminWithdrawals.status).toBe(200);
  expect(adminWithdrawals.body.items[0].withdrawal_network).toBe('BEP20');

  const memberDetail = await api.get(`/api/admin/users/${member.id}`).set(bearer(admin.token));
  expect(memberDetail.status).toBe(200);
  expect(memberDetail.body.deposits[0].deposit_network).toBe('BEP20');
  expect(memberDetail.body.withdrawals[0].withdrawal_network).toBe('BEP20');

  const rejected = await api.patch(`/api/admin/withdrawals/${withdrawal.body.id}`)
    .set(bearer(admin.token)).send({ action: 'reject' });
  expect(rejected.status).toBe(200);

  const splSaved = await api.patch('/api/admin/deposit-networks/SPL')
    .set(bearer(admin.token)).send({ address: SPL_ADDRESS });
  expect(splSaved.status).toBe(200);
  const splActivated = await api.patch('/api/admin/deposit-networks/active')
    .set(bearer(admin.token)).send({ network: 'SPL' });
  expect(splActivated.status).toBe(200);

  const staleBepDashboard = await api.get('/api/me/dashboard').set(bearer(member.token));
  expect(staleBepDashboard.body.wallet_address_valid).toBe(false);
  expect(staleBepDashboard.body.active_crypto_network).toBe('SPL');

  const splProfile = await api.patch('/api/me/profile').set(bearer(member.token))
    .send({ wallet_address: SPL_ADDRESS });
  expect(splProfile.status).toBe(200);
  expect(splProfile.body.network).toBe('SPL');

  const depositAddress = await api.get('/api/deposits/address').set(bearer(member.token));
  expect(depositAddress.status).toBe(200);
  expect(depositAddress.body).toMatchObject({ network: 'SPL', address: SPL_ADDRESS });

  const settings = await api.get('/api/admin/settings').set(bearer(admin.token));
  expect(settings.status).toBe(200);
  expect(settings.body.items.some((item) => item.key === 'active_crypto_network')).toBe(false);
});
