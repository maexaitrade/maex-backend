const BASE = 'https://api.trongrid.io';

function hexToBase58(hex) {
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  const crypto = require('crypto');
  const sha1 = crypto.createHash('sha256').update(bytes).digest();
  const sha2 = crypto.createHash('sha256').update(sha1).digest();
  const checksum = sha2.subarray(0, 4);
  const payload = Buffer.concat([bytes, checksum]);
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt('0x' + payload.toString('hex'));
  let encoded = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    encoded = ALPHABET[rem] + encoded;
    num = num / 58n;
  }
  for (const b of payload) { if (b === 0) encoded = '1' + encoded; else break; }
  return encoded;
}

async function verifyTransaction(txHash) {
  try {
    const res = await fetch(`${BASE}/v1/transactions/${txHash}/events`);
    if (!res.ok) return { valid: false, error: `TronGrid returned ${res.status}` };

    const body = await res.json();
    if (!body.data || body.data.length === 0) {
      return { valid: false, error: 'Transaction not found or has no events' };
    }

    const transfer = body.data.find(
      (e) => e.event_name === 'Transfer' && e.contract_address === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    );

    if (!transfer) {
      return { valid: false, error: 'No USDT TRC-20 transfer found in this transaction' };
    }

    const { result } = transfer;
    const from = hexToBase58('41' + result.from.replace(/^0x/, ''));
    const to = hexToBase58('41' + result.to.replace(/^0x/, ''));
    const amount = Number(BigInt(result.value)) / 1e6;

    return {
      valid: true,
      from,
      to,
      amount,
      timestamp: transfer.block_timestamp,
      block: transfer.block_number,
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

module.exports = { verifyTransaction };
