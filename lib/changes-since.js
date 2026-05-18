// "Changes since" report data gatherer. Given a workspace and a "since" date,
// returns a structured breakdown of everything that's changed in the ISMS:
// SoA, risks, evidence, documents, NCs, audits, MRMs, improvements, and a
// roll-up of audit-log activity by category. The consultant uses this for
// surveillance and recertification handoffs; the auditor uses the audit pack
// for the headline deliverable.

'use strict';

function fmt(d) { return d ? String(d).slice(0, 10) : '-'; }

function defaultSince(db, wsId) {
  // Pick the most recent completed/reported audit date if any. Else fall back
  // to the most recent SoA snapshot. Else 365 days ago. This makes the page
  // render with sensible content the first time a consultant opens it.
  const lastAudit = db.prepare(`SELECT audit_date FROM audits
    WHERE workspace_id=? AND audit_date IS NOT NULL
      AND (status IN ('completed','reported','closed') OR lifecycle_stage IN ('completed','reported','closed'))
    ORDER BY audit_date DESC LIMIT 1`).get(wsId);
  if (lastAudit && lastAudit.audit_date) return String(lastAudit.audit_date).slice(0, 10);
  const lastSnap = db.prepare(`SELECT created_at FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1`).get(wsId);
  if (lastSnap && lastSnap.created_at) return String(lastSnap.created_at).slice(0, 10);
  return new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
}

function gather(deps, wsId, sinceISO) {
  const { db, enc } = deps;
  const since = sinceISO || defaultSince(db, wsId);
  const sinceDateOnly = since.length > 10 ? since.slice(0, 10) : since;
  const out = { since: sinceDateOnly };

  // ---- SoA: diff two snapshots if possible ----
  // Snapshot "before" = most recent snapshot with created_at <= since
  // Snapshot "after"  = most recent snapshot overall
  const snapBefore = db.prepare(`SELECT * FROM soa_snapshots WHERE workspace_id=? AND date(created_at) <= ? ORDER BY created_at DESC LIMIT 1`).get(wsId, sinceDateOnly);
  const snapAfter  = db.prepare(`SELECT * FROM soa_snapshots WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1`).get(wsId);
  out.soa = { snapBefore, snapAfter, changes: [], available: false };
  if (snapBefore && snapAfter && snapBefore.id !== snapAfter.id) {
    try {
      const ra = JSON.parse(enc.decryptIfNeeded(snapBefore.payload, wsId));
      const rb = JSON.parse(enc.decryptIfNeeded(snapAfter.payload, wsId));
      const ma = Object.fromEntries(ra.map(r => [r.id, r]));
      const mb = Object.fromEntries(rb.map(r => [r.id, r]));
      const ids = new Set([...Object.keys(ma), ...Object.keys(mb)]);
      const changes = [];
      for (const id of ids) {
        const x = ma[id], y = mb[id];
        const c = [];
        if (!x) c.push({ kind: 'added' });
        else if (!y) c.push({ kind: 'removed' });
        else {
          if (x.applicability !== y.applicability) c.push({ kind: 'applicability', from: x.applicability, to: y.applicability });
          if (x.status !== y.status) c.push({ kind: 'status', from: x.status, to: y.status });
          if ((x.inclusion_justification || '') !== (y.inclusion_justification || '')) c.push({ kind: 'inclusion_justification' });
          if ((x.exclusion_justification || '') !== (y.exclusion_justification || '')) c.push({ kind: 'exclusion_justification' });
        }
        if (c.length) changes.push({ id, title: (y || x).title, changes: c });
      }
      out.soa.changes = changes;
      out.soa.available = true;
    } catch (_) { /* leave changes empty */ }
  }

  // ---- Risks added / closed since ----
  // No historical snapshot of the risk register exists. We surface risks
  // created since `since` (by created_at) and risks currently closed that
  // were last touched after `since` (by audit_log heuristic, fallback to
  // identifying status changes via current state).
  out.risks = {
    added: db.prepare(`SELECT r.id, r.title, r.threat, r.likelihood, r.impact, r.status, r.created_at, a.name AS asset_name
      FROM risks r LEFT JOIN assets a ON a.id = r.asset_id
      WHERE r.workspace_id=? AND date(r.created_at) > ?
      ORDER BY r.created_at`).all(wsId, sinceDateOnly),
    // Currently-closed risks are surfaced together; a per-risk close timestamp
    // doesn't exist on the schema so we can't filter "closed since" strictly.
    nowClosed: db.prepare(`SELECT r.id, r.title, r.status
      FROM risks r WHERE r.workspace_id=? AND r.status IN ('closed','treated')`).all(wsId)
  };

  // ---- Evidence added ----
  out.evidence = {
    added: db.prepare(`SELECT e.id, e.filename, e.iso_item_id, e.sha256, e.size_bytes, e.uploaded_at, u.name AS uploader
      FROM evidence e LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.workspace_id=? AND date(e.uploaded_at) > ?
      ORDER BY e.uploaded_at DESC`).all(wsId, sinceDateOnly)
  };

  // ---- Documents: new + version bumps ----
  out.documents = {
    new: db.prepare(`SELECT id, name, category, created_at FROM generated_docs
      WHERE workspace_id=? AND date(created_at) > ? AND retired_at IS NULL
      ORDER BY created_at DESC`).all(wsId, sinceDateOnly),
    bumped: db.prepare(`SELECT d.id, d.name, d.category, MAX(dv.created_at) AS latest_version_at, COUNT(dv.id) AS new_versions
      FROM doc_versions dv
      INNER JOIN generated_docs d ON d.id = dv.document_id
      WHERE d.workspace_id=? AND date(dv.created_at) > ? AND date(d.created_at) <= ?
      GROUP BY d.id ORDER BY latest_version_at DESC`).all(wsId, sinceDateOnly, sinceDateOnly),
    retired: db.prepare(`SELECT id, name, category, retired_at FROM generated_docs
      WHERE workspace_id=? AND retired_at IS NOT NULL AND date(retired_at) > ?
      ORDER BY retired_at DESC`).all(wsId, sinceDateOnly)
  };

  // ---- Nonconformities ----
  out.ncs = {
    opened: db.prepare(`SELECT id, title, severity, status, created_at FROM nonconformities
      WHERE workspace_id=? AND date(created_at) > ?
      ORDER BY created_at DESC`).all(wsId, sinceDateOnly),
    closed: db.prepare(`SELECT id, title, severity, status, closed_at FROM nonconformities
      WHERE workspace_id=? AND closed_at IS NOT NULL AND date(closed_at) > ?
      ORDER BY closed_at DESC`).all(wsId, sinceDateOnly),
    stillOpen: db.prepare(`SELECT COUNT(*) c FROM nonconformities WHERE workspace_id=? AND status='open'`).get(wsId).c
  };

  // ---- Internal audits conducted ----
  out.audits = db.prepare(`SELECT id, title, audit_date, status, auditor_name FROM audits
    WHERE workspace_id=? AND audit_date IS NOT NULL AND date(audit_date) > ?
    ORDER BY audit_date DESC`).all(wsId, sinceDateOnly);

  // ---- MRMs held ----
  out.mrms = db.prepare(`SELECT id, meeting_date, attendees, status FROM mrms
    WHERE workspace_id=? AND meeting_date IS NOT NULL AND date(meeting_date) > ?
    ORDER BY meeting_date DESC`).all(wsId, sinceDateOnly);

  // ---- Improvements opened / closed ----
  out.improvements = {
    opened: db.prepare(`SELECT id, title, source, status, owner_name, created_at FROM improvements
      WHERE workspace_id=? AND date(created_at) > ?
      ORDER BY created_at DESC`).all(wsId, sinceDateOnly),
    closed: db.prepare(`SELECT id, title, status, closed_at FROM improvements
      WHERE workspace_id=? AND closed_at IS NOT NULL AND date(closed_at) > ?
      ORDER BY closed_at DESC`).all(wsId, sinceDateOnly)
  };

  // ---- Audit log activity roll-up ----
  // Cheap volume signal: number of events by category since `since`. Useful
  // to spot quiet engagements ("you haven't touched this workspace in 6 weeks").
  const logRows = db.prepare(`SELECT action, COUNT(*) AS n FROM audit_log
    WHERE workspace_id=? AND date(created_at) > ?
    GROUP BY action ORDER BY n DESC`).all(wsId, sinceDateOnly);
  out.activity = {
    byAction: logRows,
    total: logRows.reduce((s, r) => s + r.n, 0),
    distinctActions: logRows.length
  };

  // ---- Headline counts ----
  out.summary = {
    soa_changes:       out.soa.changes.length,
    risks_added:       out.risks.added.length,
    evidence_added:    out.evidence.added.length,
    documents_new:     out.documents.new.length,
    documents_bumped:  out.documents.bumped.length,
    documents_retired: out.documents.retired.length,
    ncs_opened:        out.ncs.opened.length,
    ncs_closed:        out.ncs.closed.length,
    audits_conducted:  out.audits.length,
    mrms_held:         out.mrms.length,
    improvements_opened: out.improvements.opened.length,
    improvements_closed: out.improvements.closed.length
  };

  return out;
}

module.exports = { gather, defaultSince, fmt };
