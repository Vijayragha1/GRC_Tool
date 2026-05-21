// Email transport for ISMS - Phase 1.
//
// Public surface:
//   sendEmail(opts)              - send + log to email_outbox
//   sendTestEmail(firmId, to)    - one-line test-send for the admin page
//   renderEmailLayout(parts)     - shared HTML scaffold (oxblood + serif)
//   stripHtml(html)              - cheap text fallback when caller didn't supply one
//   getFirmEmailSettings(firmId) - load / lazily-create the firm row
//
// Provider model:
//   - If RESEND_API_KEY is set, sends via Resend's HTTP API (no SDK
//     dependency - we use Node 22's built-in fetch).
//   - Otherwise we land in "dev fallback": writes the email to
//     data/email-dev-outbox.log and marks status='sent' with
//     provider='devnull'. Lets local development work end-to-end without
//     a Resend key, and keeps the outbox audit trail consistent.
//
// From-address resolution (highest priority wins):
//   1. opts.fromOverride                                 (route override)
//   2. firm_email_settings.from_email + .from_name       (per-firm brand)
//   3. EMAIL_FROM_DEFAULT env var                        (deploy default)
//   4. 'ISMS <noreply@isms.local>'                       (last resort)
//
// All sends - success or failure - land in email_outbox so the admin
// page can render an audit trail. status: queued (reserved) | sent | failed.

const fs = require('fs');
const path = require('path');
const { db } = require('../db');

const APP_NAME = 'ISMS';
const DEFAULT_FROM = 'ISMS <noreply@isms.local>';
const DEV_OUTBOX_PATH = path.join(
  path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'iso27001.db')),
  'email-dev-outbox.log'
);

function appBaseUrl() {
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Lazily creates a settings row the first time it's read. Keeping this
// idempotent means routes can blindly call it without an explicit
// "create defaults" step.
function getFirmEmailSettings(firmId) {
  if (!firmId) return null;
  let row = db.prepare('SELECT * FROM firm_email_settings WHERE firm_id=?').get(firmId);
  if (!row) {
    db.prepare(`INSERT INTO firm_email_settings (firm_id, from_name, from_email, reply_to, enabled)
                VALUES (?, NULL, NULL, NULL, 1)`).run(firmId);
    row = db.prepare('SELECT * FROM firm_email_settings WHERE firm_id=?').get(firmId);
  }
  return row;
}

function resolveFrom(firmId, override) {
  if (override) return override;
  const s = firmId ? getFirmEmailSettings(firmId) : null;
  if (s && s.from_email) {
    return s.from_name ? `${s.from_name} <${s.from_email}>` : s.from_email;
  }
  return process.env.EMAIL_FROM_DEFAULT || DEFAULT_FROM;
}

function resolveReplyTo(firmId, override) {
  if (override) return override;
  const s = firmId ? getFirmEmailSettings(firmId) : null;
  return (s && s.reply_to) || null;
}

// Premium-feel HTML scaffold. Inline CSS only - email clients strip
// <style> blocks. Oxblood accent + serif headline matches the in-app
// design language so a CISO opening the email recognises the brand.
function renderEmailLayout({ headline, intro, bodyHtml, ctaText, ctaUrl, footnote, fromName }) {
  const safeHeadline = escapeHtml(headline || APP_NAME);
  const safeFrom = escapeHtml(fromName || APP_NAME);
  const cta = ctaText && ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
         <tr><td style="border-radius:6px;background:#5C0A0A;">
           <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:11px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.01em;">${escapeHtml(ctaText)}</a>
         </td></tr>
       </table>
       <p style="margin:0 0 24px;font-size:12px;line-height:1.5;color:#71717a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">If the button doesn't work, paste this link into your browser:<br><a href="${escapeHtml(ctaUrl)}" style="color:#5C0A0A;word-break:break-all;">${escapeHtml(ctaUrl)}</a></p>`
    : '';
  const introBlock = intro ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${escapeHtml(intro)}</p>` : '';
  const foot = footnote ? `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #ececef;font-size:12px;line-height:1.5;color:#9c9ca5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${footnote}</p>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${safeHeadline}</title></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border:1px solid #ececef;border-radius:8px;">
        <tr><td style="padding:28px 32px 8px;">
          <div style="font-family:Georgia,'Source Serif 4',serif;font-size:13px;font-weight:600;letter-spacing:0.04em;color:#5C0A0A;text-transform:uppercase;">${safeFrom}</div>
        </td></tr>
        <tr><td style="padding:0 32px 28px;">
          <h1 style="margin:8px 0 16px;font-family:Georgia,'Source Serif 4',serif;font-size:22px;font-weight:600;line-height:1.3;color:#0a0a0a;letter-spacing:-0.01em;">${safeHeadline}</h1>
          ${introBlock}
          ${bodyHtml || ''}
          ${cta}
          ${foot}
        </td></tr>
      </table>
      <div style="margin-top:16px;font-size:11px;color:#9c9ca5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">Sent by ${safeFrom} via ${APP_NAME}.</div>
    </td></tr>
  </table>
</body></html>`;
}

// Posts to Resend's HTTP API. Returns { ok, id, error }.
async function postToResend({ from, to, subject, html, text, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not set' };
  const payload = { from, to: Array.isArray(to) ? to : [to], subject, html };
  if (text) payload.text = text;
  if (replyTo) payload.reply_to = replyTo;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: body.message || body.error || `HTTP ${r.status}` };
    }
    return { ok: true, id: body.id || null };
  } catch (e) {
    return { ok: false, error: e.message || 'fetch failed' };
  }
}

// Writes to data/email-dev-outbox.log so local devs can see what would
// have been sent. Best-effort: a write failure shouldn't break the send.
function writeDevOutbox(record) {
  try {
    const line = `\n===== ${new Date().toISOString()} =====\nFROM: ${record.from}\nTO:   ${record.to}\nSUBJ: ${record.subject}\n\n${record.text || stripHtml(record.html)}\n`;
    fs.appendFileSync(DEV_OUTBOX_PATH, line, 'utf8');
  } catch (_) { /* non-fatal */ }
}

// Main entry point. Async because the Resend call is HTTP; callers can
// fire-and-forget if they don't want to block the request. We do still
// always-await the outbox INSERT before returning so the audit row is
// guaranteed to exist when the function resolves.
async function sendEmail({
  to,
  subject,
  html,
  text,
  fromOverride,
  replyToOverride,
  firmId = null,
  workspaceId = null,
  relatedType = null,
  relatedId = null
}) {
  if (!to || !subject) {
    throw new Error('sendEmail: to and subject are required');
  }
  const from = resolveFrom(firmId, fromOverride);
  const replyTo = resolveReplyTo(firmId, replyToOverride);
  const finalText = text || stripHtml(html);
  const finalHtml = html || `<p>${escapeHtml(finalText)}</p>`;

  const hasResend = !!process.env.RESEND_API_KEY;
  let provider, ok, providerId = null, error = null;

  if (hasResend) {
    provider = 'resend';
    const r = await postToResend({ from, to, subject, html: finalHtml, text: finalText, replyTo });
    ok = r.ok;
    providerId = r.id;
    error = r.error || null;
  } else {
    provider = 'devnull';
    ok = true;
    writeDevOutbox({ from, to, subject, html: finalHtml, text: finalText });
  }

  const status = ok ? 'sent' : 'failed';
  const sentAt = ok ? new Date().toISOString() : null;

  const insertId = db.prepare(`INSERT INTO email_outbox
    (firm_id, workspace_id, to_email, from_email, subject, body_html, body_text,
     related_type, related_id, status, provider, provider_message_id, error_message, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    firmId, workspaceId,
    Array.isArray(to) ? to.join(', ') : to,
    from, subject, finalHtml, finalText,
    relatedType, relatedId == null ? null : String(relatedId),
    status, provider, providerId, error, sentAt
  ).lastInsertRowid;

  return { ok, id: insertId, provider, providerId, error };
}

// Convenience for the admin "Send test email" button.
async function sendTestEmail(firmId, to) {
  const baseUrl = appBaseUrl();
  const html = renderEmailLayout({
    headline: 'Email delivery is wired up',
    intro: 'This is a test message from your ISMS. If you can read it, transactional mail (policy approval requests, audit invites, NC assignments) will reach this inbox the same way.',
    bodyHtml: `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">No action needed - this is just a connectivity check.</p>`,
    ctaText: 'Open ISMS',
    ctaUrl: baseUrl,
    footnote: `Provider: ${process.env.RESEND_API_KEY ? 'Resend' : 'dev fallback (no RESEND_API_KEY configured)'}. To change the From address, open Admin → Email.`,
    fromName: 'ISMS'
  });
  return sendEmail({
    to,
    subject: '[ISMS] Test email - delivery is working',
    html,
    firmId,
    relatedType: 'test',
    relatedId: null
  });
}

module.exports = {
  sendEmail,
  sendTestEmail,
  renderEmailLayout,
  getFirmEmailSettings,
  stripHtml,
  escapeHtml,
  appBaseUrl
};
