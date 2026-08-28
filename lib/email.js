// Email transport for Compliance Sphere - Phase 1.
//
// Public surface:
//   sendEmail(opts)              - send + log to email_outbox
//   sendTestEmail(firmId, to)    - one-line test-send for the admin page
//   renderEmailLayout(parts)     - shared HTML scaffold (Compliance Sphere styling)
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
//   4. 'Compliance Sphere <noreply@isms.local>'          (last resort)
//
// All sends - success or failure - land in email_outbox so the admin
// page can render an audit trail. status: queued (reserved) | sent | failed.

const fs = require('fs');
const path = require('path');
const { db } = require('../db');

const APP_NAME = 'Compliance Sphere';
const DEFAULT_FROM = `${APP_NAME} <noreply@isms.local>`;
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
// <style> blocks. Charcoal accent + system-sans on a cream ground mirrors
// the in-app Compliance Sphere design language so a CISO opening the email
// recognises the brand. No serif, no oxblood; font-weights 400/500 only.
function renderEmailLayout({ headline, intro, bodyHtml, ctaText, ctaUrl, footnote, fromName }) {
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,Roboto,Helvetica,Arial,sans-serif";
  const safeHeadline = escapeHtml(headline || APP_NAME);
  const safeFrom = escapeHtml(fromName || APP_NAME);
  // Hidden preview text - controls the snippet shown in the inbox list next to
  // the subject, instead of leaking the first visible characters of the body.
  const preheader = escapeHtml(intro || headline || '');
  const cta = ctaText && ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 4px;">
         <tr><td bgcolor="#1a1a1a" style="border-radius:6px;background:#1a1a1a;">
           <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;letter-spacing:0.01em;">${escapeHtml(ctaText)}</a>
         </td></tr>
       </table>
       <p style="margin:0;font-size:12px;line-height:1.55;color:#8a8a82;font-family:${FONT};">Or paste this link into your browser:<br><a href="${escapeHtml(ctaUrl)}" style="color:#1a1a1a;word-break:break-all;text-decoration:underline;">${escapeHtml(ctaUrl)}</a></p>`
    : '';
  const introBlock = intro ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#2a2a28;font-family:${FONT};">${escapeHtml(intro)}</p>` : '';
  const foot = footnote ? `<p style="margin:28px 0 0;padding-top:20px;border-top:1px solid #ecebe5;font-size:12px;line-height:1.6;color:#9a9a92;font-family:${FONT};">${footnote}</p>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${safeHeadline}</title></head>
<body style="margin:0;padding:0;background:#fafaf8;font-family:${FONT};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:#fafaf8;font-size:1px;line-height:1px;">${preheader}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafaf8;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" bgcolor="#ffffff" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #dcdad2;border-radius:10px;">
        <tr><td style="padding:20px 36px;border-bottom:1px solid #ecebe5;">
          <span style="font-family:${FONT};font-size:15px;font-weight:500;letter-spacing:-0.01em;color:#1a1a1a;">${safeFrom}</span>
        </td></tr>
        <tr><td style="padding:32px 36px 36px;">
          <h1 style="margin:0 0 18px;font-family:${FONT};font-size:22px;font-weight:500;line-height:1.35;color:#1a1a1a;letter-spacing:-0.4px;">${safeHeadline}</h1>
          ${introBlock}
          ${bodyHtml || ''}
          ${cta}
          ${foot}
        </td></tr>
      </table>
      <div style="margin-top:18px;font-size:11px;line-height:1.5;color:#a8a8a0;font-family:${FONT};letter-spacing:0.02em;">Sent by ${safeFrom} via ${APP_NAME}</div>
    </td></tr>
  </table>
</body></html>`;
}

// Posts to Brevo's HTTP API. Free tier is 300/day with no domain verification
// required - only a single sender email needs to be confirmed. Same return
// shape as postToResend so the dispatcher in sendEmail() stays uniform.
async function postToBrevo({ from, to, subject, html, text, replyTo }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY not set' };

  // Brevo expects sender as an object. Force the email to the verified
  // sender; preserve the firm's display name so the recipient still sees a
  // branded From-name. If BREVO_SENDER_EMAIL is unset, fall back to
  // GMAIL_USER (most users use the same address for both) then to whatever
  // came in on `from`.
  const verifiedEmail = process.env.BREVO_SENDER_EMAIL || process.env.GMAIL_USER || null;
  const parsed = parseFromHeader(from);
  const senderEmail = verifiedEmail || parsed.email;
  if (!senderEmail) return { ok: false, error: 'No sender email - set BREVO_SENDER_EMAIL.' };
  const sender = parsed.name
    ? { email: senderEmail, name: parsed.name }
    : { email: senderEmail };

  const toList = (Array.isArray(to) ? to : [to]).map(addr => ({ email: addr }));
  const payload = { sender, to: toList, subject, htmlContent: html };
  if (text) payload.textContent = text;
  if (replyTo) {
    const rp = parseFromHeader(replyTo);
    payload.replyTo = rp.name ? { email: rp.email, name: rp.name } : { email: rp.email };
  }

  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: body.message || body.code || `HTTP ${r.status}` };
    }
    return { ok: true, id: body.messageId || null };
  } catch (e) {
    return { ok: false, error: e.message || 'fetch failed' };
  }
}

// Split "Display Name <addr@x>" → { name, email }. Returns { name: null,
// email: rawEmail } for a bare address. Used by the Brevo and Gmail paths
// to keep the firm's display name while substituting the verified address.
function parseFromHeader(raw) {
  if (!raw) return { name: null, email: null };
  const s = String(raw).trim();
  const m = s.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || null, email: m[2] };
  return { name: null, email: s };
}

// Gmail SMTP transport - lazily built on first use so the dep is only loaded
// when GMAIL_USER + GMAIL_APP_PASSWORD are both set. nodemailer reuses the
// connection pool across sends, so caching this at module scope is fine.
let _gmailTransport = null;
function getGmailTransport() {
  if (_gmailTransport) return _gmailTransport;
  const nodemailer = require('nodemailer');
  _gmailTransport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      // App Password is shown with spaces in Google's UI; SMTP accepts either
      // form but stripping them avoids confusion if someone copy-pastes raw.
      pass: (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '')
    }
  });
  return _gmailTransport;
}

async function postToGmail({ from, to, subject, html, text, replyTo }) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return { ok: false, error: 'GMAIL_USER / GMAIL_APP_PASSWORD not set' };
  }
  try {
    const t = getGmailTransport();
    const info = await t.sendMail({
      // Gmail SMTP requires the From header to match the authenticated user
      // (or an alias verified on the account). If the caller passes a
      // different display name + the same address, that still works. If they
      // pass a totally different address, Gmail will rewrite or reject - so
      // we substitute the authenticated user as a safety net.
      from: forceGmailFrom(from),
      to: Array.isArray(to) ? to.join(', ') : to,
      subject,
      html,
      text,
      replyTo
    });
    return { ok: true, id: info.messageId || null };
  } catch (e) {
    return { ok: false, error: e.message || 'smtp send failed' };
  }
}

// Replace the email part of a "Name <addr@x>" header with the authenticated
// Gmail address. Preserves the display name so the recipient still sees the
// firm's branded From-name. If the input is already just an email, returns
// the Gmail user wrapped in the original input (treated as a name).
function forceGmailFrom(rawFrom) {
  const gmailAddr = process.env.GMAIL_USER;
  if (!rawFrom) return gmailAddr;
  const m = String(rawFrom).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m && m[1]) return `${m[1]} <${gmailAddr}>`;
  // Bare email or no angle-brackets - fall back to just the Gmail address.
  return gmailAddr;
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

  // Provider priority: Brevo → Gmail SMTP → Resend → dev-log fallback.
  // Brevo wins when its API key is set because it has the best free-tier
  // ergonomics (real delivery, no domain verification, no SMTP auth dance).
  // Unset BREVO_API_KEY to fall back to Gmail or Resend without code edits.
  const deliveryDisabled = process.env.EMAIL_DELIVERY_DISABLED === '1';
  const hasBrevo  = !deliveryDisabled && !!process.env.BREVO_API_KEY;
  const hasGmail  = !deliveryDisabled && !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
  const hasResend = !deliveryDisabled && !!process.env.RESEND_API_KEY;
  let provider, ok, providerId = null, error = null;

  if (deliveryDisabled) {
    provider = 'disabled';
    ok = true;
  } else if (hasBrevo) {
    provider = 'brevo';
    const r = await postToBrevo({ from, to, subject, html: finalHtml, text: finalText, replyTo });
    ok = r.ok;
    providerId = r.id;
    error = r.error || null;
  } else if (hasGmail) {
    provider = 'gmail';
    const r = await postToGmail({ from, to, subject, html: finalHtml, text: finalText, replyTo });
    ok = r.ok;
    providerId = r.id;
    error = r.error || null;
  } else if (hasResend) {
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
    intro: `This is a test message from ${APP_NAME}. If you can read it, transactional mail (policy approval requests, audit invites, NC assignments) will reach this inbox the same way.`,
    bodyHtml: `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">No action needed - this is just a connectivity check.</p>`,
    ctaText: `Open ${APP_NAME}`,
    ctaUrl: baseUrl,
    footnote: `Provider: ${process.env.RESEND_API_KEY ? 'Resend' : 'dev fallback (no RESEND_API_KEY configured)'}. To change the From address, open Admin → Email.`,
    fromName: APP_NAME
  });
  return sendEmail({
    to,
    subject: `[${APP_NAME}] Test email - delivery is working`,
    html,
    firmId,
    relatedType: 'test',
    relatedId: null
  });
}

// Magic-link approval email - sent to external approvers when a doc
// is submitted for review (or when an internal approver decides and
// the next slot is external). The token is in the URL; the email
// itself never round-trips the token through any other surface.
async function sendMagicLinkApprovalEmail({
  toEmail, toName, docName, docVersion, workspaceName,
  workspaceId, firmId, submitterName, token, sequence,
  totalApprovers, roleLabel, expiresAt, changeSummary, relatedDocId
}) {
  const baseUrl = appBaseUrl();
  const approveUrl = `${baseUrl}/approve/${token}`;
  const greeting = toName ? `Hi ${toName},` : 'Hi,';
  const seqLine = totalApprovers > 1
    ? `You are approver #${sequence} of ${totalApprovers} in the chain.`
    : 'You are the sole approver on this document.';
  const expiryStr = new Date(expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;"><strong>${escapeHtml(submitterName || 'The ISMS team')}</strong> at <strong>${escapeHtml(workspaceName)}</strong> is asking for your approval on a policy document. ${escapeHtml(seqLine)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;border:1px solid #ecebe5;border-radius:6px;background:#fafaf8;">
      <tr><td style="padding:14px 18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,Arial,sans-serif;">
        <div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#9c9ca5;margin-bottom:6px;">Document</div>
        <div style="font-size:15px;font-weight:500;color:#1a1a1a;margin-bottom:6px;">${escapeHtml(docName)} <span style="color:#9c9ca5;font-weight:400;">· v${docVersion}</span></div>
        ${roleLabel ? `<div style="font-size:12px;color:#71717a;margin-bottom:8px;">Acting as: ${escapeHtml(roleLabel)}</div>` : ''}
        ${changeSummary ? `<div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#9c9ca5;margin:10px 0 4px;">Summary of changes</div><div style="font-size:13px;line-height:1.55;color:#51525c;">${escapeHtml(changeSummary)}</div>` : ''}
      </td></tr>
    </table>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">Click the button below to review the full document and approve or reject it. You don't need an account - the link itself is your credential.</p>`;

  const footnote = `This link is unique to you and expires on <strong>${escapeHtml(expiryStr)}</strong>. Treat it like a password - anyone who has it can decide on your behalf. Your decision is recorded with the IP address and time, and shows up on the document's audit trail.`;

  return sendEmail({
    to: toEmail,
    subject: `[${workspaceName}] Approval requested: ${docName} (v${docVersion})`,
    html: renderEmailLayout({
      headline: 'A document is ready for your approval',
      bodyHtml,
      ctaText: 'Review and decide',
      ctaUrl: approveUrl,
      footnote,
      fromName: workspaceName
    }),
    firmId,
    workspaceId,
    relatedType: 'doc_approval_magic_link',
    relatedId: relatedDocId
  });
}

// External supplier questionnaire email - sent to a vendor contact when a
// consultant shares a questionnaire from the engagement. The token in the URL
// is the credential: the vendor completes the questionnaire without an account
// and never sees the rest of the tool. Visually identical to the magic-link
// approval mail (same renderEmailLayout, same "the link is your credential"
// framing), and "from" the engagement/client brand rather than the firm.
async function sendSupplierQuestionnaireEmail({
  toEmail, toName, supplierName, templateName, templateDescription,
  questionCount, workspaceName, workspaceId, firmId, token, expiresAt, questionnaireId,
  startUrlOverride = null
}) {
  const baseUrl = appBaseUrl();
  const startUrl = startUrlOverride || `${baseUrl}/q/${token}`;
  const greeting = toName ? `Hi ${toName},` : 'Hi,';
  const countLine = questionCount
    ? questionCount > 60
      ? `It contains ${questionCount} scoped questions. You can save progress and return to complete it in stages.`
      : `It has ${questionCount} question${questionCount === 1 ? '' : 's'} and usually takes just a few minutes.`
    : 'It should only take a few minutes.';

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">As part of an ongoing third-party review, <strong>${escapeHtml(workspaceName)}</strong> has asked <strong>${escapeHtml(supplierName)}</strong> to complete a due-diligence questionnaire. ${escapeHtml(countLine)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;border:1px solid #ecebe5;border-radius:6px;background:#fafaf8;">
      <tr><td style="padding:14px 18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,Arial,sans-serif;">
        <div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#9c9ca5;margin-bottom:6px;">Questionnaire</div>
        <div style="font-size:15px;font-weight:500;color:#1a1a1a;margin-bottom:6px;">${escapeHtml(templateName)}</div>
        ${templateDescription ? `<div style="font-size:13px;line-height:1.55;color:#51525c;">${escapeHtml(templateDescription)}</div>` : ''}
      </td></tr>
    </table>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">Click the button below to open it. You don't need an account - the link itself is your secure access. Your answers save as you go, so you can submit when you're ready.</p>`;

  const expiryStr = expiresAt ? new Date(expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const footnote = expiryStr
    ? `This link is unique to ${escapeHtml(supplierName)} and expires on <strong>${escapeHtml(expiryStr)}</strong>. Please don't forward it - anyone who has it can submit on your behalf.`
    : `This link is unique to ${escapeHtml(supplierName)}. Please don't forward it - anyone who has it can submit on your behalf.`;

  return sendEmail({
    to: toEmail,
    subject: `[${workspaceName}] Security questionnaire: ${supplierName}`,
    html: renderEmailLayout({
      headline: 'A security questionnaire is ready for you',
      bodyHtml,
      ctaText: 'Start the questionnaire',
      ctaUrl: startUrl,
      footnote,
      fromName: workspaceName
    }),
    firmId,
    workspaceId,
    relatedType: 'supplier_questionnaire',
    relatedId: questionnaireId || null
  });
}

// Password-reset email. Token is the raw 32-byte hex value (the hashed form
// lives in the DB only). Link expires after the configured TTL (default 1h)
// and is single-use server-side. Same renderEmailLayout as everything else
// so the visual identity matches the magic-link approval mail.
async function sendPasswordResetEmail({ toEmail, toName, token, expiresAt, firmId = null }) {
  const baseUrl = appBaseUrl();
  const resetUrl = `${baseUrl}/reset/${token}`;
  const greeting = toName ? `Hi ${toName},` : 'Hi,';
  const expiryStr = new Date(expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">We received a request to reset the password on your ${APP_NAME} account (<strong>${escapeHtml(toEmail)}</strong>). Use the button below to choose a new one.</p>
    <p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:#71717a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">If you didn't ask for this, you can safely ignore the message - your existing password stays valid.</p>`;

  const footnote = `This link is single-use and expires on <strong>${escapeHtml(expiryStr)}</strong>. If it expires before you use it, request another reset from the sign-in page.`;

  return sendEmail({
    to: toEmail,
    subject: `[${APP_NAME}] Reset your password`,
    html: renderEmailLayout({
      headline: 'Reset your password',
      bodyHtml,
      ctaText: 'Choose a new password',
      ctaUrl: resetUrl,
      footnote,
      fromName: APP_NAME
    }),
    firmId,
    relatedType: 'password_reset',
    relatedId: null
  });
}

// Invitation email (Phase 3). Inviter is the person who created the invite;
// firmName is the firm the new user is joining; the link lands on a set-
// password form that consumes the token and creates the session.
async function sendInviteEmail({ toEmail, toName, inviterName, firmName, role, token, expiresAt, firmId = null }) {
  const baseUrl = appBaseUrl();
  const acceptUrl = `${baseUrl}/invite/${token}`;
  const greeting = toName ? `Hi ${toName},` : 'Hi,';
  const expiryStr = new Date(expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const roleLine = role ? ` as a <strong>${escapeHtml(role)}</strong>` : '';

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;"><strong>${escapeHtml(inviterName || 'A teammate')}</strong> has invited you to join <strong>${escapeHtml(firmName || APP_NAME)}</strong>${roleLine}. Click the button below to set your password and sign in.</p>`;

  const footnote = `This invitation is single-use and expires on <strong>${escapeHtml(expiryStr)}</strong>. If it expires, ask the person who invited you for a new link.`;

  return sendEmail({
    to: toEmail,
    subject: `[${APP_NAME}] You're invited to join ${firmName || APP_NAME}`,
    html: renderEmailLayout({
      headline: 'You\'re invited',
      bodyHtml,
      ctaText: 'Accept invitation',
      ctaUrl: acceptUrl,
      footnote,
      fromName: firmName || APP_NAME
    }),
    firmId,
    relatedType: 'user_invite',
    relatedId: null
  });
}

// In-app notification mirrored to email. Called by the notify()->email bridge
// in lib/jobs.js for recipients whose email_notify preference is 'immediate'.
// The email body is the notification's own text; the CTA deep-links straight to
// the in-app item so the inbox and the inbox-by-email never disagree.
async function sendNotificationEmail({
  toEmail, toName, title, body, link, workspaceName,
  firmId = null, workspaceId = null, category = null
}) {
  const baseUrl = appBaseUrl();
  const ctaUrl = link ? (/^https?:\/\//i.test(link) ? link : baseUrl + link) : null;
  const greeting = toName ? `Hi ${toName},` : 'Hi,';
  const ctx = workspaceName
    ? `This relates to <strong>${escapeHtml(workspaceName)}</strong>.`
    : `This is an update from ${APP_NAME}.`;

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${escapeHtml(greeting)}</p>
    ${body ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${escapeHtml(body)}</p>` : ''}
    <p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:#71717a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${ctx}</p>`;

  return sendEmail({
    to: toEmail,
    subject: workspaceName ? `[${workspaceName}] ${title}` : `[${APP_NAME}] ${title}`,
    html: renderEmailLayout({
      headline: title,
      bodyHtml,
      ctaText: ctaUrl ? `Open in ${APP_NAME}` : null,
      ctaUrl,
      footnote: `You're getting this because email notifications are on for your account. Turn them off anytime from your inbox in the app.`,
      fromName: workspaceName || APP_NAME
    }),
    firmId,
    workspaceId,
    relatedType: category ? `notification:${category}` : 'notification',
    relatedId: null
  });
}

// Returns the active provider as it would be picked by sendEmail() given the
// current environment. Used by /admin/email to render an honest status badge
// instead of hard-coding Resend. Mirrors the priority list in sendEmail().
function currentProvider() {
  if (process.env.BREVO_API_KEY) return 'brevo';
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) return 'gmail';
  if (process.env.RESEND_API_KEY) return 'resend';
  return 'devnull';
}

module.exports = {
  sendEmail,
  sendTestEmail,
  sendMagicLinkApprovalEmail,
  sendSupplierQuestionnaireEmail,
  sendPasswordResetEmail,
  sendInviteEmail,
  sendNotificationEmail,
  renderEmailLayout,
  getFirmEmailSettings,
  currentProvider,
  stripHtml,
  escapeHtml,
  appBaseUrl
};
