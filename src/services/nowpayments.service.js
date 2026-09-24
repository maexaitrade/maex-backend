const crypto = require('crypto');

const BASE = 'https://api.nowpayments.io/v1';
const API_KEY = process.env.NOWPAYMENTS_API_KEY;
const IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;

async function npFetch(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || `NOWPayments error ${res.status}`);
  return body;
}

async function createPayment({ amount, orderId, callbackUrl }) {
  return npFetch('/payment', {
    method: 'POST',
    body: JSON.stringify({
      price_amount: amount,
      price_currency: 'usd',
      pay_currency: 'usdttrc20',
      order_id: String(orderId),
      order_description: `Deposit #${orderId}`,
      ipn_callback_url: callbackUrl,
    }),
  });
}

async function getPaymentStatus(paymentId) {
  return npFetch(`/payment/${paymentId}`);
}

function verifyIpn(rawBody, signature) {
  if (!IPN_SECRET) return false;
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { return false; }

  function sortObject(obj) {
    return Object.keys(obj).sort().reduce((acc, key) => {
      acc[key] = obj[key] && typeof obj[key] === 'object' ? sortObject(obj[key]) : obj[key];
      return acc;
    }, {});
  }

  const hmac = crypto.createHmac('sha512', IPN_SECRET);
  hmac.update(JSON.stringify(sortObject(parsed)));
  const expected = hmac.digest('hex');
  return expected === signature;
}

module.exports = { createPayment, getPaymentStatus, verifyIpn };
