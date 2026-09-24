const env = require('../config/env');

// Wraps async route handlers so thrown errors reach the error middleware.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Central error handler.
function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(err);
  }
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(env.nodeEnv === 'development' && status >= 500 ? { stack: err.stack } : {}),
  });
}

function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Route not found' });
}

module.exports = { asyncHandler, errorHandler, notFoundHandler };
