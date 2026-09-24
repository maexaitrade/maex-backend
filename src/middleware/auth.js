const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { unauthorized, forbidden } = require('../utils/httpError');

// Verifies the Bearer token and attaches req.user = { id, role }.
function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized('Missing Bearer token'));
  try {
    const payload = jwt.verify(token, env.jwt.secret);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch (_e) {
    next(unauthorized('Invalid or expired token'));
  }
}

// Restricts a route to a given role (e.g. 'admin').
function requireRole(role) {
  return (req, _res, next) => {
    if (!req.user || req.user.role !== role) return next(forbidden());
    next();
  };
}

module.exports = { authenticate, requireRole };
