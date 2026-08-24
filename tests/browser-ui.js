// Comprehensive UI/UX crawler. Boots a test server against a copy of the live
// DB on a non-default port, then drives a real Chrome via puppeteer-core to
// visit every sidebar route, capture console errors / network failures, and
// exercise every clickable element it can do safely (links, dropdowns, modal
// openers, filter chips, details/summary expanders). Destructive actions are
// detected via the global confirm modal - we open them, verify the modal
// renders, then cancel.
//
// Run: node tests/browser-ui.js
//
// Output: tests/browser-report.json + tests/browser-screenshots/*.png

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const REPORT_DIR = path.join(__dirname, 'browser-report');
const SHOT_DIR = path.join(REPORT_DIR, 'screenshots');
const TMP_DB = path.join('/tmp', `iso27001-uitest-${Date.now()}.db`);
const PORT = 3099;
const BASE = `http://localhost:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TEST_PASSWORD = crypto.randomBytes(32).toString('base64url');

const liveDb = path.join(ROOT, 'iso27001.db');
if (!fs.existsSync(liveDb)) {
  console.error('No live iso27001.db to snapshot. Boot the server once first.');
  process.exit(1);
}
fs.copyFileSync(liveDb, TMP_DB);
fs.mkdirSync(SHOT_DIR, { recursive: true });

function prepareTestManager() {
  const db = new Database(TMP_DB);
  const manager = db.prepare(`SELECT u.id, u.email, u.firm_id
    FROM users u
    JOIN workspaces w ON w.firm_id=u.firm_id
    WHERE u.active=1 AND u.user_type='firm' AND u.firm_role='manager'
    GROUP BY u.id, u.email, u.firm_id
    ORDER BY u.id LIMIT 1`).get();
  if (!manager) {
    db.close();
    throw new Error('No active Manager with a workspace exists in the snapshot DB.');
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?')
    .run(bcrypt.hashSync(TEST_PASSWORD, 10), manager.id);
  db.close();
  return manager;
}

const findings = {
  startedAt: new Date().toISOString(),
  pages: [],
  consoleErrors: [],
  networkErrors: [],
  pageErrors: [],
  brokenLinks: [],
  modalChecks: [],
  formChecks: [],
};

function log(...a) { console.log('[ui-test]', ...a); }

async function startServer() {
  log('Starting server on port', PORT, 'with DB', TMP_DB);
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdoutBuf = '';
  proc.stdout.on('data', d => { stdoutBuf += d.toString(); });
  proc.stderr.on('data', d => { stdoutBuf += d.toString(); });
  // Wait for "running at" or 15s timeout.
  const ready = await new Promise(resolve => {
    const t = setTimeout(() => resolve(false), 15000);
    const i = setInterval(() => {
      if (stdoutBuf.includes('running at')) { clearTimeout(t); clearInterval(i); resolve(true); }
    }, 200);
  });
  if (!ready) {
    log('Server did not start. stdout:\n', stdoutBuf);
    proc.kill();
    process.exit(1);
  }
  log('Server up.');
  return proc;
}

async function pickWorkspaceId(firmId) {
  const db = new Database(TMP_DB, { readonly: true });
  const ws = db.prepare('SELECT id FROM workspaces WHERE firm_id=? ORDER BY id LIMIT 1').get(firmId);
  db.close();
  if (!ws) {
    log('The test Manager has no workspace in the snapshot DB.');
    return null;
  }
  return { wsId: ws.id };
}

async function authenticate(page, manager) {
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.type('input[name="email"]', manager.email);
  await page.type('input[name="password"]', TEST_PASSWORD);
  await page.$eval('form.auth-form', form => form.requestSubmit());
  // Cross-document view transitions can make Puppeteer's lifecycle-based
  // waitForNavigation outlive an otherwise successful redirect. The sign-out
  // form is the authenticated shell's stable readiness marker.
  try {
    await page.waitForSelector('form[action="/logout"], button[aria-label="Sign out"]', { timeout: 20000 });
  } catch (error) {
    const failure = await page.evaluate(() => ({
      path: location.pathname,
      message: document.querySelector('.alert-err')?.textContent?.trim() || '',
    }));
    throw new Error(`Browser crawler login failed on ${failure.path}: ${failure.message || error.message}`);
  }
  const state = await page.evaluate(() => ({
    path: location.pathname,
    hasFirmNavigation: !!document.querySelector('a[href="/dashboard"]'),
    hasSignOut: !!document.querySelector('form[action="/logout"], button[aria-label="Sign out"]'),
  }));
  if (state.path === '/login' || !state.hasFirmNavigation || !state.hasSignOut) {
    throw new Error(`Browser crawler failed to authenticate as a Manager (landed on ${state.path}).`);
  }
  return state;
}

function safeName(p) {
  return p.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'root';
}

async function visit(page, urlPath, opts = {}) {
  const url = BASE + urlPath;
  const result = {
    path: urlPath,
    status: null,
    consoleErrors: [],
    networkFails: [],
    pageErrors: [],
    interactive: { links: 0, buttons: 0, forms: 0, summaries: 0, deleteForms: 0 },
    findings: [],
  };
  // Per-page listeners
  const onConsole = msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter favicon / harmless 404s
      if (/favicon|sourcemap/i.test(text)) return;
      result.consoleErrors.push(text);
      findings.consoleErrors.push({ url: urlPath, text });
    }
  };
  const onPageError = err => {
    result.pageErrors.push(err.message);
    findings.pageErrors.push({ url: urlPath, text: err.message });
  };
  const onResponse = resp => {
    if (resp.status() >= 400) {
      const failedUrl = resp.url();
      // Don't double-report main-doc 4xx (visible in result.status)
      if (failedUrl === url) return;
      // Skip toasts and acceptable 304s
      if (resp.status() === 304) return;
      result.networkFails.push({ url: failedUrl, status: resp.status() });
      findings.networkErrors.push({ on: urlPath, url: failedUrl, status: resp.status() });
    }
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    result.status = resp ? resp.status() : 0;
    // Wait a bit for any inline scripts to run.
    await new Promise(r => setTimeout(r, 250));

    // Count interactive elements
    const counts = await page.evaluate(() => {
      return {
        links: document.querySelectorAll('a[href]').length,
        buttons: document.querySelectorAll('button').length,
        forms: document.querySelectorAll('form').length,
        summaries: document.querySelectorAll('summary').length,
        deleteForms: document.querySelectorAll('form[action*="/delete"], form[action*="/remove"], form[action*="/retire"], form[action*="/revoke"]').length,
        nativeDialogs: (() => {
          // Look for any inline `confirm(` / `alert(` / `prompt(` in onclick/onsubmit attrs
          const out = [];
          document.querySelectorAll('[onclick], [onsubmit]').forEach(el => {
            const oc = (el.getAttribute('onclick') || '') + ' ' + (el.getAttribute('onsubmit') || '');
            if (/(?:^|[^a-zA-Z._])(?:confirm|alert|prompt)\s*\(/.test(oc) && !/appConfirm|appAlert/.test(oc)) {
              out.push({ tag: el.tagName, attr: oc.slice(0, 200) });
            }
          });
          return out;
        })(),
      };
    });
    result.interactive = counts;
    if (counts.nativeDialogs.length) {
      result.findings.push({ kind: 'native-dialog-leak', count: counts.nativeDialogs.length, samples: counts.nativeDialogs.slice(0, 3) });
    }

    // Click every button[type="button"] (non-submit, non-destructive) and any
    // [onclick] element to ensure no JS errors fire. Submit buttons are skipped
    // since they would POST. The "delete-form-click" check below covers those.
    const buttonClickReport = await page.evaluate(async () => {
      const errors = [];
      const safe = Array.from(document.querySelectorAll('button[type="button"], [onclick]'))
        .filter(el => {
          // Skip anything that would navigate away or post.
          const oc = (el.getAttribute('onclick') || '').toLowerCase();
          if (oc.includes('location') || oc.includes('window.open')) return false;
          if (oc.includes('deleteclient')) return false;
          if (el.tagName === 'A') return false;
          if (el.closest('form')) {
            const f = el.closest('form');
            if (f.method && f.method.toLowerCase() === 'post') return false;
          }
          return true;
        });
      let tested = 0;
      for (const btn of safe) {
        try {
          // Suppress dispatchEvent errors but capture them.
          btn.click();
          tested++;
        } catch (e) {
          errors.push({ tag: btn.tagName, text: (btn.textContent || '').slice(0, 60).trim(), error: e.message });
        }
        // Yield so any opened modals/details can settle.
        await new Promise(r => setTimeout(r, 5));
      }
      // Close any modal we accidentally opened.
      const modals = ['appConfirmModal', 'deleteClientModal', 'cpBackdrop', 'helpBackdrop'];
      modals.forEach(id => {
        const m = document.getElementById(id);
        if (!m) return;
        if (m.style.display === 'flex') m.style.display = 'none';
        if (m.classList.contains('open')) m.classList.remove('open');
      });
      return { tested, errors };
    });
    if (buttonClickReport.errors.length) {
      result.findings.push({ kind: 'button-click-errors', count: buttonClickReport.errors.length, samples: buttonClickReport.errors.slice(0, 5) });
    }
    result.buttonsClicked = buttonClickReport.tested;

    // Click each <details><summary> to verify they expand without error.
    const summaryCount = await page.$$eval('summary', els => {
      let opened = 0;
      els.forEach(s => {
        try {
          const det = s.closest('details');
          if (det && !det.open) { det.open = true; opened++; }
        } catch (_) {}
      });
      return opened;
    });
    if (summaryCount) result.findings.push({ kind: 'details-opened', count: summaryCount });

    // Detect any delete-form on this page; click first one's submit to verify
    // it opens our in-app modal (not browser-native confirm).
    if (opts.testDeleteModal) {
      const deleteFormCheck = await page.evaluate(() => {
        const f = document.querySelector('form[action*="/delete"]');
        if (!f) return { tested: false };
        // Only trigger if the form's onsubmit uses appConfirmForm.
        const oc = f.getAttribute('onsubmit') || '';
        if (!oc.includes('appConfirmForm')) return { tested: false, reason: 'no appConfirmForm handler' };
        const btn = f.querySelector('button[type="submit"], button:not([type])');
        if (!btn) return { tested: false, reason: 'no submit button' };
        btn.click();
        // Yield a microtask
        return new Promise(resolve => setTimeout(() => {
          const modal = document.getElementById('appConfirmModal');
          const visible = modal && getComputedStyle(modal).display === 'flex';
          // Cancel the modal so we don't leave it open
          if (visible) {
            const cancel = document.getElementById('appConfirmCancel');
            cancel && cancel.click();
          }
          resolve({ tested: true, modalOpened: !!visible });
        }, 100));
      });
      if (deleteFormCheck.tested) {
        findings.modalChecks.push({ url: urlPath, ...deleteFormCheck });
        if (!deleteFormCheck.modalOpened) {
          result.findings.push({ kind: 'modal-not-opened', detail: 'delete form click did not open appConfirmModal' });
        }
      }
    }

    // Collect all internal hrefs for the broken-link sweep
    const internalLinks = await page.$$eval('a[href]', as => as
      .map(a => a.getAttribute('href'))
      .filter(h => h && (h.startsWith('/') || h.startsWith(location.origin)))
      .filter(h => !h.startsWith('/api/') && !h.includes('/export/') && !h.includes('.zip') && !h.includes('.docx') && !h.includes('.csv') && !h.includes('.pdf'))
    );
    result.linkCount = internalLinks.length;

    // Screenshot
    const shotPath = path.join(SHOT_DIR, safeName(urlPath) + '.png');
    await page.screenshot({ path: shotPath, fullPage: true });
    result.screenshot = path.relative(ROOT, shotPath);

  } catch (e) {
    result.error = e.message;
    findings.pageErrors.push({ url: urlPath, text: 'navigation: ' + e.message });
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  }
  findings.pages.push(result);
  log(`  ${result.status || 'ERR'} ${urlPath} - ${result.consoleErrors.length}ce ${result.networkFails.length}nf ${result.pageErrors.length}pe`);
  return result;
}

(async () => {
  const manager = prepareTestManager();
  const server = await startServer();
  const wsPick = await pickWorkspaceId(manager.firm_id);
  const wsId = wsPick && wsPick.wsId;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  findings.authentication = await authenticate(page, manager);

  // Suppress native dialogs at the puppeteer level - if any leak through, we
  // dismiss them and record it as a finding.
  page.on('dialog', async dialog => {
    findings.consoleErrors.push({ url: page.url(), text: 'native dialog leaked: ' + dialog.type() + ' - ' + dialog.message() });
    await dialog.dismiss();
  });

  // Top-level pages
  const topRoutes = [
    '/dashboard',
    '/tenants',
    '/glossary',
    '/onboarding',
  ];
  // Workspace-scoped routes
  const wsRoutes = wsId ? [
    `/workspaces/${wsId}`,
    `/workspaces/${wsId}/readiness`,
    `/workspaces/${wsId}/gap-assessment`,
    `/workspaces/${wsId}/roadmap`,
    `/workspaces/${wsId}/controls`,
    `/workspaces/${wsId}/controls/assess`,
    `/workspaces/${wsId}/controls/assess/summary`,
    `/workspaces/${wsId}/assets`,
    `/workspaces/${wsId}/risks`,
    `/workspaces/${wsId}/risk-methodology`,
    `/workspaces/${wsId}/objectives`,
    `/workspaces/${wsId}/soa`,
    `/workspaces/${wsId}/documents`,
    `/workspaces/${wsId}/evidence`,
    `/workspaces/${wsId}/audits`,
    `/workspaces/${wsId}/audit-programme`,
    `/workspaces/${wsId}/mrms`,
    `/workspaces/${wsId}/cert-cycle`,
    `/workspaces/${wsId}/nonconformities`,
    `/workspaces/${wsId}/incidents`,
    `/workspaces/${wsId}/improvements`,
    `/workspaces/${wsId}/vendors`,
    `/workspaces/${wsId}/tasks`,
    `/workspaces/${wsId}/task-templates`,
    `/workspaces/${wsId}/calendar`,
    `/workspaces/${wsId}/search`,
    `/workspaces/${wsId}/reports`,
    `/workspaces/${wsId}/system`,
    `/workspaces/${wsId}/members`,
    `/workspaces/${wsId}/access`,
    `/workspaces/${wsId}/activity-log`,
    `/workspaces/${wsId}/notifications`,
  ] : [];

  log(`Crawling ${topRoutes.length + wsRoutes.length} routes`);
  for (const r of topRoutes) await visit(page, r, { testDeleteModal: r === '/dashboard' });
  for (const r of wsRoutes) await visit(page, r, { testDeleteModal: r.endsWith(`/workspaces/${wsId}`) });

  // Glossary detail - pick a random entry
  try {
    await page.goto(BASE + '/glossary', { waitUntil: 'domcontentloaded' });
    const slug = await page.$$eval('a[href^="/glossary/"]', as => {
      const target = as.find(a => /\/glossary\/[\w-]+$/.test(a.getAttribute('href')));
      return target ? target.getAttribute('href') : null;
    });
    if (slug) await visit(page, slug);
  } catch (_) {}

  // Risks detail - pick first risk
  if (wsId) {
    try {
      await page.goto(BASE + `/workspaces/${wsId}/risks`, { waitUntil: 'domcontentloaded' });
      const href = await page.$$eval('a[href*="/risks/"]', as => {
        const t = as.find(a => /\/risks\/\d+$/.test(a.getAttribute('href')));
        return t ? t.getAttribute('href') : null;
      });
      if (href) await visit(page, href);
    } catch (_) {}

    // One control assess page
    try {
      await page.goto(BASE + `/workspaces/${wsId}/controls`, { waitUntil: 'domcontentloaded' });
      const href = await page.$$eval('a[href*="/controls/assess/"]', as => {
        const t = as.find(a => /\/controls\/assess\/[a-z0-9.]+$/i.test(a.getAttribute('href')));
        return t ? t.getAttribute('href') : null;
      });
      if (href) await visit(page, href);
    } catch (_) {}

    // One document detail
    try {
      await page.goto(BASE + `/workspaces/${wsId}/documents`, { waitUntil: 'domcontentloaded' });
      const href = await page.$$eval('a[href*="/documents/"]', as => {
        const t = as.find(a => /\/documents\/\d+$/.test(a.getAttribute('href')));
        return t ? t.getAttribute('href') : null;
      });
      if (href) await visit(page, href);
    } catch (_) {}
  }

  // Test the dashboard delete modal end-to-end (open, type wrong name, see
  // error, type right name but cancel).
  if (wsId) {
    log('Exercising dashboard delete-client modal...');
    await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded' });
    const modalTest = await page.evaluate(() => {
      const btn = document.querySelector('button[onclick^="deleteClient("]');
      if (!btn) return { ok: false, reason: 'no delete button on dashboard' };
      btn.click();
      return new Promise(resolve => setTimeout(() => {
        const m = document.getElementById('deleteClientModal');
        if (!m || getComputedStyle(m).display !== 'flex') return resolve({ ok: false, reason: 'modal did not open' });
        // Try wrong name first
        const input = document.getElementById('dcmInput');
        const submit = document.getElementById('dcmConfirm');
        input.value = 'WRONG NAME ZZZ';
        submit.click();
        setTimeout(() => {
          const err = document.getElementById('dcmError');
          const errVisible = err && getComputedStyle(err).display !== 'none';
          // Cancel modal
          document.getElementById('dcmCancel').click();
          resolve({ ok: true, modalOpened: true, wrongNameRejected: !!errVisible });
        }, 100);
      }, 200));
    });
    findings.modalChecks.push({ url: '/dashboard', what: 'delete-client-modal', ...modalTest });
  }

  // Test global appConfirm modal directly
  log('Exercising global appConfirm modal...');
  await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded' });
  const apiTest = await page.evaluate(async () => {
    if (typeof window.appConfirm !== 'function') return { ok: false, reason: 'appConfirm undefined' };
    if (typeof window.appAlert !== 'function') return { ok: false, reason: 'appAlert undefined' };
    if (typeof window.appConfirmForm !== 'function') return { ok: false, reason: 'appConfirmForm undefined' };
    const p = window.appConfirm('Test?');
    await new Promise(r => setTimeout(r, 50));
    const m = document.getElementById('appConfirmModal');
    const visible = m && getComputedStyle(m).display === 'flex';
    document.getElementById('appConfirmCancel').click();
    const result = await p;
    return { ok: true, visible, cancelReturnedFalse: result === false };
  });
  findings.modalChecks.push({ url: '/dashboard', what: 'global-appConfirm-api', ...apiTest });

  // Cross-page broken-link sweep: pick links found and HEAD them
  log('Sweeping unique internal links seen so far...');
  const seen = new Set();
  for (const p of findings.pages) {
    if (!p.linkCount) continue;
  }
  // For broken links we'll just trust the per-page network errors.

  await browser.close();
  server.kill();
  // Wait for kill
  await new Promise(r => setTimeout(r, 500));

  // Cleanup tmp DB
  try { fs.unlinkSync(TMP_DB); } catch (_) {}

  findings.endedAt = new Date().toISOString();
  findings.summary = {
    pagesVisited: findings.pages.length,
    pagesWith4xx5xx: findings.pages.filter(p => p.status >= 400).length,
    consoleErrors: findings.consoleErrors.length,
    networkErrors: findings.networkErrors.length,
    pageErrors: findings.pageErrors.length,
    nativeDialogLeaks: findings.pages.reduce((n, p) => n + (p.findings || []).filter(f => f.kind === 'native-dialog-leak').length, 0),
    modalChecks: findings.modalChecks,
  };

  const failedModalCheck = findings.modalChecks.some(check => check.ok === false || check.modalOpened === false);
  findings.summary.passed = findings.summary.pagesWith4xx5xx === 0
    && findings.summary.consoleErrors === 0
    && findings.summary.networkErrors === 0
    && findings.summary.pageErrors === 0
    && findings.summary.nativeDialogLeaks === 0
    && !failedModalCheck;

  fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(findings, null, 2));
  log('Report written to', path.join(REPORT_DIR, 'report.json'));
  log('Summary:', JSON.stringify(findings.summary, null, 2));
  if (!findings.summary.passed) process.exitCode = 1;
})().catch(e => {
  console.error('UI test crashed:', e);
  process.exit(1);
});
