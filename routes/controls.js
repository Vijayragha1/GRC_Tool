'use strict';
// Controls cluster. Slice 7 of the server.js modularization: controls list +
// detail, the guided gap-assessment wizard, flag-for-review (ISO 27001), and
// assessment passes.

const rbac = require('../lib/rbac');
const enc = require('../lib/encryption');
const fts = require('../lib/fts');
const jobs = require('../lib/jobs');
const ctlReads = require('../lib/control-reads');
const ctlWrites = require('../lib/control-writes');
const evReads = require('../lib/evidence-reads');
const docLinks = require('../lib/doc-links');
const { withToast, redirectBack, auditCtx, parseFormArray, escapeHtml } = require('../lib/http-helpers');

// The ISO 42001 flag-for-review flow in server.js reuses the reviewer
// fan-out. notifyReviewers closes over deps, so the export is bound at
// register() time through this ref.
let notifyReviewersRef = null;

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction, getOrCreateState } = deps;

  // ==================== CONTROLS LIST + DETAIL ====================
  app.get('/workspaces/:wsId/controls', requireAuth, requireWorkspace, (req, res) => {
    const filter = req.query.filter || 'all';
    const search = (req.query.q || '').trim().toLowerCase();
    const T = ctlReads.tables(db, req.workspace.id);
    let rows = db.prepare(`SELECT i.*, COALESCE(cs.status,'Not Assessed') AS status,
        cs.applicability, cs.maturity, cs.owner_id, cs.due_date,
        (SELECT name FROM users WHERE id = cs.owner_id) AS owner_name
        FROM iso_items i
        LEFT JOIN ${T.cs} cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
        ORDER BY i.sort_order`).all(req.workspace.id);

    if (filter === 'clauses') rows = rows.filter(r => r.type === 'clause');
    else if (filter === 'annex') rows = rows.filter(r => r.type === 'control');
    else if (filter === 'org') rows = rows.filter(r => r.category === 'org');
    else if (filter === 'people') rows = rows.filter(r => r.category === 'people');
    else if (filter === 'physical') rows = rows.filter(r => r.category === 'physical');
    else if (filter === 'tech') rows = rows.filter(r => r.category === 'tech');
    else if (filter === 'open') rows = rows.filter(r => ['Not Implemented','Partially Implemented','Not Assessed'].includes(r.status));
    if (search) rows = rows.filter(r => r.title.toLowerCase().includes(search) || r.id.toLowerCase().includes(search));

    res.render('controls', { user: req.user, ws: req.workspace, rows, filter, search });
  });

  // ==================== GUIDED GAP ASSESSMENT WIZARD ====================
  // Walks ISO 27001:2022 main body clauses (4–10) AND Annex A controls one at a time,
  // surfacing the existing iso_items prompts so a fresher has a structured path through
  // all 118 items instead of staring at a table.

  // Per-item diagnostic questions - bespoke for the 25 main-body clauses and high-impact
  // controls; mechanical transformation of evidence_needed for the rest. See
  // data/assessment-questions.js. Answers drive the suggested-status hint.
  const { getQuestions: getAssessmentQuestions } = require('../data/assessment-questions');
  function suggestStatusFromAnswers(answers, totalQuestions) {
    if (!answers || !totalQuestions) return null;
    const score = { yes: 1, partial: 0.5, no: 0 };
    const vals = [];
    for (let i = 0; i < totalQuestions; i++) {
      if (answers[String(i)] != null) vals.push(answers[String(i)]);
    }
    if (vals.length < totalQuestions) return null; // need all answered
    const ratio = vals.reduce((s, v) => s + (score[v] || 0), 0) / vals.length;
    if (ratio >= 0.85) return 'Implemented';
    if (ratio >= 0.5)  return 'Partially Implemented';
    if (ratio > 0)     return 'Work In Progress';
    return 'Not Implemented';
  }

  function nextUnassessedItem(wsId, afterSortOrder) {
    return db.prepare(`SELECT i.id FROM iso_items i
      LEFT JOIN v_control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type IN ('clause','control')
        AND (cs.status IS NULL OR cs.status='Not Assessed')
        AND i.sort_order > ?
      ORDER BY i.sort_order LIMIT 1`).get(wsId, afterSortOrder || 0);
  }

  // Post-assessment summary - converts a completed gap walkthrough into a worklist:
  // remediation tasks, missing documents, evidence asks, untreated linked risks.
  app.get('/workspaces/:wsId/controls/assess/summary', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const wsId = req.workspace.id;

    // Gaps = anything Not Implemented / Partially Implemented / Work In Progress
    // (clauses + controls). Excludes Not Applicable and Not Assessed (those are different problems).
    // max_risk_score is the worst L*I across linked risks - used to bump priority for
    // Not-Implemented controls protecting high-impact risks.
    const T = ctlReads.tables(db, wsId);
    const gaps = db.prepare(`
      SELECT i.id, i.type, i.title, i.category, cs.status, cs.maturity, cs.notes,
        EXISTS (SELECT 1 FROM tasks t WHERE t.workspace_id=? AND t.iso_item_id=i.id AND t.status NOT IN ('done')) AS has_open_task,
        (SELECT MAX(r.likelihood * r.impact) FROM risk_controls rc
         INNER JOIN risks r ON r.id = rc.risk_id
         WHERE rc.iso_item_id = i.id AND r.workspace_id = ?) AS max_risk_score
      FROM iso_items i
      INNER JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type IN ('clause','control')
        AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
      ORDER BY i.sort_order`).all(wsId, wsId, wsId);

    // Items still Not Assessed
    const notAssessedCount = db.prepare(`SELECT COUNT(*) c FROM iso_items i
      LEFT JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type IN ('clause','control') AND (cs.status IS NULL OR cs.status='Not Assessed')`).get(wsId).c;

    // Items needing a policy/procedure: status not Implemented AND no document linked
    const docGaps = db.prepare(`
      SELECT i.id, i.type, i.title, cs.status FROM iso_items i
      INNER JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type IN ('clause','control')
        AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
        AND NOT EXISTS (SELECT 1 FROM ${docLinks.docControlsExpr('iso27001')} dc INNER JOIN generated_docs d ON d.id=dc.document_id
                        WHERE dc.iso_item_id=i.id AND d.workspace_id=?)
      ORDER BY i.sort_order`).all(wsId, wsId);

    // Items marked Implemented but with NO evidence files attached - auditor will press on these
    const evidenceAsks = db.prepare(`
      SELECT i.id, i.type, i.title FROM iso_items i
      INNER JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type IN ('clause','control') AND cs.status='Implemented'
        AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.iso_item_id=i.id AND e.workspace_id=?)
      ORDER BY i.sort_order`).all(wsId, wsId);

    // Risks linked to gap-state controls (treatment plan needs updating)
    const untreatedLinkedRisks = db.prepare(`
      SELECT r.id, r.title, r.likelihood, r.impact, r.status,
        GROUP_CONCAT(DISTINCT i.id || '|' || cs.status) AS blocking_controls
      FROM risks r INNER JOIN risk_controls rc ON rc.risk_id=r.id
      INNER JOIN iso_items i ON i.id=rc.iso_item_id
      INNER JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE r.workspace_id=? AND r.status='open'
        AND cs.status IN ('Not Implemented','Partially Implemented','Work In Progress')
      GROUP BY r.id, r.title, r.likelihood, r.impact, r.status
      ORDER BY (r.likelihood * r.impact) DESC`).all(wsId, wsId);

    // Status distribution for header
    const dist = { Implemented: 0, 'Partially Implemented': 0, 'Work In Progress': 0, 'Not Implemented': 0, 'Not Applicable': 0, 'Not Assessed': 0 };
    db.prepare(`SELECT COALESCE(cs.status,'Not Assessed') AS s, COUNT(*) AS c
      FROM iso_items i LEFT JOIN ${T.cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type IN ('clause','control') GROUP BY s`).all(wsId).forEach(r => { dist[r.s] = r.c; });

    res.render('controls_assess_summary', {
      user: req.user, ws: req.workspace, gaps, docGaps, evidenceAsks, untreatedLinkedRisks,
      notAssessedCount, dist,
      active: 'gap-assessment-summary'
    });
  });

  // Bulk-spawn remediation tasks for selected gap items.
  // Priority is derived from the gap severity:
  //   Not Implemented + clause           → critical (mandatory shall not met)
  //   Not Implemented + control linked to high-risk → critical
  //   Not Implemented (control)          → high
  //   Partially Implemented              → normal
  //   Work In Progress                   → low (already being worked)
  app.post('/workspaces/:wsId/controls/assess/summary/spawn-tasks', requireAuth, requireWorkspace, requirePermission('task.manage'), (req, res) => {
    const ids = parseFormArray(req.body.iso_id);
    if (!ids.length) return redirectBack(req, res);
    const due = req.body.due_date || null;
    const ins = db.prepare(`INSERT INTO tasks (workspace_id, title, description, iso_item_id, due_date, status, priority, created_by)
                            VALUES (?, ?, ?, ?, ?, 'todo', ?, ?)`);
    // Re-check open-task existence inside the transaction. The post-assessment
    // summary view filters with `has_open_task` at render time, but two
    // consultants both looking at the same list and both clicking "Spawn" would
    // each INSERT — duplicate "Remediate A.5.15…" tasks for the same control.
    // This statement is run per id at commit time, so it catches concurrent
    // spawns no matter when the render happened.
    const hasOpen = db.prepare(`SELECT 1 FROM tasks
       WHERE workspace_id = ? AND iso_item_id = ? AND status NOT IN ('done','closed','cancelled') LIMIT 1`);
    let added = 0, skipped = 0;
    const tx = db.transaction(() => {
      for (const id of ids) {
        if (hasOpen.get(req.workspace.id, id)) { skipped++; continue; }
        const item = db.prepare(`SELECT i.id, i.type, i.title, cs.status, cs.notes,
          (SELECT MAX(r.likelihood * r.impact) FROM risk_controls rc
           INNER JOIN risks r ON r.id = rc.risk_id
           WHERE rc.iso_item_id = i.id AND r.workspace_id = ?) AS max_risk_score
          FROM iso_items i
          LEFT JOIN v_control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
          WHERE i.id=?`).get(req.workspace.id, req.workspace.id, id);
        if (!item) continue;
        const cleanTitle = item.title.replace(/^A\.[0-9.]+ /,'').replace(/^[0-9.]+ /,'');
        const taskTitle = `Remediate ${item.id.replace('annex-','').replace('clause-','').toUpperCase()} - ${cleanTitle}`;
        let priority = 'normal';
        if (item.status === 'Not Implemented') {
          if (item.type === 'clause') priority = 'critical';
          else if ((item.max_risk_score || 0) >= 16) priority = 'critical';
          else priority = 'high';
        } else if (item.status === 'Partially Implemented') priority = 'normal';
        else if (item.status === 'Work In Progress') priority = 'low';
        ins.run(req.workspace.id, taskTitle, item.notes || `Close the gap identified in the gap assessment for ${item.title}.`, item.id, due, priority, req.user.id);
        added++;
      }
    });
    tx();
    logAction(req.user.id, req.workspace.id, 'spawn_remediation_tasks', 'task', null, { count: added, skipped }, auditCtx(req));
    const skippedNote = skipped > 0 ? ` (skipped ${skipped} item${skipped === 1 ? '' : 's'} that already had an open task)` : '';
    res.redirect(withToast(`/workspaces/${req.workspace.id}/controls/assess/summary`, `Spawned ${added} remediation task${added === 1 ? '' : 's'} with auto-priority${skippedNote}`));
  });

  app.get('/workspaces/:wsId/controls/assess', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    // Optional ?start=clauses or ?start=controls to jump into a specific section.
    const start = req.query.start;
    if (start === 'clauses') {
      const c = db.prepare(`SELECT id FROM iso_items WHERE type='clause' ORDER BY sort_order LIMIT 1`).get();
      if (c) return res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${c.id}`);
    }
    if (start === 'controls') {
      const c = db.prepare(`SELECT id FROM iso_items WHERE type='control' ORDER BY sort_order LIMIT 1`).get();
      if (c) return res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${c.id}`);
    }
    const next = nextUnassessedItem(req.workspace.id, 0);
    if (next) return res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${next.id}`);
    const first = db.prepare(`SELECT id FROM iso_items WHERE type IN ('clause','control') ORDER BY sort_order LIMIT 1`).get();
    res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${first.id}?done=1`);
  });

  app.get('/workspaces/:wsId/controls/assess/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res, nextMw) => {
    // Reserved literal sub-routes - let them fall through to their own handlers
    // registered later in the file.
    if (['summary.docx'].includes(req.params.isoId)) return nextMw();
    const item = db.prepare(`SELECT * FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(req.params.isoId);
    if (!item) return res.status(404).send('ISO item not found');
    item.questions = JSON.parse(item.questions || '[]');
    item.evidence_needed = JSON.parse(item.evidence_needed || '[]');
    item.documentation_needed = JSON.parse(item.documentation_needed || '[]');
    // Audit-grade content (data/iso-content.js → iso_items columns). Parsed once
    // here so the template doesn't have to know about JSON encoding.
    item.common_pitfalls = item.common_pitfalls ? JSON.parse(item.common_pitfalls) : null;
    item.evidence_to_look_for = item.evidence_to_look_for ? JSON.parse(item.evidence_to_look_for) : null;
    item.maturity_ladder = item.maturity_ladder ? JSON.parse(item.maturity_ladder) : null;
    item.related_items = item.related_items ? JSON.parse(item.related_items) : null;

    const state = getOrCreateState(req.workspace.id, item.id);

    // Two-section progress: clauses 4–10 (mandatory shalls) + Annex A controls.
    const totals = db.prepare(`SELECT
      (SELECT COUNT(*) FROM iso_items WHERE type='clause') AS clausesTotal,
      (SELECT COUNT(*) FROM iso_items WHERE type='control') AS controlsTotal,
      (SELECT COUNT(*) FROM iso_items i INNER JOIN v_control_states cs ON cs.iso_item_id=i.id
       WHERE i.type='clause' AND cs.workspace_id=? AND cs.status NOT IN ('Not Assessed')) AS clausesAssessed,
      (SELECT COUNT(*) FROM iso_items i INNER JOIN v_control_states cs ON cs.iso_item_id=i.id
       WHERE i.type='control' AND cs.workspace_id=? AND cs.status NOT IN ('Not Assessed')) AS controlsAssessed`).get(req.workspace.id, req.workspace.id);

    // Sequential nav across all clause+control items.
    const allOrder = db.prepare(`SELECT id, type FROM iso_items WHERE type IN ('clause','control') ORDER BY sort_order`).all();
    const position = allOrder.findIndex(r => r.id === item.id) + 1;
    const prevId = position > 1 ? allOrder[position - 2].id : null;
    const nextById = position < allOrder.length ? allOrder[position].id : null;

    // Theme-jump navigator data. A real consultant doesn't walk 118 items
    // sequentially — they bounce between themes. The nav builds an index of
    // every clause + control with its current assessment status, grouped into
    // (a) main clauses by section, (b) Annex A by category.
    const navRows = db.prepare(`SELECT i.id, i.type, i.category, i.title, i.sort_order,
        COALESCE(cs.status, 'Not Assessed') AS status
      FROM iso_items i
      LEFT JOIN v_control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type IN ('clause','control')
      ORDER BY i.sort_order`).all(req.workspace.id);
    const navGroups = [
      { key: 'clauses', label: 'Main clauses', items: navRows.filter(r => r.type === 'clause') },
      { key: 'org',     label: 'A.5 Organisational', items: navRows.filter(r => r.type === 'control' && r.category === 'org') },
      { key: 'people',  label: 'A.6 People',         items: navRows.filter(r => r.type === 'control' && r.category === 'people') },
      { key: 'physical',label: 'A.7 Physical',       items: navRows.filter(r => r.type === 'control' && r.category === 'physical') },
      { key: 'tech',    label: 'A.8 Technological',  items: navRows.filter(r => r.type === 'control' && r.category === 'tech') }
    ].map(g => {
      const done = g.items.filter(r => r.status !== 'Not Assessed').length;
      return { ...g, done, total: g.items.length };
    });

    // Position within own section (e.g., "Clause 5 of 25" or "Control 12 of 93")
    const sameType = allOrder.filter(r => r.type === item.type);
    const sectionPosition = sameType.findIndex(r => r.id === item.id) + 1;

    // Per-item diagnostic questions (bespoke or mechanically derived)
    const questions = getAssessmentQuestions(item);
    let savedAnswers = {};
    try { if (state.assessment_answers) savedAnswers = JSON.parse(state.assessment_answers) || {}; } catch (e) {}
    const suggestedStatus = suggestStatusFromAnswers(savedAnswers, questions.length);

    // Resolve related item ids → titles for cross-reference rendering
    let relatedRows = [];
    if (item.related_items && item.related_items.length) {
      const placeholders = item.related_items.map(() => '?').join(',');
      relatedRows = db.prepare(`SELECT id, type, title FROM iso_items WHERE id IN (${placeholders})`).all(...item.related_items);
    }

    // Evidence files attached to this control - displayed in a panel on the wizard
    // since the standalone control detail page was removed and there's no other home.
    // Evidence linked to this control via either the primary
    // (evidence.iso_item_id) OR the converged evidence_requirement_links join. UNION
    // because the primary is also represented in erl, but a non-primary join
    // entry might exist independently.
    const evidenceList = evReads.controlPanelEvidence(db, req.workspace.id, item.id);

    // Linked risks, documents, and open NCs - read-only summary panels.
    const linkedRisks = db.prepare(`SELECT r.id, r.title, r.likelihood, r.impact, r.status
      FROM risks r INNER JOIN risk_controls rc ON rc.risk_id=r.id
      WHERE rc.iso_item_id=? AND r.workspace_id=?
      ORDER BY (r.likelihood * r.impact) DESC`).all(item.id, req.workspace.id);

    // Doc links are drl-native (document_controls demolished, migration 018).
    // link_id = drl.id, which the unlink route deletes.
    const linkedDocs = docLinks.linkedDocsForControl(db, 'iso27001', item.id, req.workspace.id);
    // Workspace's documents that aren't already linked - the add-link dropdown.
    const linkableDocs = db.prepare(`SELECT id, name, category, status FROM generated_docs
      WHERE workspace_id=? AND id NOT IN (${docLinks.linkedDocIdsSubquery()})
      ORDER BY name`).all(req.workspace.id, 'iso27001', item.id);

    const openNCs = db.prepare(`SELECT id, title, severity, status, due_date FROM nonconformities
      WHERE iso_item_id=? AND workspace_id=? AND status NOT IN ('closed','verified')
      ORDER BY (CASE severity WHEN 'major' THEN 0 WHEN 'minor' THEN 1 ELSE 2 END), due_date IS NULL, due_date`).all(item.id, req.workspace.id);

    // Crosswalks - which other frameworks this control also satisfies. Read from
    // the framework_mappings table seeded from data/framework-mappings.js. ISO
    // 27001 Annex A is the keyed side; the value is a free-text external ref
    // (e.g., "CC6.1, CC6.2") in the target framework. Clauses don't carry
    // mappings today, so the result is empty for them.
    const crosswalks = db.prepare(
      `SELECT framework, external_ref, notes FROM framework_mappings
       WHERE iso_item_id = ? ORDER BY framework`
    ).all(item.id);
    const crosswalksByFramework = {};
    for (const m of crosswalks) {
      if (!crosswalksByFramework[m.framework]) crosswalksByFramework[m.framework] = [];
      crosswalksByFramework[m.framework].push(m);
    }

    // Per-pass notes - derived from history. The current pass's textarea shows
    // ONLY notes saved within the active pass; prior-pass notes appear above as
    // read-only context blocks so the consultant can verify against earlier
    // commentary without overwriting it. This is the per-pass-notes contract:
    // each pass keeps its own free-text record, anchored to history.
    const activePass = getActivePass(req.workspace.id);
    let currentPassNotes = '';
    if (activePass) {
      const cur = db.prepare(`SELECT notes FROM control_state_history
        WHERE workspace_id=? AND iso_item_id=? AND pass_id=?
        ORDER BY snapshot_at DESC, id DESC LIMIT 1`).get(req.workspace.id, item.id, activePass.id);
      if (cur && cur.notes) currentPassNotes = cur.notes;
    }
    // Fallback to the live state notes when no history row exists for the
    // active pass yet. Without this, anything written via autosave (which
    // writes only to control_states.notes, not to control_state_history) is
    // invisible until someone clicks the explicit Save button. That meant
    // consultant B opened a control after consultant A had typed notes and saw
    // an empty textarea, even though the data was sitting in the live state.
    if (!currentPassNotes && state && state.notes) currentPassNotes = state.notes;
    // Latest snapshot per prior pass (one row per pass that touched this item).
    // Excludes the active pass; ordered most recent prior pass first.
    const priorPassNotes = db.prepare(`
      SELECT p.pass_number, p.label, p.completed_at, p.status AS pass_status,
             h.notes, h.status AS item_status, h.maturity, h.snapshot_at
      FROM (
        SELECT MAX(id) AS max_id, pass_id
        FROM control_state_history
        WHERE workspace_id=? AND iso_item_id=? AND pass_id IS NOT NULL ${activePass ? 'AND pass_id != ?' : ''}
        GROUP BY pass_id
      ) latest
      INNER JOIN control_state_history h ON h.id = latest.max_id
      INNER JOIN assessment_passes p ON p.id = h.pass_id
      WHERE h.notes IS NOT NULL AND TRIM(h.notes) != ''
      ORDER BY p.pass_number DESC
    `).all(...(activePass ? [req.workspace.id, item.id, activePass.id] : [req.workspace.id, item.id]));

    // Comments thread + @-mention hints. Comments are scoped to this workspace
    // and this iso_item via parent_type/parent_id. Decryption is a no-op if the
    // workspace doesn't have encryption_enabled set.
    const commentsRaw = db.prepare(`SELECT c.id, c.body, c.internal_only, c.created_at, c.user_id, u.name AS user_name
      FROM comments c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.workspace_id=? AND c.parent_type='iso_item' AND c.parent_id=?
      ORDER BY c.created_at ASC`).all(req.workspace.id, item.id);
    const comments = commentsRaw.map(c => ({ ...c, body: enc.decryptIfNeeded(c.body, req.workspace.id) }));
    const firmUsers = db.prepare(`SELECT id, name FROM users WHERE firm_id=? AND user_type='firm' AND active=1 ORDER BY name`).all(req.workspace.firm_id);

    // Review state + reviewer/requester names for the flag-for-review badge
    let requestedByName = null, reviewedByName = null;
    if (state.review_requested_by) requestedByName = db.prepare(`SELECT name FROM users WHERE id=?`).get(state.review_requested_by)?.name;
    if (state.reviewed_by) reviewedByName = db.prepare(`SELECT name FROM users WHERE id=?`).get(state.reviewed_by)?.name;
    // Can this user act on a flagged item? Reviewers = anyone with firm role of manager/senior_consultant.
    const isReviewer = req.user.user_type === 'firm' && ['manager','senior_consultant'].includes(rbac.normalizeRole(req.user.firm_role));

    res.render('controls_assess', {
      user: req.user, ws: req.workspace, item, state, totals, position, sectionPosition, relatedRows,
      prevId, nextId: nextById, doneFlag: !!req.query.done,
      questions, savedAnswers, suggestedStatus,
      evidenceList, linkedRisks, linkedDocs, openNCs, linkableDocs,
      activePass, currentPassNotes, priorPassNotes,
      crosswalksByFramework,
      navGroups,
      comments, firmUsers,
      requestedByName, reviewedByName, isReviewer
    });
  });

  app.post('/workspaces/:wsId/controls/assess/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const item = db.prepare(`SELECT id, sort_order, type FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(req.params.isoId);
    if (!item) return res.status(404).send('Not found');
    getOrCreateState(req.workspace.id, item.id);

    const { applicability, status, maturity, inclusion_justification, exclusion_justification, notes, scope_pct, last_updated_snapshot } = req.body;
    const sets = [], vals = [];
    // Clauses are not subject to SoA applicability - every certified ISMS must satisfy them.
    if (item.type === 'control' && applicability !== undefined) { sets.push('applicability=?'); vals.push(applicability); }
    if (item.type === 'clause') { sets.push('applicability=?'); vals.push('included'); }
    if (status !== undefined) { sets.push('status=?'); vals.push(status); }
    if (maturity !== undefined && maturity !== '') { sets.push('maturity=?'); vals.push(parseInt(maturity)); }
    if (item.type === 'control' && inclusion_justification !== undefined) { sets.push('inclusion_justification=?'); vals.push(inclusion_justification || null); }
    if (item.type === 'control' && exclusion_justification !== undefined) { sets.push('exclusion_justification=?'); vals.push(exclusion_justification || null); }
    if (notes !== undefined) { sets.push('notes=?'); vals.push(notes || null); }
    if (scope_pct !== undefined) {
      const n = parseInt(scope_pct, 10);
      sets.push('scope_pct=?'); vals.push(Number.isFinite(n) && n >= 0 && n <= 100 ? n : null);
    }

    // Diagnostic answers - persist as JSON keyed by question index (questions vary per item).
    const answers = {};
    Object.keys(req.body).forEach(k => {
      const m = k.match(/^q_(\d+)$/);
      if (m && ['yes','partial','no'].includes(req.body[k])) answers[m[1]] = req.body[k];
    });
    if (Object.keys(answers).length) { sets.push('assessment_answers=?'); vals.push(JSON.stringify(answers)); }

    sets.push('last_updated=CURRENT_TIMESTAMP');
    // Stamp last_verified_at when the consultant explicitly assesses a control
    // (any save other than "Not Assessed"). This drives the staleness flagger:
    // controls that haven't been touched in 12+ months bubble up for re-assessment.
    if (status && status !== 'Not Assessed') {
      sets.push('last_verified_at=CURRENT_TIMESTAMP');
    }
    // Optimistic-concurrency: gap-assessment forms include the last_updated
    // value they were rendered with. UPDATE WHERE last_updated = ? catches the
    // case where another consultant already saved this control after the form
    // was loaded; the loser gets a friendly conflict page rather than silently
    // overwriting the new state. Pre-CAS form posts (no hidden field) fall
    // through to the old last-writer-wins behaviour for backwards compat.
    const usingCAS = !!last_updated_snapshot;
    // Cutover 4 (W2): on a write-flipped workspace the AUTHORITATIVE state write goes
    // to the converged control_instances (whole-org row); migration 014 mirrors it to
    // control_states. The optimistic-concurrency CAS runs against
    // control_instances.last_updated (the value the form rendered with came from the
    // converged read view), so the conflict path is enforced on the converged table.
    // assessment_answers has no converged column (deferred), so convergeSets drops it
    // and we persist it to legacy control_states. The history INSERT below stays
    // legacy with pass_id per the Phase 4 manifest (it reads `cur` from control_states,
    // kept fresh by the 014 mirror). Fail-safe to the unchanged legacy path otherwise.
    const wConverged = ctlWrites.converged(db, req.workspace.id);
    const wReqId = wConverged ? ctlWrites.requirementId(db, 'iso27001', item.id) : null;
    let result;
    if (wConverged && wReqId) {
      const c = ctlWrites.convergeSets(sets, vals);
      const cVals = c.vals.slice();
      let sql = `UPDATE control_instances SET ${c.sets.join(',')} WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`;
      cVals.push(req.workspace.id, wReqId);
      if (usingCAS) { sql += ` AND last_updated = ?`; cVals.push(last_updated_snapshot); }
      result = db.prepare(sql).run(...cVals);
      // assessment_answers is dead (deferred-drop, control-state demolition 019): no
      // converged home, persistence removed. The diagnostic answers are not stored.
    } else {
      let updateSQL = `UPDATE control_states SET ${sets.join(',')} WHERE workspace_id=? AND iso_item_id=?`;
      vals.push(req.workspace.id, item.id);
      if (usingCAS) {
        updateSQL += ` AND last_updated = ?`;
        vals.push(last_updated_snapshot);
      }
      result = db.prepare(updateSQL).run(...vals);
    }
    if (usingCAS && result.changes === 0) {
      return res.status(409).render('error', {
        user: req.user,
        message: `Another consultant updated ${req.params.isoId.replace('annex-','').replace('clause-','').toUpperCase()} while you were assessing it. Refresh the page to see their changes, then re-apply yours.`
      });
    }

    // Append-only history snapshot - written after the UPDATE so it captures the new
    // values exactly. Post control-state demolition (019): cur sources from the
    // converged view (control_states is gone); values are equivalent (the view
    // de-normalizes control_instances), assessment_answers is NULL (dead). The
    // control_state_history table + pass_id coupling are untouched (Phase 4).
    const cur = db.prepare(`SELECT status, applicability, maturity, scope_pct,
      inclusion_justification, exclusion_justification, notes, assessment_answers
      FROM v_control_states WHERE workspace_id=? AND iso_item_id=?`).get(req.workspace.id, item.id);
    if (cur) {
      // Tag the snapshot with the active pass (auto-creates Pass 1 lazily on
      // the very first wizard save in a fresh workspace, so passes always exist).
      const activePassId = ensureActivePassId(req.workspace.id, req.user.id);
      db.prepare(`INSERT INTO control_state_history (workspace_id, iso_item_id, changed_by,
        status, applicability, maturity, scope_pct, inclusion_justification, exclusion_justification, notes, assessment_answers, pass_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          req.workspace.id, item.id, req.user.id,
          cur.status, cur.applicability, cur.maturity, cur.scope_pct,
          cur.inclusion_justification, cur.exclusion_justification, cur.notes, cur.assessment_answers,
          activePassId
        );
    }
    // Re-index for search now that the control's notes / state may have changed.
    fts.refresh(req.workspace.id, 'control', item.id);
    logAction(req.user.id, req.workspace.id, 'gap_assess_item', item.type, item.id, { status, applicability }, auditCtx(req));

    const action = req.body.action || 'save';
    if (action === 'skip') {
      const allOrder = db.prepare(`SELECT id FROM iso_items WHERE type IN ('clause','control') ORDER BY sort_order`).all();
      const idx = allOrder.findIndex(r => r.id === item.id);
      const next = idx >= 0 && idx < allOrder.length - 1 ? allOrder[idx + 1].id : null;
      return res.redirect(next
        ? `/workspaces/${req.workspace.id}/controls/assess/${next}`
        : `/workspaces/${req.workspace.id}/controls/assess?done=1`);
    }
    const nextU = nextUnassessedItem(req.workspace.id, item.sort_order);
    return res.redirect(nextU
      ? `/workspaces/${req.workspace.id}/controls/assess/${nextU.id}`
      : `/workspaces/${req.workspace.id}/controls/assess?done=1`);
  });

  // ==================== FLAG-FOR-REVIEW (ISO 27001) ====================
  // A junior consultant flags an assessment item; the engagement lead or any
  // firm member with assessment.signoff reviews. Both frameworks share a
  // generic state machine: none -> requested -> reviewed | needs_changes.
  function notifyReviewers(wsId, requesterUserId, item, reason, framework) {
    // Engagement lead + anyone with assessment.signoff in this workspace.
    const ws = db.prepare(`SELECT lead_consultant_id, firm_id FROM workspaces WHERE id=?`).get(wsId);
    const recipients = new Set();
    if (ws && ws.lead_consultant_id && ws.lead_consultant_id !== requesterUserId) recipients.add(ws.lead_consultant_id);
    // Firm users with manager / senior_consultant roles get notified.
    const firmReviewers = db.prepare(`SELECT id FROM users
      WHERE firm_id=? AND user_type='firm' AND active=1
        AND firm_role IN ('manager','senior_consultant')
        AND id != ?`).all(ws ? ws.firm_id : 0, requesterUserId);
    firmReviewers.forEach(u => recipients.add(u.id));
    const linkPath = framework === 'iso42001'
      ? `/workspaces/${wsId}/iso42001/gap/${item.id}`
      : `/workspaces/${wsId}/controls/assess/${item.id}`;
    const itemCode = framework === 'iso42001'
      ? item.id.replace('ai-annex-','').replace('ai-clause-','').toUpperCase().replace(/-/g,'.')
      : item.id.replace('annex-','').replace('clause-','').toUpperCase();
    recipients.forEach(uid => {
      jobs.notify(wsId, uid, 'review_request', 'warning',
        `Review requested on ${itemCode}`, (reason || '').slice(0, 140), linkPath);
    });
  }

  app.post('/workspaces/:wsId/controls/assess/:isoId/flag-for-review', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const item = db.prepare(`SELECT id FROM iso_items WHERE id=?`).get(req.params.isoId);
    if (!item) return res.status(404).send('Not found');
    // Review-convergence: write the converged review columns when control_writes_converged
    // (014 mirrors to legacy). getOrCreateState ensures both rows exist.
    getOrCreateState(req.workspace.id, item.id);
    const wcFr = ctlWrites.converged(db, req.workspace.id);
    const ridFr = wcFr ? ctlWrites.requirementId(db, 'iso27001', item.id) : null;
    if (wcFr && ridFr) {
      db.prepare(`UPDATE control_instances
        SET review_status='requested', review_requested_by=?, review_requested_at=CURRENT_TIMESTAMP, review_reason=?,
            reviewed_by=NULL, reviewed_at=NULL
        WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`)
        .run(req.user.id, req.body.reason || null, req.workspace.id, ridFr);
    } else {
      db.prepare(`UPDATE control_states
        SET review_status='requested', review_requested_by=?, review_requested_at=CURRENT_TIMESTAMP, review_reason=?,
            reviewed_by=NULL, reviewed_at=NULL
        WHERE workspace_id=? AND iso_item_id=?`)
        .run(req.user.id, req.body.reason || null, req.workspace.id, item.id);
    }
    logAction(req.user.id, req.workspace.id, 'flag_for_review', 'control', item.id, { reason: req.body.reason }, auditCtx(req));
    notifyReviewers(req.workspace.id, req.user.id, item, req.body.reason, 'iso27001');
    res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${item.id}`);
  });

  app.post('/workspaces/:wsId/controls/assess/:isoId/review-action', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const item = db.prepare(`SELECT id FROM iso_items WHERE id=?`).get(req.params.isoId);
    if (!item) return res.status(404).send('Not found');
    const action = req.body.action; // 'approve' or 'send_back'
    if (!['approve', 'send_back'].includes(action)) return res.status(400).send('Bad action');
    const newStatus = action === 'approve' ? 'reviewed' : 'needs_changes';
    // Review-convergence: converged write + read when control_writes_converged.
    const wcRa = ctlWrites.converged(db, req.workspace.id);
    const ridRa = wcRa ? ctlWrites.requirementId(db, 'iso27001', item.id) : null;
    let cur;
    if (wcRa && ridRa) {
      cur = db.prepare(`SELECT review_requested_by FROM control_instances WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).get(req.workspace.id, ridRa);
      db.prepare(`UPDATE control_instances SET review_status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP
        WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(newStatus, req.user.id, req.workspace.id, ridRa);
    } else {
      cur = db.prepare(`SELECT review_requested_by FROM control_states WHERE workspace_id=? AND iso_item_id=?`).get(req.workspace.id, item.id);
      db.prepare(`UPDATE control_states SET review_status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP
        WHERE workspace_id=? AND iso_item_id=?`).run(newStatus, req.user.id, req.workspace.id, item.id);
    }
    logAction(req.user.id, req.workspace.id, 'review_action', 'control', item.id, { action, note: req.body.note }, auditCtx(req));
    // Notify the requester that the review is done.
    if (cur && cur.review_requested_by && cur.review_requested_by !== req.user.id) {
      const code = item.id.replace('annex-','').replace('clause-','').toUpperCase();
      const verb = action === 'approve' ? 'approved your review on' : 'sent back your review on';
      jobs.notify(req.workspace.id, cur.review_requested_by, 'review_complete', 'info',
        `Reviewer ${verb} ${code}`, (req.body.note || '').slice(0, 140),
        `/workspaces/${req.workspace.id}/controls/assess/${item.id}`);
    }
    res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${item.id}`);
  });

  app.post('/workspaces/:wsId/controls/assess/:isoId/clear-flag', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const item = db.prepare(`SELECT id FROM iso_items WHERE id=?`).get(req.params.isoId);
    if (!item) return res.status(404).send('Not found');
    // Review-convergence: clear the converged review state when control_writes_converged.
    const wcCf = ctlWrites.converged(db, req.workspace.id);
    const ridCf = wcCf ? ctlWrites.requirementId(db, 'iso27001', item.id) : null;
    if (wcCf && ridCf) {
      db.prepare(`UPDATE control_instances
        SET review_status='none', review_requested_by=NULL, review_requested_at=NULL, review_reason=NULL,
            reviewed_by=NULL, reviewed_at=NULL
        WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL`).run(req.workspace.id, ridCf);
    } else {
      db.prepare(`UPDATE control_states
        SET review_status='none', review_requested_by=NULL, review_requested_at=NULL, review_reason=NULL,
            reviewed_by=NULL, reviewed_at=NULL
        WHERE workspace_id=? AND iso_item_id=?`).run(req.workspace.id, item.id);
    }
    logAction(req.user.id, req.workspace.id, 'clear_review_flag', 'control', item.id, null, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${item.id}`);
  });

  // ==================== GAP ASSESSMENT (PASSES) ====================
  // A "pass" is one round of consultant assessment. Pass 1 = initial gap
  // assessment; Pass 2+ = re-assessments after the client has implemented
  // some of the prior pass's recommendations. Every wizard save during an
  // in-progress pass tags its history snapshot with that pass_id so we can
  // diff state between any two passes.

  function getActivePass(wsId) {
    return db.prepare(`SELECT * FROM assessment_passes
      WHERE workspace_id=? AND status='in_progress'
      ORDER BY pass_number DESC LIMIT 1`).get(wsId);
  }

  function ensureActivePassId(wsId, userId) {
    // Race-safe lazy auto-start. Two consultants saving the first wizard answer
    // in a fresh workspace can both observe no-active-pass and both try to
    // INSERT pass_number=1; the UNIQUE INDEX idx_passes_ws_num catches the
    // second one. We catch SQLITE_CONSTRAINT_UNIQUE and re-read instead of
    // surfacing a 500. The transaction is per-call (no big lock); the only
    // contention is the brief window between MAX read and INSERT.
    const tryCreate = () => {
      const active = getActivePass(wsId);
      if (active) return active.id;
      const lastNum = db.prepare(`SELECT COALESCE(MAX(pass_number), 0) AS n
        FROM assessment_passes WHERE workspace_id=?`).get(wsId).n;
      const nextNum = lastNum + 1;
      return db.prepare(`INSERT INTO assessment_passes
        (workspace_id, pass_number, label, status, started_by)
        VALUES (?, ?, ?, 'in_progress', ?)`)
        .run(wsId, nextNum, nextNum === 1 ? 'Initial gap assessment' : `Re-assessment ${nextNum - 1}`, userId).lastInsertRowid;
    };
    try {
      return tryCreate();
    } catch (e) {
      // SqliteError.code is SQLITE_CONSTRAINT_UNIQUE on the duplicate
      // pass_number. Any other error rethrows. On a unique-collision the other
      // request just won; re-read and return its id.
      if (e && e.code && e.code.startsWith('SQLITE_CONSTRAINT')) {
        const active = getActivePass(wsId);
        if (active) return active.id;
      }
      throw e;
    }
  }

  app.get('/workspaces/:wsId/gap-assessment', requireAuth, requireWorkspace, (req, res) => {
    const wsId = req.workspace.id;
    // All passes for this workspace, with per-pass save count derived from history.
    const passes = db.prepare(`
      SELECT p.*,
             u1.name AS started_by_name,
             u2.name AS completed_by_name,
             (SELECT COUNT(DISTINCT iso_item_id) FROM control_state_history WHERE pass_id = p.id) AS items_touched,
             (SELECT COUNT(*) FROM control_state_history WHERE pass_id = p.id) AS save_count
      FROM assessment_passes p
      LEFT JOIN users u1 ON u1.id = p.started_by
      LEFT JOIN users u2 ON u2.id = p.completed_by
      WHERE p.workspace_id = ?
      ORDER BY p.pass_number DESC
    `).all(wsId);

    const active = passes.find(p => p.status === 'in_progress') || null;

    // Total clauses + controls for progress denominator.
    const totalItems = db.prepare(`SELECT COUNT(*) c FROM iso_items WHERE type IN ('clause','control')`).get().c;
    const assessedNow = db.prepare(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, wsId).cs}
      WHERE workspace_id=? AND status != 'Not Assessed'`).get(wsId).c;

    // Find the next un-assessed item (continue button target).
    const nextItem = nextUnassessedItem(wsId, -1);

    // Re-engagement orientation - when a new pass is starting (or active),
    // surface what's changed since the prior pass closed: new evidence, new
    // NCs, controls touched, documents superseded, time elapsed.
    let orientation = null;
    const priorClosed = passes.find(p => p.status === 'completed');
    if (priorClosed && priorClosed.completed_at) {
      const since = priorClosed.completed_at;
      orientation = {
        priorPass: priorClosed,
        since,
        newEvidence: db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=? AND uploaded_at > ?`).get(wsId, since).c,
        newNCs: db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND created_at > ?`).get(wsId, since).c,
        newIncidents: db.prepare(`SELECT COUNT(*) c FROM incidents WHERE workspace_id=? AND created_at > ?`).get(wsId, since).c,
        controlsTouched: db.prepare(`SELECT COUNT(DISTINCT iso_item_id) c FROM control_state_history h
          INNER JOIN assessment_passes p ON p.id = h.pass_id
          WHERE h.workspace_id=? AND p.pass_number > ?`).get(wsId, priorClosed.pass_number).c,
        docsSuperseded: db.prepare(`SELECT COUNT(*) c FROM evidence WHERE workspace_id=? AND superseded_at IS NOT NULL AND superseded_at > ?`).get(wsId, since).c,
        docsApproved: db.prepare(`SELECT COUNT(*) c FROM generated_docs WHERE workspace_id=? AND status IN ('approved','published') AND updated_at > ?`).get(wsId, since).c
      };
    }

    // Trend across passes - average maturity per Annex A theme per pass.
    // Theme = first segment of A.X.Y (X = 5/6/7/8 → Organizational/People/Physical/Technological).
    // For each pass, take the LATEST snapshot per item up to and including that
    // pass; group by theme; average maturity. Pass 0 = baseline (Not Assessed).
    const ANNEX_THEMES = { '5':'Organizational', '6':'People', '7':'Physical', '8':'Technological' };
    let trend = null;
    if (passes.length > 0) {
      const ascPasses = [...passes].sort((a,b) => a.pass_number - b.pass_number);
      const stmt = db.prepare(`
        SELECT h.iso_item_id, h.maturity, i.id AS code
        FROM (
          SELECT MAX(h2.id) AS max_id, h2.iso_item_id
          FROM control_state_history h2
          INNER JOIN assessment_passes p ON p.id = h2.pass_id
          WHERE h2.workspace_id = ? AND p.pass_number <= ? AND h2.maturity IS NOT NULL
          GROUP BY h2.iso_item_id
        ) latest
        INNER JOIN control_state_history h ON h.id = latest.max_id
        INNER JOIN iso_items i ON i.id = h.iso_item_id
        WHERE i.type='control'
      `);
      trend = ascPasses.map(p => {
        const rows = stmt.all(wsId, p.pass_number);
        const buckets = { '5': [], '6': [], '7': [], '8': [] };
        for (const r of rows) {
          const m = r.code.match(/^annex-a\.(\d)\./);
          if (m && buckets[m[1]]) buckets[m[1]].push(r.maturity);
        }
        const themes = {};
        for (const k of Object.keys(buckets)) {
          themes[k] = {
            name: ANNEX_THEMES[k],
            avg: buckets[k].length ? (buckets[k].reduce((a,b)=>a+b,0) / buckets[k].length) : null,
            count: buckets[k].length
          };
        }
        return { pass: p, themes };
      });
    }

    // Annex A heatmap - current coverage by theme.
    const themeRows = db.prepare(`SELECT i.id, COALESCE(cs.status,'Not Assessed') AS status,
        COALESCE(cs.applicability,'undecided') AS applicability,
        cs.maturity
      FROM iso_items i LEFT JOIN ${ctlReads.tables(db, wsId).cs} cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control'`).all(wsId);
    const heatmap = { '5':[], '6':[], '7':[], '8':[] };
    for (const r of themeRows) {
      const m = r.id.match(/^annex-a\.(\d)\./);
      if (m && heatmap[m[1]]) heatmap[m[1]].push(r);
    }

    res.render('gap_assessment', {
      user: req.user, ws: req.workspace,
      title: 'Gap assessment',
      active: 'gap-assessment',
      passes, activePass: active,
      totalItems, assessedNow,
      nextItem,
      orientation, trend, heatmap, themeNames: ANNEX_THEMES
    });
  });

  app.post('/workspaces/:wsId/gap-assessment/start', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const wsId = req.workspace.id;
    // If an active pass exists, complete it before starting a new one - only
    // one pass can be in_progress at a time.
    const active = getActivePass(wsId);
    if (active) {
      db.prepare(`UPDATE assessment_passes
        SET status='completed', completed_at=datetime('now'), completed_by=?
        WHERE id=?`).run(req.user.id, active.id);
    }
    const lastNum = db.prepare(`SELECT COALESCE(MAX(pass_number), 0) AS n
      FROM assessment_passes WHERE workspace_id=?`).get(wsId).n;
    const nextNum = lastNum + 1;
    const label = (req.body.label || '').toString().trim()
      || (nextNum === 1 ? 'Initial gap assessment' : `Re-assessment ${nextNum - 1}`);
    const notes = (req.body.notes || '').toString().trim() || null;
    const id = db.prepare(`INSERT INTO assessment_passes
      (workspace_id, pass_number, label, notes, status, started_by)
      VALUES (?, ?, ?, ?, 'in_progress', ?)`)
      .run(wsId, nextNum, label, notes, req.user.id).lastInsertRowid;
    logAction(req.user.id, wsId, 'start_assessment_pass', 'pass', id, { pass_number: nextNum, label });
    res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`, `Started Pass ${nextNum}: ${label}`));
  });

  app.post('/workspaces/:wsId/gap-assessment/:passId/complete', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const wsId = req.workspace.id;
    const p = db.prepare(`SELECT * FROM assessment_passes WHERE id=? AND workspace_id=?`).get(req.params.passId, wsId);
    if (!p) return res.status(404).send('Not found');
    if (p.status === 'completed') return res.redirect(`/workspaces/${wsId}/gap-assessment`);
    // Conditional UPDATE: only commit if the pass is still in_progress. Two
    // consultants clicking "Complete pass" simultaneously: the first UPDATE
    // matches and writes completed_by; the second sees changes=0 and is told
    // it was already completed. Replaces the previous LWW behaviour where both
    // writes succeeded and the audit trail recorded two different completers.
    const result = db.prepare(`UPDATE assessment_passes
      SET status='completed', completed_at=datetime('now'), completed_by=?
      WHERE id=? AND status='in_progress'`).run(req.user.id, p.id);
    if (result.changes === 0) {
      return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
        `Pass ${p.pass_number} was just completed by another consultant.`, 'info'));
    }
    logAction(req.user.id, wsId, 'complete_assessment_pass', 'pass', p.id, { pass_number: p.pass_number });
    res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`, `Completed Pass ${p.pass_number}: ${p.label}`));
  });

  app.post('/workspaces/:wsId/gap-assessment/:passId/reopen', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const wsId = req.workspace.id;
    const p = db.prepare(`SELECT * FROM assessment_passes WHERE id=? AND workspace_id=?`).get(req.params.passId, wsId);
    if (!p) return res.status(404).send('Not found');
    // Only one pass can be in_progress - close any other before reopening.
    const other = getActivePass(wsId);
    if (other && other.id !== p.id) {
      db.prepare(`UPDATE assessment_passes
        SET status='completed', completed_at=datetime('now'), completed_by=?
        WHERE id=?`).run(req.user.id, other.id);
    }
    db.prepare(`UPDATE assessment_passes SET status='in_progress', completed_at=NULL, completed_by=NULL WHERE id=?`).run(p.id);
    logAction(req.user.id, wsId, 'reopen_assessment_pass', 'pass', p.id, { pass_number: p.pass_number });
    res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`, `Reopened Pass ${p.pass_number}`));
  });

  app.post('/workspaces/:wsId/gap-assessment/:passId/rename', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res) => {
    const wsId = req.workspace.id;
    const p = db.prepare(`SELECT id FROM assessment_passes WHERE id=? AND workspace_id=?`).get(req.params.passId, wsId);
    if (!p) return res.status(404).send('Not found');
    const label = (req.body.label || '').toString().trim() || null;
    const notes = (req.body.notes || '').toString().trim() || null;
    db.prepare(`UPDATE assessment_passes SET label=?, notes=? WHERE id=?`).run(label, notes, p.id);
    res.redirect(`/workspaces/${wsId}/gap-assessment`);
  });

  // Diff between two passes - for each control, show the state at the end of
  // each pass and categorise the change. "End of pass N" = last history
  // snapshot with pass_id=N (i.e. the value that was current when the pass
  // was active). For the active pass we use the live control_states row.
  app.get('/workspaces/:wsId/gap-assessment/diff', requireAuth, requireWorkspace, (req, res) => {
    const wsId = req.workspace.id;
    const fromId = parseInt(req.query.from, 10);
    const toId = parseInt(req.query.to, 10);
    if (!Number.isFinite(fromId) || !Number.isFinite(toId) || fromId === toId) {
      return res.redirect(`/workspaces/${wsId}/gap-assessment`);
    }
    const passes = db.prepare(`SELECT * FROM assessment_passes WHERE workspace_id=? AND id IN (?,?)`).all(wsId, fromId, toId);
    if (passes.length !== 2) return res.redirect(`/workspaces/${wsId}/gap-assessment`);
    const passFrom = passes.find(p => p.id === fromId);
    const passTo = passes.find(p => p.id === toId);

    // Helper: end-of-pass state per item. Snapshots are written AFTER the
    // wizard UPDATE, so each row captures the new state at that save. For
    // any pass N, the "end of pass N" state for an item is the latest
    // snapshot whose pass_number is <= N (i.e. the most recent value the
    // item held by the time pass N concluded). If no snapshot exists up to
    // that point, the item was never assessed and is reported as such.
    function endOfPassState(passId) {
      const passRow = db.prepare(`SELECT pass_number FROM assessment_passes WHERE id=?`).get(passId);
      if (!passRow) return [];
      const passNumber = passRow.pass_number;
      const items = db.prepare(`SELECT id FROM iso_items WHERE type IN ('clause','control')`).all();
      const out = [];
      const stmt = db.prepare(`
        SELECT h.status, h.maturity, h.applicability, h.notes
        FROM control_state_history h
        INNER JOIN assessment_passes p ON p.id = h.pass_id
        WHERE h.workspace_id=? AND h.iso_item_id=? AND p.pass_number <= ?
        ORDER BY p.pass_number DESC, h.snapshot_at DESC, h.id DESC
        LIMIT 1
      `);
      for (const it of items) {
        const row = stmt.get(wsId, it.id, passNumber);
        if (row) out.push({ iso_item_id: it.id, ...row });
        else out.push({ iso_item_id: it.id, status: 'Not Assessed', maturity: null, applicability: 'undecided', notes: null });
      }
      return out;
    }

    const fromState = endOfPassState(fromId);
    const toState = endOfPassState(toId);
    const fromMap = {}; fromState.forEach(s => fromMap[s.iso_item_id] = s);
    const toMap = {};   toState.forEach(s => toMap[s.iso_item_id] = s);

    const items = db.prepare(`SELECT id, type, title FROM iso_items
      WHERE type IN ('clause','control') ORDER BY sort_order`).all();

    const STATUS_RANK = {
      'Not Assessed': 0, 'Not Implemented': 1, 'Work In Progress': 2,
      'Partially Implemented': 3, 'Implemented': 4, 'Not Applicable': 4
    };
    const rows = items.map(it => {
      const a = fromMap[it.id] || {};
      const b = toMap[it.id] || {};
      const sa = a.status || 'Not Assessed', sb = b.status || 'Not Assessed';
      const ma = a.maturity == null ? null : a.maturity;
      const mb = b.maturity == null ? null : b.maturity;
      let change = 'unchanged';
      if (sa !== sb) {
        change = (STATUS_RANK[sb] || 0) > (STATUS_RANK[sa] || 0) ? 'improved'
               : (STATUS_RANK[sb] || 0) < (STATUS_RANK[sa] || 0) ? 'regressed' : 'changed';
      } else if (ma !== mb) {
        change = (mb || 0) > (ma || 0) ? 'improved' : (mb || 0) < (ma || 0) ? 'regressed' : 'unchanged';
      }
      return { id: it.id, type: it.type, title: it.title, from: a, to: b, change };
    });

    const summary = {
      improved: rows.filter(r => r.change === 'improved').length,
      regressed: rows.filter(r => r.change === 'regressed').length,
      unchanged: rows.filter(r => r.change === 'unchanged').length,
      changed: rows.filter(r => r.change === 'changed').length
    };

    res.render('gap_assessment_diff', {
      user: req.user, ws: req.workspace,
      title: `Diff Pass ${passFrom.pass_number} → Pass ${passTo.pass_number}`,
      active: 'gap-assessment',
      passFrom, passTo, rows, summary
    });
  });

  // Append-only history of every wizard save for one item - what the auditor asks for.
  app.get('/workspaces/:wsId/controls/:isoId/history', requireAuth, requireWorkspace, requirePermission('control.view'), (req, res) => {
    const item = db.prepare(`SELECT id, type, title FROM iso_items WHERE id=?`).get(req.params.isoId);
    if (!item) return res.status(404).send('Not found');
    const rows = db.prepare(`SELECT h.*, u.name AS changed_by_name FROM control_state_history h
      LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.workspace_id=? AND h.iso_item_id=?
      ORDER BY h.snapshot_at DESC LIMIT 200`).all(req.workspace.id, item.id);
    res.render('control_history', { user: req.user, ws: req.workspace, item, rows });
  });

  // The standalone control detail page was removed - the wizard now hosts
  // evidence, linked risks, linked documents, NCs, and history alongside
  // the audit-grade reference content and assessment form. Existing inbound
  // links from SoA, risks, NCs, etc. continue to work via this redirect.
  app.get('/workspaces/:wsId/controls/:isoId', requireAuth, requireWorkspace, (req, res, nextMw) => {
    // Reserved literal sub-routes - let them fall through.
    if (['kanban','export.csv','import','assess'].includes(req.params.isoId)) return nextMw();
    const item = db.prepare('SELECT id FROM iso_items WHERE id = ?').get(req.params.isoId);
    if (!item) return res.status(404).send('Not found');
    return res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${item.id}`);
  });


  notifyReviewersRef = notifyReviewers;
}

module.exports = { register, notifyReviewers: (...a) => notifyReviewersRef(...a) };
