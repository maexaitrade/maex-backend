// TRON (TRC-20) address validation via full base58check + checksum — not just a
// regex — so typo'd addresses (bad checksum) are rejected, not just malformed ones.
const crypto = require('crypto');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = {};
for (let i = 0; i < ALPHABET.length; i += 1) ALPHABET_MAP[ALPHABET[i]] = i;

function base58Decode(str) {
  let num = 0n;
  for (const ch of str) {
    const val = ALPHABET_MAP[ch];
    if (val === undefined) return null; // char outside the base58 alphabet
    num = num * 58n + BigInt(val);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  // Leading '1' chars encode leading zero bytes.
  let leading = 0;
  for (const ch of str) { if (ch === '1') leading += 1; else break; }
  if (leading) bytes = Buffer.concat([Buffer.alloc(leading), bytes]);
  return bytes;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

/**
 * True only for a valid TRON mainnet address: base58, 34 chars, 'T' prefix
 * (0x41 version byte) and a correct 4-byte double-SHA256 checksum.
 */
function isTronAddress(addr) {
  if (typeof addr !== 'string') return false;
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) return false; // quick format gate
  const decoded = base58Decode(addr);
  if (!decoded || decoded.length !== 25) return false;
  if (decoded[0] !== 0x41) return false; // TRON mainnet version byte
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21, 25);
  return sha256(sha256(payload)).subarray(0, 4).equals(checksum);
}

module.exports = { isTronAddress };
