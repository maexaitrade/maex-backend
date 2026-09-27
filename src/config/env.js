require('dotenv').config();

function required(name, fallback) {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

module.exports = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'maex_trade',
  },
  jwt: {
    secret: required('JWT_SECRET', 'dev-insecure-secret-change-me'),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  // Secret key that must be supplied to create an admin via the setup endpoint.
  // Set a long random value in .env; if unset, the endpoint is disabled entirely.
  adminSetupKey: process.env.ADMIN_SETUP_KEY || '',

  // Transactional email (Resend). If resendApiKey is empty, email sending is
  // skipped (logged instead) so local dev works without a key.
  email: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    from: process.env.MAIL_FROM || 'MAEX Trade <onboarding@resend.dev>',
  },
  // Public frontend base URL used to build links in emails (verify, reset).
  webUrl: process.env.WEB_URL || process.env.APP_URL || 'http://localhost:5173',
  cron: {
    enabled: (process.env.ENABLE_CRON || 'false') === 'true',
    roiHour: parseInt(process.env.ROI_CRON_HOUR || '1', 10),
  },
  deposit: {
    // How long a NOWPayments deposit stays payable before it is marked expired.
    validHours: parseInt(process.env.DEPOSIT_VALID_HOURS || '2', 10),
  },
};
