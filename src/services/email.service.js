const { Resend } = require('resend');
const env = require('../config/env');

// Tests load the same .env as development; never use its live email credentials.
const isTest = env.nodeEnv === 'test';
const resend = !isTest && env.email.resendApiKey ? new Resend(env.email.resendApiKey) : null;

// Low-level send. If no API key is configured, log and no-op so local dev and
// tests never crash on a missing key. Never throws to the caller — a failed
// email must not fail the user's action (register / reset).
async function send({ to, subject, html }) {
  if (isTest) return { skipped: true };
  if (!resend) {
    console.log(`[email] (skipped, no RESEND_API_KEY) -> ${to}: ${subject}`);
    return { skipped: true };
  }
  try {
    const { data, error } = await resend.emails.send({ from: env.email.from, to, subject, html });
    if (error) { console.error('[email] send error:', error); return { error }; }
    return { id: data?.id };
  } catch (err) {
    console.error('[email] send threw:', err.message);
    return { error: err.message };
  }
}

// ---- Shared shell (dark theme, lime accent, inline styles for mail clients) --
function shell(inner) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#000;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000;padding:32px 0;font-family:Arial,Helvetica,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#0b0d08;border:1px solid rgba(163,230,53,0.25);border-radius:16px;overflow:hidden;">
        <tr><td style="padding:26px 28px 6px;">
          <span style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;background:#a3e635;color:#0a1400;font-weight:800;font-size:18px;border-radius:9px;">M</span>
          <span style="color:#eef3e6;font-weight:800;font-size:18px;vertical-align:middle;margin-left:10px;">MAEX&nbsp;TRADE</span>
        </td></tr>
        <tr><td style="padding:14px 28px 30px;">${inner}</td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid rgba(255,255,255,0.07);">
          <p style="color:#5f6857;font-size:11px;line-height:1.6;margin:0;">You are receiving this because an account action was requested on MAEX Trade. If this wasn't you, you can ignore this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function btn(href, label) {
  return `<a href="${href}" style="display:inline-block;background:#a3e635;color:#0a1400;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:10px;font-size:14px;">${label}</a>`;
}

// ---- Templates -------------------------------------------------------------

// OTP verification email. Sent before the account is created — the member must
// enter this code to activate the account. Also carries their chosen login
// credentials (per project choice).
async function sendOtp({ to, name, email, password, otp }) {
  const showCreds = password && password !== '(unchanged)';
  const creds = showCreds ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,0.04);border:1px solid rgba(163,230,53,0.16);border-radius:12px;margin:0 0 8px;">
      <tr><td style="padding:14px 16px;">
        <p style="margin:0 0 8px;color:#5f6857;font-size:11px;text-transform:uppercase;letter-spacing:.12em;">Your login details</p>
        <p style="margin:0 0 4px;color:#eef3e6;font-size:14px;">Email: <b>${escapeHtml(email)}</b></p>
        <p style="margin:0;color:#eef3e6;font-size:14px;">Password: <b>${escapeHtml(password)}</b></p>
      </td></tr>
    </table>` : '';
  const inner = `
    <h1 style="color:#eef3e6;font-size:22px;margin:0 0 6px;">Verify your email, ${escapeHtml(name)} 👋</h1>
    <p style="color:#8b937f;font-size:14px;line-height:1.6;margin:0 0 18px;">Use the code below to activate your MAEX Trade account. This code is valid for 10 minutes.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr><td align="center" style="background:rgba(163,230,53,0.08);border:1px solid rgba(163,230,53,0.3);border-radius:12px;padding:18px;">
        <div style="color:#a3e635;font-size:34px;font-weight:800;letter-spacing:8px;font-family:monospace;">${escapeHtml(otp)}</div>
      </td></tr>
    </table>
    ${creds}
    <p style="color:#5f6857;font-size:12px;line-height:1.6;margin:14px 0 0;">Didn't try to sign up? You can safely ignore this email — no account is created until the code is entered.</p>`;
  return send({ to, subject: `${otp} is your MAEX Trade verification code`, html: shell(inner) });
}

// Password reset link.
async function sendReset({ to, name, resetUrl }) {
  const inner = `
    <h1 style="color:#eef3e6;font-size:22px;margin:0 0 6px;">Reset your password</h1>
    <p style="color:#8b937f;font-size:14px;line-height:1.6;margin:0 0 18px;">Hi ${escapeHtml(name || 'there')}, we received a request to reset your MAEX Trade password. This link is valid for 1 hour.</p>
    <p style="text-align:center;margin:0 0 18px;">${btn(resetUrl, 'Reset Password')}</p>
    <p style="color:#5f6857;font-size:12px;line-height:1.6;margin:0;">Or paste this link in your browser:<br><a href="${resetUrl}" style="color:#a3e635;word-break:break-all;">${resetUrl}</a><br><br>If you didn't request this, ignore this email — your password stays unchanged.</p>`;
  return send({ to, subject: 'Reset your MAEX Trade password', html: shell(inner) });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { send, sendOtp, sendReset };
