'use strict';
// Auth + user administration routes. Slice 3 of the server.js modularization
// (register(app, deps) pattern, see routes/tenants.js).
//
// Routes: / (root redirect), login, logout, register (disabled), forgot,
// reset, invite accept, and the /admin/users management surface.
// Exports hashToken + INVITE_TTL_MS: the team-setup invite flow in server.js
// reuses the same token scheme.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rbac = require('../lib/rbac');
const frameworks = require('../lib/frameworks');
const { auditCtx, withToast, escapeHtml } = require('../lib/http-helpers');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

function register(app, deps) {
  const { db, requireAuth, logAction } = deps;

  // Session-cookie login. Default session is the 7-day cookie configured on
  // session(); the "remember me" path extends to 30d on success and a non-
  // remember login is shortened to an 8h cookie so a shared browser doesn't
  // leave the next user logged in to whatever yesterday's session was.
  const SESSION_DEFAULT_MAX_AGE  = 1000 * 60 * 60 * 8;       // 8 hours
  const SESSION_REMEMBER_MAX_AGE = 1000 * 60 * 60 * 24 * 30; // 30 days

  // Login throttle on hot misses. Uses an in-process Map keyed by lower-cased
  // email; capped at 8 failures over a 15-minute window. Process-restart wipes
  // it, which is acceptable for a single-server deployment and is the right
  // trade-off given the user explicitly skipped brute-force protection in scope.
  const LOGIN_BAD = new Map(); // email -> { count, firstAt }
  const LOGIN_BAD_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_BAD_LIMIT = 8;
  function recordBadLogin(email) {
    const key = (email || '').toLowerCase();
    const now = Date.now();
    const rec = LOGIN_BAD.get(key);
    if (!rec || (now - rec.firstAt) > LOGIN_BAD_WINDOW_MS) {
      LOGIN_BAD.set(key, { count: 1, firstAt: now });
    } else {
      rec.count++;
    }
  }
  function isLockedOut(email) {
    const rec = LOGIN_BAD.get((email || '').toLowerCase());
    if (!rec) return false;
    if ((Date.now() - rec.firstAt) > LOGIN_BAD_WINDOW_MS) { LOGIN_BAD.delete((email||'').toLowerCase()); return false; }
    return rec.count >= LOGIN_BAD_LIMIT;
  }
  function clearBadLogin(email) { LOGIN_BAD.delete((email || '').toLowerCase()); }

  function validPublicEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    if (/@(?:example\.(?:com|org|net)|isms\.local)$/i.test(email)) return null;
    return email;
  }

  function publicContactDetails() {
    let contactEmail = validPublicEmail(process.env.EVALUATION_CONTACT_EMAIL);
    if (!contactEmail) {
      try {
        const configured = db.prepare(`SELECT COALESCE(reply_to,from_email) email
          FROM firm_email_settings
          WHERE enabled=1 AND COALESCE(reply_to,from_email) IS NOT NULL
          ORDER BY firm_id LIMIT 1`).get();
        contactEmail = validPublicEmail(configured && configured.email);
      } catch (_) {}
    }
    const securityEmail = validPublicEmail(process.env.SECURITY_CONTACT_EMAIL) || contactEmail;
    const configuredUrl = String(process.env.EVALUATION_REQUEST_URL || '').trim();
    const evaluationUrl = /^https:\/\/[^\s]+$/i.test(configuredUrl) ? configuredUrl : '/contact';
    return { contactEmail, securityEmail, evaluationUrl };
  }

  function renderPublic(req, res, page, extra = {}) {
    const pages = {
      home: ['Evaluate Compliance Sphere', 'Evidence-backed GRC delivery for consulting firms and client teams.'],
      access: ['Request access', 'Access is invite-only so every account starts in an explicitly assigned firm or client workspace.'],
      security: ['Security', 'How the product protects access, governed records, uploads, and external sharing.'],
      privacy: ['Privacy', 'What this site processes and which responsibilities belong to the organization operating it.'],
      terms: ['Terms of use', 'Plain-language conditions for evaluating and using this software.'],
      contact: ['Request an evaluation', 'Choose the next step without creating an unscoped account.']
    };
    const [title, description] = pages[page] || pages.home;
    return res.render('auth/public', {
      page, title, description, ...publicContactDetails(),
      topic: ['evaluation','security','privacy'].includes(String(req.query.topic || '')) ? String(req.query.topic) : 'evaluation',
      ...extra
    });
  }

  // The public programme register is built from the framework registry rather
  // than typed into the view, which is how it fell three behind: the page still
  // advertised three standards after DPDPA shipped. Counts are the size of each
  // catalogue as loaded, so the page cannot claim a number the product does not
  // hold.
  const PROGRAMME_UNITS = Object.freeze({
    iso27001: 'requirements',
    iso42001: 'requirements',
    csf: 'outcomes',
    dpdpa: 'obligations',
  });

  function programmeRegister() {
    return frameworks.FRAMEWORK_LIST.map((f) => ({
      code: f.tagLabel,
      formalName: f.formalName,
      descriptor: f.descriptor,
      count: frameworks.catalogueSize(f.code),
      unit: PROGRAMME_UNITS[f.code] || 'requirements',
    })).filter((p) => p.count > 0);
  }

  app.get('/', (req, res) => {
    if (req.session && req.session.userId) return res.redirect('/dashboard');
    return renderPublic(req, res, 'home', { programmes: programmeRegister() });
  });

  app.get('/security', (req, res) => renderPublic(req, res, 'security'));
  app.get('/privacy', (req, res) => renderPublic(req, res, 'privacy'));
  app.get('/terms', (req, res) => renderPublic(req, res, 'terms'));
  app.get('/contact', (req, res) => renderPublic(req, res, 'contact'));
  app.get('/.well-known/security.txt', (req, res) => {
    const { securityEmail } = publicContactDetails();
    const configuredBase = /^https:\/\/[^\s]+$/i.test(String(process.env.APP_BASE_URL || ''))
      ? String(process.env.APP_BASE_URL).replace(/\/+$/, '')
      : `${req.protocol}://${String(req.get('host') || 'localhost').replace(/[^a-z0-9.:[\]-]/gi, '')}`;
    const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const contacts = [securityEmail ? `Contact: mailto:${securityEmail}` : null, `Contact: ${configuredBase}/contact?topic=security`]
      .filter(Boolean).join('\n');
    res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(
      `${contacts}\nExpires: ${expires}\nPolicy: ${configuredBase}/security\nPreferred-Languages: en\n`);
  });

  app.get('/login', (req, res) => {
    if (req.session && req.session.userId) return res.redirect(typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/dashboard');
    res.render('auth/login', {
      error: null,
      notice: req.query.signed_out ? 'You have been signed out.' : (req.query.reset_ok ? 'Password updated. Sign in to continue.' : null),
      next_url: typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '',
      prefillEmail: '',
      csrfToken: res.locals.csrfToken
    });
  });

  app.post('/login', (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const remember = !!(req.body && req.body.remember);
    const nextUrl = (typeof req.body.next === 'string' && req.body.next.startsWith('/')) ? req.body.next : '/dashboard';

    const renderFail = (msg) => res.status(401).render('auth/login', {
      error: msg, notice: null, next_url: nextUrl === '/dashboard' ? '' : nextUrl,
      prefillEmail: email, csrfToken: res.locals.csrfToken
    });

    if (!email || !password) return renderFail('Email and password are required.');
    if (isLockedOut(email)) return renderFail('Too many failed attempts. Wait 15 minutes and try again, or reset your password.');

    const user = db.prepare(`SELECT id, email, password_hash, active, auth_epoch FROM users WHERE email = ?`).get(email);
    // Constant-ish-time response: always run a bcrypt compare even if user is
    // missing, so a probe can't distinguish "no such email" from "wrong password"
    // by timing alone.
    const hashToCheck = (user && user.password_hash && user.password_hash !== '!noauth')
      ? user.password_hash
      : '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid.';
    const ok = bcrypt.compareSync(password, hashToCheck);

    if (!user || !user.active || user.password_hash === '!noauth' || !ok) {
      recordBadLogin(email);
      return renderFail('Email or password is incorrect.');
    }

    clearBadLogin(email);
    // Regenerate the session id on privilege change to defeat session fixation.
    req.session.regenerate((err) => {
      if (err) return renderFail('Could not start a session. Please try again.');
      req.session.cookie.maxAge = remember ? SESSION_REMEMBER_MAX_AGE : SESSION_DEFAULT_MAX_AGE;
      // Touch last_active_at for the activity-feed and any "last seen" UX.
      try { db.prepare(`UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?`).run(user.id); } catch (_) {}
      req.session.userId = user.id;
      // SESS-001: bind the session to the user's current authorization epoch.
      req.session.authEpoch = Number(user.auth_epoch || 0);
      res.redirect(nextUrl);
    });
  });

  app.post('/logout', (req, res) => {
    // Destroy the whole session, not just userId, so csrfToken + last_ws_id +
    // active_firm_id all go too. Cookie is cleared explicitly for clients that
    // don't honour session.destroy's Set-Cookie max-age=0.
    req.session.destroy(() => {
      res.clearCookie('compliance_sphere.sid');
      res.redirect('/login?signed_out=1');
    });
  });

  // GET fallback so a bare /logout link works without a form.
  app.get('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('compliance_sphere.sid');
      res.redirect('/login?signed_out=1');
    });
  });

  // Self-signup stays disabled, but the public route now explains the access
  // model and offers a useful next step instead of looping back to sign-in.
  app.get('/register', (req, res) => renderPublic(req, res, 'access'));
  app.post('/register', (req, res) => renderPublic(req, res.status(405), 'access', {
    accessNotice: 'Self-signup is disabled. Request an evaluation or use the single-use invitation sent by your administrator.'
  }));

  // -------- User invitations (Phase 3) --------
  // Owner-only management surface. Lists firm users, client-side users this
  // firm has provisioned (via workspace_members), outstanding invitations, and
  // hosts the two provisioning forms (invite-by-email + create-with-temp-pw).
  const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  // "Firm owner" was renamed Manager. Keep the helper local to this section so
  // other callers can adopt isFirmOwner / rbac.isManager directly.
  function isFirmOwnerLocal(u) {
    return u && u.user_type === 'firm' && rbac.isManager(u.firm_role);
  }

  app.get('/admin/users', requireAuth, (req, res) => {
    if (!isFirmOwnerLocal(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'Only Managers can manage users.' });
    }
    const firmUsers = db.prepare(`
      SELECT id, name, email, firm_role, active, last_active_at, created_at
        FROM users WHERE firm_id = ? AND user_type = 'firm' ORDER BY active DESC, name`).all(req.user.firm_id);
    const clientUsers = db.prepare(`
      SELECT u.id, u.name, u.email, u.active, u.last_active_at, u.created_at,
             GROUP_CONCAT(w.client_name || ' (' || wm.role || ')', ' · ') AS workspaces
        FROM users u
        INNER JOIN workspace_members wm ON wm.user_id = u.id
        INNER JOIN workspaces w ON w.id = wm.workspace_id
       WHERE u.user_type = 'client' AND w.firm_id = ?
       GROUP BY u.id ORDER BY u.active DESC, u.name`).all(req.user.firm_id);
    const outstanding = db.prepare(`
      SELECT inv.id, inv.email, inv.name, inv.user_type, inv.firm_role, inv.workspace_role,
             inv.expires_at, inv.created_at, w.client_name AS workspace_name, u.name AS invited_by_name
        FROM user_invitations inv
        LEFT JOIN workspaces w ON w.id = inv.workspace_id
        LEFT JOIN users u ON u.id = inv.invited_by
       WHERE inv.firm_id = ? AND inv.accepted_at IS NULL AND inv.revoked_at IS NULL AND inv.expires_at > CURRENT_TIMESTAMP
       ORDER BY inv.created_at DESC`).all(req.user.firm_id);
    const workspaces = db.prepare(`SELECT id, client_name FROM workspaces WHERE firm_id = ? ORDER BY client_name`).all(req.user.firm_id);
    res.render('admin_users', {
      user: req.user, ws: null, active: 'admin-users',
      firmUsers, clientUsers, outstanding, workspaces,
      notice: req.query.notice || null,
      error: req.query.error || null,
      // Optional structured-error fields. When the invite route hits a
      // collision (active account exists / deactivated account exists) it sets
      // these so the view can render an inline action button rather than
      // leaving the admin at a dead-end "already exists" error.
      errorAction: req.query.error_action || null,
      errorEmail: req.query.error_email || null,
      errorUserId: req.query.error_user_id || null
    });
  });

  app.post('/admin/users/invite', requireAuth, async (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const name = (b.name || '').trim() || null;
    const userType = b.user_type === 'client' ? 'client' : 'firm';
    // Firm role accepts the new names; everything else (including the old
    // 'owner') normalises down to 'consultant' as a safe default so a stale
    // form value can't silently elevate an invite to Manager.
    const firmRole = userType === 'firm'
      ? (rbac.FIRM_ROLES.includes(b.firm_role) ? b.firm_role : 'consultant')
      : null;
    const workspaceId = userType === 'client' ? parseInt(b.workspace_id, 10) || null : null;
    const workspaceRole = userType === 'client'
      ? (rbac.CLIENT_ROLES.includes(b.workspace_role) ? b.workspace_role : 'contributor')
      : null;

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('A valid email is required.'));
    }

    // ---- Duplicate-account detection ----
    // Three distinct collision states get distinct flash params so the admin
    // page can render inline action buttons (reset / reactivate) instead of
    // a dead-end error. error_action is the trigger; email or user_id give
    // the action target.
    const existing = db.prepare(`SELECT id, email, active, name FROM users WHERE email = ?`).get(email);
    if (existing) {
      if (existing.active) {
        return res.redirect('/admin/users?'
          + 'error=' + encodeURIComponent(`An active account already exists for ${email}.`)
          + '&error_action=offer_reset'
          + '&error_email=' + encodeURIComponent(email));
      } else {
        return res.redirect('/admin/users?'
          + 'error=' + encodeURIComponent(`${email} previously had an account that was deactivated.`)
          + '&error_action=offer_reactivate'
          + '&error_user_id=' + existing.id
          + '&error_email=' + encodeURIComponent(email));
      }
    }

    if (userType === 'client') {
      if (!workspaceId) return res.redirect('/admin/users?error=' + encodeURIComponent('Pick a client workspace for the client-side user.'));
      const ws = db.prepare(`SELECT id FROM workspaces WHERE id = ? AND firm_id = ?`).get(workspaceId, req.user.firm_id);
      if (!ws) return res.redirect('/admin/users?error=' + encodeURIComponent('That workspace doesn\'t belong to this firm.'));
      // Already validated above via rbac.CLIENT_ROLES; defensive check kept in
      // case the constant set drifts from this list in the future.
      if (!rbac.CLIENT_ROLES.includes(workspaceRole)) {
        return res.redirect('/admin/users?error=' + encodeURIComponent('Invalid workspace role.'));
      }
    }

    // ---- Pending-invitation replacement ----
    // If an unaccepted, unrevoked, unexpired invitation already exists for this
    // email, revoke it before creating a new one. Keeps the outstanding-list
    // tidy and avoids "which link should I click?" confusion for the recipient.
    const pendingCount = db.prepare(`UPDATE user_invitations
         SET revoked_at = CURRENT_TIMESTAMP
       WHERE firm_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP`).run(req.user.firm_id, email).changes;

    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(raw);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    db.prepare(`INSERT INTO user_invitations
        (email, name, firm_id, user_type, firm_role, workspace_id, workspace_role,
         token_hash, expires_at, invited_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(email, name, req.user.firm_id, userType, firmRole, workspaceId, workspaceRole,
           tokenHash, expiresAt, req.user.id);

    const firmRow = db.prepare(`SELECT name FROM firms WHERE id = ?`).get(req.user.firm_id);
    const roleLabel = userType === 'firm'
      ? (rbac.ROLE_LABELS[firmRole] || 'Consultant')
      : `Client-side - ${rbac.ROLE_LABELS[workspaceRole] || workspaceRole}`;

    let sendError = null;
    try {
      const emailLib = require('../lib/email');
      const r = await emailLib.sendInviteEmail({
        toEmail: email, toName: name, inviterName: req.user.name,
        firmName: firmRow && firmRow.name, role: roleLabel,
        token: raw, expiresAt, firmId: req.user.firm_id
      });
      if (!r.ok) sendError = r.error || 'Email delivery failed';
    } catch (e) { sendError = e && e.message; }

    if (sendError) {
      return res.redirect('/admin/users?error=' + encodeURIComponent(`Invitation created but email failed (${sendError}). Share the link manually: /invite/${raw}`));
    }
    const replacedNote = pendingCount > 0 ? ' (replaced an earlier pending invitation)' : '';
    res.redirect('/admin/users?notice=' + encodeURIComponent(`Invitation sent to ${email}. Link expires in 7 days.${replacedNote}`));
  });

  app.post('/admin/users/create', requireAuth, (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const name = (b.name || '').trim();
    const password = String(b.password || '');
    const firmRole = rbac.FIRM_ROLES.includes(b.firm_role) ? b.firm_role : 'consultant';

    if (!email || !name) return res.redirect('/admin/users?error=' + encodeURIComponent('Name and email are required.'));
    if (password.length < 8) return res.redirect('/admin/users?error=' + encodeURIComponent('Temp password must be at least 8 characters.'));
    if (db.prepare(`SELECT id FROM users WHERE email = ?`).get(email)) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('A user with that email already exists.'));
    }
    const hash = bcrypt.hashSync(password, 12);
    const id = db.prepare(`INSERT INTO users (email, password_hash, name, user_type, firm_id, firm_role)
                           VALUES (?, ?, ?, 'firm', ?, ?)`)
      .run(email, hash, name, req.user.firm_id, firmRole).lastInsertRowid;
    try { logAction(req.user.id, null, 'create_consultant', 'user', id, { email, role: firmRole }); } catch (_) {}
    res.redirect('/admin/users?notice=' + encodeURIComponent(`Created ${email}. Share the temp password with them - they should change it on first sign-in.`));
  });

  app.post('/admin/users/:id/deactivate', requireAuth, (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const target = db.prepare(`SELECT id, firm_id, user_type FROM users WHERE id = ?`).get(req.params.id);
    if (!target) return res.redirect('/admin/users');
    if (target.id === req.user.id) return res.redirect('/admin/users?error=' + encodeURIComponent('You cannot deactivate your own account.'));
    // Firm users: must be in same firm. Client users: must be a member of a workspace owned by this firm.
    let ok = false;
    if (target.user_type === 'firm') {
      ok = target.firm_id === req.user.firm_id;
    } else {
      ok = !!db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN workspaces w ON w.id = wm.workspace_id
                         WHERE wm.user_id = ? AND w.firm_id = ?`).get(target.id, req.user.firm_id);
    }
    if (!ok) return res.redirect('/admin/users?error=' + encodeURIComponent('Not allowed.'));
    db.prepare(`UPDATE users SET active = 0 WHERE id = ?`).run(target.id);
    // SESS-001: deactivation must also terminate live sessions, not just block
    // future sign-ins.
    try { deps.revokeUserSessions(target.id); } catch (_) {}
    res.redirect('/admin/users?notice=' + encodeURIComponent('User deactivated.'));
  });

  // Admin-triggered password reset. Same machinery as /forgot but driven from
  // the duplicate-detection inline action - the admin sees "account exists" on
  // the invite form, clicks "send reset link", and we generate a fresh token
  // and email it. Always reports success (mirrors /forgot's no-leakage stance).
  app.post('/admin/users/send-reset', requireAuth, async (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email) return res.redirect('/admin/users?error=' + encodeURIComponent('Missing email.'));

    // Only reset users this firm has a reason to touch - firm users in the same
    // firm, or client users who hold at least one workspace_member row in a
    // workspace owned by this firm. Prevents a manager from poking strangers'
    // accounts via crafted form data.
    const target = db.prepare(`SELECT id, email, name, active, user_type, firm_id FROM users WHERE email = ?`).get(email);
    if (!target) {
      return res.redirect('/admin/users?notice=' + encodeURIComponent(`If an account exists for ${email}, a reset link is on its way.`));
    }
    let allowed = false;
    if (target.user_type === 'firm') allowed = target.firm_id === req.user.firm_id;
    else allowed = !!db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN workspaces w ON w.id = wm.workspace_id
                                  WHERE wm.user_id = ? AND w.firm_id = ?`).get(target.id, req.user.firm_id);
    if (!allowed || !target.active) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('Cannot reset that account from here.'));
    }

    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(raw);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    let sendError = null;
    try {
      db.prepare(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip) VALUES (?, ?, ?, ?)`)
        .run(target.id, tokenHash, expiresAt, req.ip || null);
      const emailLib = require('../lib/email');
      const r = await emailLib.sendPasswordResetEmail({
        toEmail: target.email, toName: target.name, token: raw, expiresAt, firmId: req.user.firm_id
      });
      if (!r.ok) sendError = r.error || 'Email delivery failed';
    } catch (e) { sendError = e && e.message; }

    if (sendError) {
      return res.redirect('/admin/users?error=' + encodeURIComponent(`Reset token created but email failed (${sendError}). Share the link manually: /reset/${raw}`));
    }
    res.redirect('/admin/users?notice=' + encodeURIComponent(`Password-reset link sent to ${email}. Expires in 1 hour.`));
  });

  // Reactivate a previously-deactivated user. Mirror of /deactivate with the
  // same firm-scoped permission check. Doesn't issue a reset email - admin can
  // trigger that separately if the user has forgotten their password.
  app.post('/admin/users/:id/reactivate', requireAuth, (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const target = db.prepare(`SELECT id, firm_id, user_type, email, active FROM users WHERE id = ?`).get(req.params.id);
    if (!target) return res.redirect('/admin/users');
    if (target.active) return res.redirect('/admin/users?error=' + encodeURIComponent('That account is already active.'));
    let ok = false;
    if (target.user_type === 'firm') ok = target.firm_id === req.user.firm_id;
    else ok = !!db.prepare(`SELECT 1 FROM workspace_members wm INNER JOIN workspaces w ON w.id = wm.workspace_id
                            WHERE wm.user_id = ? AND w.firm_id = ?`).get(target.id, req.user.firm_id);
    if (!ok) return res.redirect('/admin/users?error=' + encodeURIComponent('Not allowed.'));
    db.prepare(`UPDATE users SET active = 1 WHERE id = ?`).run(target.id);
    res.redirect('/admin/users?notice=' + encodeURIComponent(`Reactivated ${target.email}. They can now sign in with their existing password (or use Forgot password if they don't remember it).`));
  });

  app.post('/admin/invitations/:id/revoke', requireAuth, (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const inv = db.prepare(`SELECT id, firm_id FROM user_invitations WHERE id = ?`).get(req.params.id);
    if (!inv || inv.firm_id !== req.user.firm_id) return res.redirect('/admin/users');
    db.prepare(`UPDATE user_invitations SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(inv.id);
    res.redirect('/admin/users?notice=' + encodeURIComponent('Invitation revoked.'));
  });

  // Update a firm user's role from the Users & Access page. Manager-only,
  // scoped to the same firm. Guards against demoting yourself or removing the
  // last manager - both would lock the firm out of user management.
  app.post('/admin/users/:id/firm-role', requireAuth, (req, res) => {
    if (!isFirmOwnerLocal(req.user)) return res.status(403).send('Forbidden');
    const newRole = String((req.body && req.body.firm_role) || '').trim();
    if (!rbac.FIRM_ROLES.includes(newRole)) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('Invalid role.'));
    }
    const target = db.prepare(`SELECT id, firm_id, user_type, firm_role, email, name FROM users WHERE id = ?`)
      .get(req.params.id);
    if (!target) return res.redirect('/admin/users?error=' + encodeURIComponent('User not found.'));
    if (target.user_type !== 'firm' || target.firm_id !== req.user.firm_id) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('Not allowed.'));
    }
    if (target.id === req.user.id) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('You cannot change your own role from here. Ask another manager.'));
    }
    // If the target is currently the last active manager, refuse the demotion.
    const currentNormalised = rbac.normalizeRole(target.firm_role);
    if (currentNormalised === 'manager' && newRole !== 'manager') {
      const otherManagers = db.prepare(`
        SELECT COUNT(*) AS n FROM users
          WHERE firm_id = ? AND user_type = 'firm' AND active = 1 AND id != ?
            AND (firm_role = 'manager' OR firm_role = 'firm_owner')`).get(target.firm_id, target.id);
      if (!otherManagers.n) {
        return res.redirect('/admin/users?error=' + encodeURIComponent(
          'Cannot demote the last active manager. Promote another firm user to manager first.'));
      }
    }
    if (currentNormalised === newRole) {
      return res.redirect('/admin/users?notice=' + encodeURIComponent('Role unchanged.'));
    }
    db.prepare(`UPDATE users SET firm_role = ? WHERE id = ?`).run(newRole, target.id);
    logAction(req.user.id, null, 'change_firm_role', 'user', target.id,
      { old_role: target.firm_role, new_role: newRole }, auditCtx(req));
    res.redirect('/admin/users?notice=' + encodeURIComponent(
      `Updated ${target.email} to ${rbac.ROLE_LABELS[newRole] || newRole}.`));
  });

  // -------- Accept invitation (public, token-authenticated) --------
  function lookupInvitation(rawToken) {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length !== 64) return null;
    const tokenHash = hashToken(rawToken);
    const row = db.prepare(`
      SELECT inv.*, f.name AS firm_name, w.client_name AS workspace_name
        FROM user_invitations inv
        LEFT JOIN firms f ON f.id = inv.firm_id
        LEFT JOIN workspaces w ON w.id = inv.workspace_id
       WHERE inv.token_hash = ?`).get(tokenHash);
    if (!row) return null;
    if (row.accepted_at || row.revoked_at) return null;
    if (new Date(row.expires_at) < new Date()) return null;
    if (db.prepare(`SELECT id FROM users WHERE email = ?`).get(row.email)) return null;
    return row;
  }

  app.get('/invite/:token', (req, res) => {
    const inv = lookupInvitation(req.params.token);
    if (!inv) {
      return res.status(400).render('auth/login', {
        error: 'That invitation link is invalid, has expired, or has already been used. Ask the person who invited you for a new one.',
        notice: null, next_url: '', prefillEmail: '', csrfToken: res.locals.csrfToken
      });
    }
    res.render('auth/accept_invite', {
      token: req.params.token, invitation: inv, error: null,
      csrfToken: res.locals.csrfToken
    });
  });

  app.post('/invite/:token', (req, res) => {
    const inv = lookupInvitation(req.params.token);
    if (!inv) {
      return res.status(400).render('auth/login', {
        error: 'That invitation link is invalid, has expired, or has already been used.',
        notice: null, next_url: '', prefillEmail: '', csrfToken: res.locals.csrfToken
      });
    }
    const b = req.body || {};
    const name = (b.name || inv.name || '').trim();
    const pw  = String(b.password  || '');
    const pw2 = String(b.password2 || '');
    const renderFail = (msg) => res.status(400).render('auth/accept_invite', {
      token: req.params.token, invitation: inv, error: msg, csrfToken: res.locals.csrfToken
    });
    if (!name) return renderFail('Your name is required.');
    if (pw.length < 8) return renderFail('Password must be at least 8 characters.');
    if (pw !== pw2)    return renderFail('Passwords do not match.');

    const hash = bcrypt.hashSync(pw, 12);
    let newUserId = null;
    const tx = db.transaction(() => {
      const insertCols = inv.user_type === 'firm'
        ? `email, password_hash, name, user_type, firm_id, firm_role`
        : `email, password_hash, name, user_type, firm_id`;
      const insertVals = inv.user_type === 'firm'
        ? [inv.email, hash, name, 'firm', inv.firm_id, inv.firm_role || 'consultant']
        : [inv.email, hash, name, 'client', inv.firm_id];
      newUserId = db.prepare(`INSERT INTO users (${insertCols}) VALUES (${insertVals.map(() => '?').join(',')})`)
        .run(...insertVals).lastInsertRowid;
      if (inv.workspace_id && inv.workspace_role) {
        db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`)
          .run(inv.workspace_id, newUserId, inv.workspace_role);
      }
      db.prepare(`UPDATE user_invitations SET accepted_at = CURRENT_TIMESTAMP, accepted_user_id = ? WHERE id = ?`)
        .run(newUserId, inv.id);
    });
    tx();

    req.session.regenerate((err) => {
      if (err) return res.redirect('/login?invited=1');
      req.session.userId = newUserId;
      req.session.authEpoch = Number(
        db.prepare('SELECT auth_epoch FROM users WHERE id = ?').get(newUserId)?.auth_epoch || 0);
      req.session.cookie.maxAge = SESSION_DEFAULT_MAX_AGE;
      const nextUrl = inv.workspace_id ? `/workspaces/${inv.workspace_id}/client-portal` : '/dashboard';
      res.redirect(nextUrl);
    });
  });

  // -------- Forgot-password (request a reset link) --------
  const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
  const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

  app.get('/forgot', (req, res) => {
    res.render('auth/forgot', {
      error: null, notice: null, submitted: false,
      prefillEmail: '', csrfToken: res.locals.csrfToken
    });
  });

  app.post('/forgot', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    // Generic response - never confirm or deny whether an account exists.
    const genericNotice = 'If an account exists for that email, a reset link is on its way. It expires in 1 hour.';
    if (!email) {
      return res.status(400).render('auth/forgot', {
        error: 'Email is required.', notice: null, submitted: false,
        prefillEmail: '', csrfToken: res.locals.csrfToken
      });
    }
    const user = db.prepare(`SELECT id, email, name, active FROM users WHERE email = ?`).get(email);
    if (user && user.active) {
      const raw = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(raw);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
      try {
        db.prepare(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip) VALUES (?, ?, ?, ?)`)
          .run(user.id, tokenHash, expiresAt, req.ip || null);
        const emailLib = require('../lib/email');
        await emailLib.sendPasswordResetEmail({
          toEmail: user.email, toName: user.name, token: raw, expiresAt
        });
      } catch (e) {
        console.error('[auth] password reset issue', e && e.message);
      }
    }
    res.render('auth/forgot', {
      error: null, notice: genericNotice, submitted: true,
      prefillEmail: email, csrfToken: res.locals.csrfToken
    });
  });

  // -------- Reset-password (consume token, set new password) --------
  function lookupResetToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length !== 64) return null;
    const tokenHash = hashToken(rawToken);
    const row = db.prepare(`
      SELECT t.id, t.user_id, t.expires_at, t.used_at, u.email, u.name, u.active
        FROM password_reset_tokens t
        INNER JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`).get(tokenHash);
    if (!row) return null;
    if (row.used_at) return null;
    if (!row.active) return null;
    if (new Date(row.expires_at) < new Date()) return null;
    return row;
  }

  app.get('/reset/:token', (req, res) => {
    const row = lookupResetToken(req.params.token);
    if (!row) {
      return res.status(400).render('auth/forgot', {
        error: 'That reset link is invalid or has expired. Request a new one below.',
        notice: null, submitted: false, prefillEmail: '', csrfToken: res.locals.csrfToken
      });
    }
    res.render('auth/reset', { token: req.params.token, error: null, csrfToken: res.locals.csrfToken });
  });

  app.post('/reset/:token', (req, res) => {
    const row = lookupResetToken(req.params.token);
    if (!row) {
      return res.status(400).render('auth/forgot', {
        error: 'That reset link is invalid or has expired. Request a new one below.',
        notice: null, submitted: false, prefillEmail: '', csrfToken: res.locals.csrfToken
      });
    }
    const pw  = String((req.body && req.body.password)  || '');
    const pw2 = String((req.body && req.body.password2) || '');
    const renderFail = (msg) => res.status(400).render('auth/reset', {
      token: req.params.token, error: msg, csrfToken: res.locals.csrfToken
    });
    if (pw.length < 8) return renderFail('Password must be at least 8 characters.');
    if (pw !== pw2)    return renderFail('Passwords do not match.');

    const hash = bcrypt.hashSync(pw, 12);
    let newEpoch = 0;
    const tx = db.transaction(() => {
      db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, row.user_id);
      db.prepare(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
      // Invalidate any other outstanding reset tokens for the same user
      db.prepare(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL`).run(row.user_id);
      // SESS-001: account recovery must contain a stolen session. Bump the
      // authorization epoch and delete persisted session rows for this user, so
      // every cookie minted before this instant stops resolving to a user.
      newEpoch = deps.revokeUserSessions(row.user_id);
    });
    tx();
    clearBadLogin(row.email);

    // Auto-sign-in once the password is set. Same session-fixation regenerate
    // pattern as the login route.
    req.session.regenerate((err) => {
      if (err) return res.redirect('/login?reset_ok=1');
      req.session.userId = row.user_id;
      req.session.authEpoch = newEpoch;
      req.session.cookie.maxAge = SESSION_DEFAULT_MAX_AGE;
      res.redirect('/dashboard');
    });
  });

}

module.exports = { register, hashToken, INVITE_TTL_MS };
