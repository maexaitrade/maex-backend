// Runs before any test module is imported.
// Forces tests onto an isolated database so real/dev data is never touched.
// Set BEFORE dotenv runs (dotenv does not override existing process.env).
process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'maex_trade_test';
process.env.ENABLE_CRON = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
