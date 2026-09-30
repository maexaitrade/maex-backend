jest.mock('resend', () => ({ Resend: jest.fn() }));
jest.mock('../src/config/env', () => ({
  nodeEnv: 'test',
  email: { resendApiKey: 're_test_placeholder', from: 'MAEX Trade <sender@example.com>' },
}));

const { Resend } = require('resend');
const env = require('../src/config/env');

afterEach(() => {
  env.nodeEnv = 'test';
  jest.clearAllMocks();
});

test('OTP and reset emails never reach Resend in test mode, even with a configured key', async () => {
  let mailer;
  jest.isolateModules(() => { mailer = require('../src/services/email.service'); });

  await expect(mailer.sendOtp({
    to: 'network-user@test.local', name: 'Test User', email: 'network-user@test.local', otp: '123456',
  })).resolves.toEqual({ skipped: true });
  await expect(mailer.sendReset({
    to: 'network-user@test.local', name: 'Test User', resetUrl: 'https://example.com/reset',
  })).resolves.toEqual({ skipped: true });
  expect(Resend).not.toHaveBeenCalled();
});

test('production still sends through Resend', async () => {
  env.nodeEnv = 'production';
  const send = jest.fn().mockResolvedValue({ data: { id: 'email-id' }, error: null });
  Resend.mockImplementation(() => ({ emails: { send } }));
  let mailer;
  jest.isolateModules(() => { mailer = require('../src/services/email.service'); });

  const message = { to: 'recipient@example.com', subject: 'Test', html: '<p>Test</p>' };
  await expect(mailer.send(message)).resolves.toEqual({ id: 'email-id' });
  expect(send).toHaveBeenCalledWith({ from: env.email.from, ...message });
});
