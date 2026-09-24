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
  cron: {
    enabled: (process.env.ENABLE_CRON || 'false') === 'true',
    roiHour: parseInt(process.env.ROI_CRON_HOUR || '1', 10),
  },
  deposit: {
    // How long a NOWPayments deposit stays payable before it is marked expired.
    validHours: parseInt(process.env.DEPOSIT_VALID_HOURS || '2', 10),
  },
};
