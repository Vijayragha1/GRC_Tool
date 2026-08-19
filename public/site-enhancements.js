/* Compliance Sphere interaction layer.
   These enhancements are progressive: the application remains usable when
   JavaScript is unavailable, and no optional analytics leave the browser. */
(function () {
  'use strict';

  const CONSENT_COOKIE = 'cs_consent';
  const ATTRIBUTION_KEY = 'cs-attribution';
  const ENHANCED = 'data-cs-enhanced';
  let observedMain = null;
  let refreshTimer = null;

  function getCookie(name) {
    const prefix = encodeURIComponent(name) + '=';
    const match = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
    return match ? decodeURIComponent(match.slice(prefix.length)) : '';
  }

  function setConsent(value) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${encodeURIComponent(CONSENT_COOKIE)}=${encodeURIComponent(value)}; Max-Age=15552000; Path=/; SameSite=Lax${secure}`;
    document.getElementById('cookieConsent')?.remove();
    if (value === 'analytics') captureAttribution();
  }

  function captureAttribution() {
    if (getCookie(CONSENT_COOKIE) !== 'analytics') return;
    const params = new URLSearchParams(location.search);
    const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    const values = {};
    keys.forEach(key => {
      const value = params.get(key);
      if (value) values[key] = value.slice(0, 250);
    });
    if (Object.keys(values).length) {
      const record = {
        version: 1,
        captured_at: new Date().toISOString(),
        landing_path: location.pathname,
        ...values,
      };
      try { localStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(record)); } catch (_) {}
    }
    try { window.ComplianceSphereAttribution = JSON.parse(localStorage.getItem(ATTRIBUTION_KEY) || 'null'); } catch (_) {}
  }

  function installCookieBanner() {
    if (getCookie(CONSENT_COOKIE) || document.getElementById('cookieConsent')) {
      captureAttribution();
      return;
    }
    const banner = document.createElement('section');
    banner.id = 'cookieConsent';
    banner.className = 'cookie-consent';
    banner.setAttribute('aria-label', 'Cookie preferences');
    banner.innerHTML = `
      <div>
        <strong>Your privacy choices</strong>
        <p>Essential cookies keep your session secure. Optional campaign attribution helps us understand how visitors found Compliance Sphere and stays in this browser.</p>
      </div>
      <div class="cookie-consent-actions">
        <button type="button" class="btn btn-secondary btn-xs" data-cookie-choice="essential">Use essential only</button>
        <button type="button" class="btn btn-primary btn-xs" data-cookie-choice="analytics">Allow campaign analytics</button>
      </div>`;
    banner.addEventListener('click', event => {
      const button = event.target.closest('[data-cookie-choice]');
      if (button) setConsent(button.dataset.cookieChoice);
    });
    document.body.appendChild(banner);
  }

  function syncThemeControls() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    });
  }

  function installThemeControls() {
    document.querySelectorAll('[data-theme-toggle]').forEach(button => button.setAttribute('data-theme-bound', 'true'));
  }

  function toggleThemeState() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (dark) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.setItem('isms-theme', dark ? 'light' : 'dark'); } catch (_) {}
    syncThemeControls();
  }

  function enhancePasswords(root) {
    root.querySelectorAll(`input[type="password"]:not([${ENHANCED}])`).forEach(input => {
      input.setAttribute(ENHANCED, 'password');
      const wrapper = document.createElement('span');
      wrapper.className = 'password-field';
      input.before(wrapper);
      wrapper.appendChild(input);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'password-toggle';
      button.setAttribute('aria-label', 'Show password');
      button.setAttribute('aria-pressed', 'false');
      button.textContent = 'Show';
      button.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        button.textContent = show ? 'Hide' : 'Show';
        button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        button.setAttribute('aria-pressed', String(show));
        input.focus();
      });
      wrapper.appendChild(button);
    });
  }

  function copyText(value, button) {
    const done = () => {
      const original = button.textContent;
      button.textContent = 'Copied';
      button.classList.add('is-copied');
      setTimeout(() => { button.textContent = original; button.classList.remove('is-copied'); }, 1600);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(done).catch(() => fallbackCopy(value, done));
    } else {
      fallbackCopy(value, done);
    }
  }

  function fallbackCopy(value, done) {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (_) {}
    area.remove();
  }

  function enhanceCopyBlocks(root) {
    root.querySelectorAll(`pre:not([data-no-copy]):not([${ENHANCED}])`).forEach(block => {
      const sourceText = block.innerText;
      block.setAttribute(ENHANCED, 'copy');
      block.classList.add('copyable-block');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-button';
      button.textContent = 'Copy';
      button.setAttribute('aria-label', 'Copy this content');
      button.addEventListener('click', () => copyText(sourceText, button));
      block.appendChild(button);
    });
  }

  function installFormValidation() {
    document.addEventListener('invalid', event => {
      const field = event.target;
      if (!(field instanceof HTMLElement)) return;
      field.classList.add('field-invalid');
      field.setAttribute('aria-invalid', 'true');
      let message = field.parentElement?.querySelector(`.field-error-message[data-for="${field.id || ''}"]`);
      if (!message) {
        message = document.createElement('span');
        message.className = 'field-error-message';
        message.dataset.for = field.id || '';
        field.insertAdjacentElement('afterend', message);
      }
      message.textContent = field.validationMessage || 'Check this field.';
    }, true);
    ['input', 'change'].forEach(type => document.addEventListener(type, event => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) return;
      if (!field.validity.valid) return;
      field.classList.remove('field-invalid');
      field.removeAttribute('aria-invalid');
      field.parentElement?.querySelectorAll('.field-error-message').forEach(message => message.remove());
    }, true));
    document.addEventListener('submit', event => {
      const form = event.target;
      if (event.defaultPrevented || !(form instanceof HTMLFormElement) || !form.checkValidity()) return;
      form.setAttribute('aria-busy', 'true');
      form.classList.add('form-submitting');
    });
  }

  function enhanceBulkSelectForms(root) {
    root.querySelectorAll(`form[data-bulk-select-form]:not([${ENHANCED}~="bulk-select"])`).forEach(form => {
      const checkboxes = Array.from(form.querySelectorAll('input[type="checkbox"][name="pick"]'));
      const count = form.querySelector('[data-selected-count]');
      const selectAll = form.querySelector('[data-select-all]');
      const clear = form.querySelector('[data-clear-selection]');
      const submit = form.querySelector('[data-bulk-submit]');
      if (!checkboxes.length || !count || !submit) return;

      form.setAttribute(ENHANCED, `${form.getAttribute(ENHANCED) || ''} bulk-select`.trim());
      const update = () => {
        const selected = checkboxes.filter(checkbox => checkbox.checked).length;
        count.textContent = String(selected);
        submit.disabled = selected === 0;
        submit.setAttribute('aria-disabled', String(selected === 0));
        submit.textContent = selected === 0
          ? 'Select at least one risk'
          : `Add ${selected} risk${selected === 1 ? '' : 's'} to register`;
      };
      form.addEventListener('change', event => {
        if (event.target instanceof HTMLInputElement && event.target.matches('input[type="checkbox"][name="pick"]')) update();
      });
      selectAll?.addEventListener('click', () => {
        checkboxes.forEach(checkbox => { checkbox.checked = true; });
        update();
      });
      clear?.addEventListener('click', () => {
        checkboxes.forEach(checkbox => { checkbox.checked = false; });
        update();
      });
      update();
    });
  }

  function legacyConfirmMessage(source) {
    const match = String(source || '').match(/^\s*return\s+confirm\((['"])([\s\S]*)\1\);?\s*$/);
    if (!match) return '';
    return match[2].replace(/\\([\\'"nrt])/g, (_, character) => ({ n: '\n', r: '\r', t: '\t' }[character] || character));
  }

  function confirmOptions(message) {
    const danger = /delete|remove|revoke|deactivate|archive|emergency|un-confirm/i.test(message);
    return {
      danger,
      kind: danger ? 'Confirm action' : 'Please confirm',
      okLabel: danger ? 'Confirm action' : 'Continue',
    };
  }

  function enhanceLegacyConfirmations(root) {
    if (typeof window.appConfirm !== 'function') return;
    root.querySelectorAll(`form[onsubmit]:not([${ENHANCED}~="confirm"])`).forEach(form => {
      const message = legacyConfirmMessage(form.getAttribute('onsubmit'));
      if (!message) return;
      form.removeAttribute('onsubmit');
      form.setAttribute(ENHANCED, `${form.getAttribute(ENHANCED) || ''} confirm`.trim());
      form.addEventListener('submit', event => {
        if (form._csConfirmAccepted) {
          form._csConfirmAccepted = false;
          return;
        }
        event.preventDefault();
        const submitter = event.submitter;
        window.appConfirm(message, confirmOptions(message)).then(approved => {
          if (!approved) return;
          form._csConfirmAccepted = true;
          if (submitter) form.requestSubmit(submitter);
          else form.requestSubmit();
        });
      });
    });
    root.querySelectorAll(`[onclick]:not([${ENHANCED}~="confirm"])`).forEach(button => {
      const message = legacyConfirmMessage(button.getAttribute('onclick'));
      if (!message) return;
      button.removeAttribute('onclick');
      button.setAttribute(ENHANCED, `${button.getAttribute(ENHANCED) || ''} confirm`.trim());
      button.addEventListener('click', event => {
        if (button._csConfirmAccepted) {
          button._csConfirmAccepted = false;
          return;
        }
        event.preventDefault();
        window.appConfirm(message, confirmOptions(message)).then(approved => {
          if (!approved) return;
          button._csConfirmAccepted = true;
          button.click();
        });
      });
    });
  }

  function installScrollTools() {
    let backButton = document.getElementById('backToTop');
    if (!backButton) {
      backButton = document.createElement('button');
      backButton.type = 'button';
      backButton.id = 'backToTop';
      backButton.className = 'back-to-top';
      backButton.setAttribute('aria-label', 'Back to top');
      backButton.textContent = '↑';
      backButton.addEventListener('click', () => document.querySelector('.main')?.scrollTo({ top: 0, behavior: 'smooth' }));
      document.body.appendChild(backButton);
    }

    const main = document.querySelector('.main');
    if (!main) return;
    if (observedMain && observedMain !== main) observedMain.removeEventListener('scroll', updateScrollTools);
    observedMain = main;
    if (!main.querySelector('.page-scroll-progress')) {
      const rail = document.createElement('div');
      rail.className = 'page-scroll-progress';
      rail.setAttribute('role', 'progressbar');
      rail.setAttribute('aria-label', 'Page scroll progress');
      rail.setAttribute('aria-valuemin', '0');
      rail.setAttribute('aria-valuemax', '100');
      rail.innerHTML = '<span></span>';
      main.prepend(rail);
    }
    main.removeEventListener('scroll', updateScrollTools);
    main.addEventListener('scroll', updateScrollTools, { passive: true });
    updateScrollTools();
  }

  function updateScrollTools() {
    const main = document.querySelector('.main');
    const rail = main?.querySelector('.page-scroll-progress');
    const maximum = main ? Math.max(0, main.scrollHeight - main.clientHeight) : 0;
    const percentage = maximum ? Math.min(100, Math.round((main.scrollTop / maximum) * 100)) : 0;
    if (rail) {
      rail.querySelector('span').style.width = `${percentage}%`;
      rail.setAttribute('aria-valuenow', String(percentage));
    }
    document.getElementById('backToTop')?.classList.toggle('is-visible', !!main && main.scrollTop > 480);
  }

  function addLastRefreshed(root) {
    const container = root.querySelector('.main-inner');
    if (!container) return;
    let meta = container.querySelector('.app-page-meta');
    if (meta) return;
    meta = document.createElement('footer');
    meta.className = 'app-page-meta';
    meta.innerHTML = 'Last refreshed <time></time>';
    container.appendChild(meta);
    const time = meta.querySelector('time');
    const now = new Date();
    time.dateTime = now.toISOString();
    time.textContent = now.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function installFloatingContact() {
    const clientShell = document.querySelector('.client-portal-context-name');
    let button = document.getElementById('floatingContact');
    if (!clientShell) {
      button?.remove();
      return;
    }
    const emailLink = document.querySelector('.main a[href^="mailto:"]');
    if (!button) {
      button = document.createElement('a');
      button.id = 'floatingContact';
      button.className = 'floating-contact';
      button.textContent = 'Contact team';
      document.body.appendChild(button);
    }
    if (emailLink) {
      button.href = emailLink.href;
      button.removeAttribute('role');
      button.onclick = null;
    } else {
      button.href = '#';
      button.setAttribute('role', 'button');
      button.onclick = event => {
        event.preventDefault();
        if (typeof window.openHelp === 'function') window.openHelp();
      };
    }
  }

  function enhanceDialogs() {
    const confirm = document.getElementById('appConfirmModal');
    if (confirm) {
      confirm.setAttribute('role', 'dialog');
      confirm.setAttribute('aria-modal', 'true');
      confirm.setAttribute('aria-labelledby', 'appConfirmKind');
      confirm.setAttribute('aria-describedby', 'appConfirmBody');
    }
    const help = document.getElementById('helpBackdrop');
    if (help) {
      help.setAttribute('role', 'dialog');
      help.setAttribute('aria-modal', 'true');
    }
  }

  function enhancePage() {
    const main = document.querySelector('.main');
    enhancePasswords(document);
    enhanceCopyBlocks(main || document);
    enhanceBulkSelectForms(main || document);
    enhanceLegacyConfirmations(main || document);
    addLastRefreshed(document);
    installScrollTools();
    installFloatingContact();
    enhanceDialogs();
    installThemeControls();
    syncThemeControls();
  }

  function scheduleEnhancement() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(enhancePage, 60);
  }

  document.addEventListener('click', event => {
    const themeToggle = event.target.closest('[data-theme-toggle]');
    if (themeToggle) {
      event.preventDefault();
      toggleThemeState();
      return;
    }
    const copyButton = event.target.closest('[data-copy-text], [data-copy-target]');
    if (!copyButton) return;
    const target = copyButton.dataset.copyTarget ? document.querySelector(copyButton.dataset.copyTarget) : null;
    copyText(copyButton.dataset.copyText || target?.textContent || '', copyButton);
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById('sidebar')?.classList.contains('open') && typeof window.toggleSidebar === 'function') {
      window.toggleSidebar(false);
    }
  });

  const themeObserver = new MutationObserver(syncThemeControls);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function init() {
    installCookieBanner();
    installFormValidation();
    enhancePage();
    const app = document.getElementById('app') || document.body;
    new MutationObserver(scheduleEnhancement).observe(app, { childList: true, subtree: true });
    window.addEventListener('resize', updateScrollTools, { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
