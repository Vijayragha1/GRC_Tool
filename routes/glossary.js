// Glossary routes. Second slice of the server.js modularization; follows the
// register(app, deps) pattern established by routes/tenants.js.
//
// Routes:
//   GET /glossary        searchable 168-term reference, firm-level chrome
//   GET /glossary/:slug  single entry with resolvable clause/Annex-A links
//
// Side benefit of the extraction: the escapeHtml defined here used to shadow
// the app-wide escapeHtml in server.js (same behaviour, but a landmine).

function register(app, deps) {
  const { db, requireAuth, isFirmUser, listWorkspaces } = deps;

  // Workspace-agnostic learning resource. Static content, no DB.
  const GLOSSARY = require('../data/glossary');

  // Set of valid iso_items.id values, computed once at boot. Used to decide
  // whether a clause/Annex-A reference in glossary text resolves to a real
  // page in the tool - only resolvable refs become clickable.
  const ISO_ITEM_IDS = new Set(db.prepare('SELECT id FROM iso_items').all().map(r => r.id));

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Render a clauseRef string with recognised refs as <a> links. Caller passes
  // the workspace ID to use as the link target. If wsId is missing, returns
  // plain escaped text - refs are not clickable without a workspace.
  function renderClauseRefHtml(text, wsId) {
    const escaped = escapeHtml(text);
    if (!text || !wsId) return escaped;
    let html = escaped;
    // Annex A - match A.X or A.X.Y. Longer match attempted first.
    html = html.replace(/A\.\d+(?:\.\d+)?/g, (m) => {
      const slug = 'annex-' + m.toLowerCase();
      if (ISO_ITEM_IDS.has(slug)) {
        return `<a href="/workspaces/${wsId}/controls/${slug}" style="color:var(--accent);text-decoration:none;border-bottom:1px dotted var(--accent);">${m}</a>`;
      }
      return m;
    });
    // Clause refs - match "Clause(s) N[, N, …]" where each N is a dotted number
    // optionally followed by a sub-section letter. Resolves each number to the
    // longest existing clause-id prefix and wraps it in a link.
    function linkClauseToken(token) {
      // token might be "6.1.2" or "6.1.3.d.1". The slug uses only the digit prefix.
      const digitMatch = token.match(/^\d+(?:\.\d+){0,2}/);
      if (!digitMatch) return token;
      const parts = digitMatch[0].split('.');
      while (parts.length > 0) {
        const candidate = 'clause-' + parts.join('.');
        if (ISO_ITEM_IDS.has(candidate)) {
          return `<a href="/workspaces/${wsId}/controls/${candidate}" style="color:var(--accent);text-decoration:none;border-bottom:1px dotted var(--accent);">${token}</a>`;
        }
        parts.pop();
      }
      return token;
    }
    html = html.replace(/(Clauses?\s+)(\d+(?:\.\d+){0,2}(?:\.[a-z](?:\.\d+)?)?(?:\s*,\s*\d+(?:\.\d+){0,2}(?:\.[a-z](?:\.\d+)?)?)*)/g,
      (whole, prefix, list) => prefix + list.replace(/\d+(?:\.\d+){0,2}(?:\.[a-z](?:\.\d+)?)?/g, linkClauseToken)
    );
    return html;
  }

  function firstWorkspaceIdFor(user) {
    const ws = listWorkspaces(user)[0];
    return ws ? ws.id : null;
  }

  app.get('/glossary', requireAuth, (req, res) => {
    if (!isFirmUser(req.user)) {
      return res.status(403).render('error', { user: req.user, message: 'This area is for firm staff only.' });
    }
    const q = (req.query.q || '').toString();
    const category = (req.query.category || 'all').toString();
    const letter = (req.query.letter || 'all').toString();
    const results = GLOSSARY.searchEntries(q, category, letter)
      .slice()
      .sort((a, b) => a.term.localeCompare(b.term));
    // Letter buckets - only show letters that have entries (post-filter, so the bar reflects what's available).
    const letterCounts = {};
    for (const e of GLOSSARY.ENTRIES) {
      const first = /[A-Z]/.test(e.term[0]) ? e.term[0].toUpperCase() : '#';
      letterCounts[first] = (letterCounts[first] || 0) + 1;
    }
    // Category counts (across full corpus, ignoring search filter - so users see what's available).
    const categoryCounts = {};
    for (const e of GLOSSARY.ENTRIES) categoryCounts[e.category] = (categoryCounts[e.category] || 0) + 1;
    const starter = GLOSSARY.STARTER_TERMS
      .map(slug => GLOSSARY.ENTRIES.find(e => e.slug === slug))
      .filter(Boolean);
    const linkWsId = firstWorkspaceIdFor(req.user);
    // Firm-level reference page: always render with the firm sidebar. The Glossary
    // nav link only appears in the firm-level nav, so inheriting a sticky
    // last-visited workspace would strand the user in a client's chrome - the
    // active nav item vanishes and it reads as "landing in a client page". The
    // client switcher still highlights the last-viewed workspace via
    // res.locals.lastWs, so no context is lost.
    res.render('glossary', {
      user: req.user,
      ws: null,
      title: 'Glossary',
      active: 'glossary',
      q, category, letter,
      results,
      total: GLOSSARY.ENTRIES.length,
      letterCounts,
      categoryCounts,
      categories: GLOSSARY.CATEGORIES,
      starter,
      renderClauseRef: (t) => renderClauseRefHtml(t, linkWsId)
    });
  });

  app.get('/glossary/:slug', requireAuth, (req, res) => {
    const idx = GLOSSARY.indexBySlug();
    const entry = idx[req.params.slug];
    if (!entry) return res.status(404).render('error', { user: req.user, message: 'No glossary entry with that slug. The 168 terms shipped with the tool are listed at /glossary - try searching there.' });
    const related = (entry.related || []).map(s => idx[s]).filter(Boolean);
    const categoryLabel = (GLOSSARY.CATEGORIES.find(c => c.key === entry.category) || {}).label || entry.category;
    const linkWsId = firstWorkspaceIdFor(req.user);
    res.render('glossary_detail', {
      user: req.user,
      ws: null, // firm-level reference page - see GET /glossary note
      title: entry.term,
      active: 'glossary',
      entry,
      related,
      categoryLabel,
      categories: GLOSSARY.CATEGORIES,
      renderClauseRef: (t) => renderClauseRefHtml(t, linkWsId)
    });
  });
}

module.exports = { register };
