const { pool } = require('../config/db');

let cache = null;

// Loads all key/value settings into a plain object (cached in memory).
async function getSettings() {
  if (cache) return cache;
  const [rows] = await pool.query('SELECT `key`, `value` FROM settings');
  cache = {};
  for (const r of rows) cache[r.key] = r.value;
  return cache;
}

function clearCache() {
  cache = null;
}

// Convenience typed getters
async function num(key) {
  const s = await getSettings();
  return Number(s[key]);
}

module.exports = { getSettings, clearCache, num };
