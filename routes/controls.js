'use strict';
// Controls cluster. Slice 7 of the server.js modularization: controls list +
// detail, the guided gap-assessment wizard, flag-for-review (ISO 27001), and
// assessment passes.

const crypto = require('crypto');
const rbac = require('../lib/rbac');
const enc = require('../lib/encryption');
const fts = require('../lib/fts');
const jobs = require('../lib/jobs');
const ctlReads = require('../lib/control-reads');
const ctlWrites = require('../lib/control-writes');
const evReads = require('../lib/evidence-reads');
const docLinks = require('../lib/doc-links');
const assessmentPassQuality = require('../lib/assessment-pass-quality');
const consultingDelivery = require('../lib/consulting-delivery');
const personalDrafts = require('../lib/form-drafts');
const diagnostics = require('../lib/assessment-diagnostics');
const ai = require('../lib/ai');
const policyRetrieval = require('../lib/policy-retrieval');
const openRouterPolicyRetrieval = require('../lib/openrouter-policy-retrieval');
const evidenceRetrieval = require('../lib/evidence-retrieval');
const { buildWorkspaceTruth } = require('../lib/grc-truth');
const { withToast, redirectBack, auditCtx, parseFormArray, escapeHtml } = require('../lib/http-helpers');

// The ISO 42001 flag-for-review flow in server.js reuses the reviewer
// fan-out. notifyReviewers closes over deps, so the export is bound at
// register() time through this ref.
let notifyReviewersRef = null;

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction, getOrCreateState, resolveUploadPath } = deps;
  const activeAssessmentCopilotRuns = new Set();
  const activeExternalPolicySearchRuns = new Set();
  const activeExternalEvidenceSearchRuns = new Set();

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

  function parseJsonValue(value, fallback) {
    if (value == null || value === '') return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }

  function hydrateAssessmentItem(item) {
    if (!item) return null;
    item.questions = parseJsonValue(item.questions, []);
    item.evidence_needed = parseJsonValue(item.evidence_needed, []);
    item.documentation_needed = parseJsonValue(item.documentation_needed, []);
    item.common_pitfalls = parseJsonValue(item.common_pitfalls, null);
    item.evidence_to_look_for = parseJsonValue(item.evidence_to_look_for, null);
    item.maturity_ladder = parseJsonValue(item.maturity_ladder, null);
    item.related_items = parseJsonValue(item.related_items, null);
    return item;
  }

  function boundedText(value, max = 1000) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
      .trim()
      .slice(0, max);
  }

  function boundedList(value, maxItems = 10, maxLength = 500) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const item of value) {
      const text = boundedText(item, maxLength);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
      if (out.length >= maxItems) break;
    }
    return out;
  }

  function buildPolicySearchQueries(item) {
    const queries = [];
    const add = parts => {
      const value = parts.map(part => boundedText(part, 1200)).filter(Boolean).join('\n').slice(0, 1800);
      if (value && !queries.includes(value)) queries.push(value);
    };
    add([item.id, item.title, item.summary, item.purpose]);
    add([item.what_good_looks_like, item.minimum_certifiable, item.scoping_notes]);
    const evidence = Array.isArray(item.evidence_to_look_for)
      ? item.evidence_to_look_for.map(entry => entry && entry.item).filter(Boolean).join('; ')
      : '';
    const documentation = Array.isArray(item.documentation_needed) ? item.documentation_needed.join('; ') : '';
    add([evidence, documentation]);
    return queries.slice(0, 3);
  }

  function parsePolicyDocumentIds(value) {
    const input = Array.isArray(value) ? value : (value == null ? [] : [value]);
    const ids = [];
    const seen = new Set();
    for (const raw of input) {
      const id = Number(raw);
      if (!Number.isSafeInteger(id) || id <= 0) return { ids: [], error: 'Document selection contains an invalid identifier.' };
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    if (!ids.length) return { ids, error: 'Select at least one policy to search.' };
    if (ids.length > policyRetrieval.LIMITS.maxDocuments) {
      return { ids: [], error: `Select no more than ${policyRetrieval.LIMITS.maxDocuments} policies per search.` };
    }
    return { ids, error: '' };
  }

  function loadPolicySearchDocuments(workspaceId, isoItemId, ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.transaction(() => {
      const rows = db.prepare(`SELECT d.id, d.workspace_id, d.name, d.status, d.locked, d.updated_at,
        d.current_version_id, d.source_filename, d.source_mime,
        LENGTH(d.content) AS working_content_length,
        LENGTH(v.content) AS version_content_length,
        v.id AS version_id, v.version AS immutable_version,
        v.content_hash AS version_content_hash,
        EXISTS (
          SELECT 1 FROM document_requirement_links drl
          INNER JOIN requirements rq ON rq.id=drl.requirement_id
          INNER JOIN frameworks f ON f.id=rq.framework_id AND f.code='iso27001'
          WHERE drl.document_id=d.id AND rq.ref=?
        ) AS linked
      FROM generated_docs d
      LEFT JOIN doc_versions v ON v.id=d.current_version_id
        AND v.workspace_id=d.workspace_id AND v.document_id=d.id
      WHERE d.workspace_id=? AND d.id IN (${placeholders})
        AND COALESCE(d.status,'draft') NOT IN ('withdrawn','retired')
        AND d.retired_at IS NULL
      ORDER BY d.id`).all(isoItemId, workspaceId, ...ids);
      if (rows.length !== ids.length) {
        throw new policyRetrieval.PolicyRetrievalError(
          'One or more selected policies are unavailable in this workspace.',
          'policy_document_unavailable', 400
        );
      }

      let storedTotal = 0;
      for (const row of rows) {
        row.use_version = !!row.version_id && (!!row.locked || !['draft', 'rejected'].includes(String(row.status || 'draft')));
        row.selected_content_length = Number(row.use_version ? row.version_content_length : row.working_content_length) || 0;
        if (row.selected_content_length > policyRetrieval.LIMITS.maxStoredDocumentCharacters) {
          throw new policyRetrieval.PolicyRetrievalError(
            `${boundedText(row.name, 160)} is too large for safe local analysis. Review it manually or import a smaller text version.`,
            'policy_document_too_large', 413
          );
        }
        storedTotal += row.selected_content_length;
      }
      if (storedTotal > policyRetrieval.LIMITS.maxStoredTotalCharacters) {
        throw new policyRetrieval.PolicyRetrievalError(
          'The selected policies are too large to analyse together safely. Select a smaller set and try again.',
          'policy_selection_too_large', 413
        );
      }

      const contentRows = db.prepare(`SELECT d.id, d.content AS working_content, v.content AS version_content
        FROM generated_docs d
        LEFT JOIN doc_versions v ON v.id=d.current_version_id
          AND v.workspace_id=d.workspace_id AND v.document_id=d.id
        WHERE d.workspace_id=? AND d.id IN (${placeholders})
          AND COALESCE(d.status,'draft') NOT IN ('withdrawn','retired')
          AND d.retired_at IS NULL`).all(workspaceId, ...ids);
      if (contentRows.length !== rows.length) {
        throw new policyRetrieval.PolicyRetrievalError(
          'One or more selected policies changed before analysis could start.',
          'policy_document_unavailable', 409
        );
      }
      const contentById = new Map(contentRows.map(row => [Number(row.id), row]));

      return rows.map(row => {
        const useVersion = row.use_version;
        const contentRow = contentById.get(Number(row.id)) || {};
        const encryptedContent = useVersion ? contentRow.version_content : contentRow.working_content;
        const content = String(enc.decryptIfNeeded(encryptedContent || '', workspaceId));
        // Governed versions are signed over their immutable stored plaintext.
        // Verify those exact bytes before sanitizing later at the retrieval boundary.
        const sourceHash = crypto.createHash('sha256').update(content).digest('hex');
        if (useVersion && row.version_content_hash && row.version_content_hash !== sourceHash) {
          throw new policyRetrieval.PolicyRetrievalError(
            `The current governed version of ${boundedText(row.name, 160)} failed its integrity check.`,
            'policy_source_integrity_failed', 409
          );
        }
        return {
          id: row.id,
          workspace_id: row.workspace_id,
          name: row.name,
          status: row.status || 'draft',
          version_id: useVersion ? row.version_id : null,
          version: useVersion ? row.immutable_version : null,
          source_filename: row.source_filename || null,
          source_mime: row.source_mime || null,
          linked: !!row.linked,
          source_hash: sourceHash,
          source_updated_at: boundedText(row.updated_at, 30),
          content
        };
      });
    })();
  }

  function policySourceFingerprint(documents) {
    const basis = documents.map(document => ({
      id: document.id,
      source_hash: document.source_hash,
      status: document.status,
      version_id: document.version_id,
      version: document.version,
      source_updated_at: document.source_updated_at
    })).sort((a, b) => a.id - b.id);
    return crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex');
  }

  const ASSESSMENT_CITATION_DOMAIN = 'nimbus-assessment-citation-v1\0';
  const ASSESSMENT_CITATION_TTL_SECONDS = 15 * 60;
  const ASSESSMENT_CITATION_LIMIT = 6;
  const ASSESSMENT_CITATION_KIND_LIMIT = 4;
  const ASSESSMENT_CITATION_EXCERPT_LIMIT = 4000;
  const ASSESSMENT_CITATION_TOTAL_LIMIT = 20000;
  const ASSESSMENT_AUTOMATIC_DISCLOSURE_VERSION = 'assessment_copilot_automatic_grounding_v2';
  const ASSESSMENT_AUTOMATIC_POLICY_DOCUMENT_LIMIT = 20;
  const ASSESSMENT_AUTOMATIC_POLICY_PASSAGE_LIMIT = 3;
  const ASSESSMENT_AUTOMATIC_EVIDENCE_PASSAGE_LIMIT = 3;

  function issueAssessmentCitationToken(req, item, kind, passage) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1,
      k: kind,
      w: Number(req.workspace.id),
      u: Number(req.user.id),
      i: String(item.id),
      r: String(passage.source_ref || ''),
      c: String(passage.chunk_hash || passage.chunk_sha256 || ''),
      x: kind === 'evidence' ? Number(passage.index_id) : null,
      n: Number(passage.chunk_ordinal),
      a: now,
      e: now + ASSESSMENT_CITATION_TTL_SECONDS
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = enc.signHmac(`${ASSESSMENT_CITATION_DOMAIN}${encoded}`, req.workspace.id);
    return `${encoded}.${signature}`;
  }

  function parseAssessmentCitationTokens(req, item) {
    const raw = req.body && req.body.selected_citations;
    if (raw == null) return [];
    if (!Array.isArray(raw)) {
      throw new policyRetrieval.PolicyRetrievalError(
        'Selected citations must be an array of Nimbus citation tokens.',
        'assessment_citation_invalid', 400
      );
    }
    if (raw.length > ASSESSMENT_CITATION_LIMIT) {
      throw new policyRetrieval.PolicyRetrievalError(
        `Select no more than ${ASSESSMENT_CITATION_LIMIT} cited passages for one assessment draft.`,
        'assessment_citation_limit', 413
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const seenRefs = new Set();
    const counts = { policy: 0, evidence: 0 };
    return raw.map(value => {
      const token = String(value || '');
      if (!token || token.length > 1024 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) {
        throw new policyRetrieval.PolicyRetrievalError('A selected citation token is invalid.', 'assessment_citation_invalid', 400);
      }
      const [encoded, signature] = token.split('.');
      if (!enc.verifyHmac(`${ASSESSMENT_CITATION_DOMAIN}${encoded}`, req.workspace.id, signature)) {
        throw new policyRetrieval.PolicyRetrievalError('A selected citation token is invalid.', 'assessment_citation_invalid', 400);
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      } catch (_) {
        throw new policyRetrieval.PolicyRetrievalError('A selected citation token is invalid.', 'assessment_citation_invalid', 400);
      }
      const kind = payload && payload.k;
      const issuedAt = Number(payload && payload.a);
      const expiresAt = Number(payload && payload.e);
      const indexId = payload && payload.x == null ? null : Number(payload.x);
      const ordinal = Number(payload && payload.n);
      if (!payload || payload.v !== 1 || !['policy', 'evidence'].includes(kind)
          || Number(payload.w) !== Number(req.workspace.id)
          || Number(payload.u) !== Number(req.user.id)
          || String(payload.i || '') !== String(item.id)
          || typeof payload.r !== 'string' || !payload.r || payload.r.length > 160
          || !/^[a-f0-9]{64}$/.test(String(payload.c || ''))
          || !Number.isSafeInteger(ordinal) || ordinal < 0
          || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
          || issuedAt > now + 30 || expiresAt < now || expiresAt - issuedAt !== ASSESSMENT_CITATION_TTL_SECONDS
          || (kind === 'evidence' && (!Number.isSafeInteger(indexId) || indexId <= 0))
          || (kind === 'policy' && indexId !== null)) {
        throw new policyRetrieval.PolicyRetrievalError('A selected citation token is invalid or expired.', 'assessment_citation_invalid', 400);
      }
      if (seenRefs.has(payload.r)) {
        throw new policyRetrieval.PolicyRetrievalError('The same citation cannot be selected more than once.', 'assessment_citation_duplicate', 400);
      }
      seenRefs.add(payload.r);
      counts[kind] += 1;
      if (counts[kind] > ASSESSMENT_CITATION_KIND_LIMIT) {
        throw new policyRetrieval.PolicyRetrievalError(
          `Select no more than ${ASSESSMENT_CITATION_KIND_LIMIT} ${kind} passages for one assessment draft.`,
          'assessment_citation_limit', 413
        );
      }
      return {
        kind,
        source_ref: payload.r,
        chunk_hash: payload.c,
        index_id: indexId,
        chunk_ordinal: ordinal
      };
    });
  }

  async function materializeAssessmentCitations(req, item, citations) {
    if (!citations.length) {
      return {
        passages: [],
        fingerprint: crypto.createHash('sha256').update('[]').digest('hex')
      };
    }
    const policyClaims = citations.filter(citation => citation.kind === 'policy');
    const evidenceClaims = citations.filter(citation => citation.kind === 'evidence');
    const permissions = req.userPerms || new Set();
    if (policyClaims.length && !rbac.hasPermission(permissions, 'document.view')) {
      throw new policyRetrieval.PolicyRetrievalError(
        'You do not have permission to use policy contents in an assessment draft.',
        'assessment_policy_citation_forbidden', 403
      );
    }
    const missingEvidencePermission = evidenceClaims.length
      && ['evidence.view', 'evidence.download'].find(permission => !rbac.hasPermission(permissions, permission));
    if (missingEvidencePermission) {
      throw new policyRetrieval.PolicyRetrievalError(
        'You do not have permission to use Evidence Library contents in an assessment draft.',
        'assessment_evidence_citation_forbidden', 403
      );
    }

    const byRef = new Map();
    if (policyClaims.length) {
      const documentIds = [...new Set(policyClaims.map(claim => policyRetrieval.parsePolicySourceRef(claim.source_ref).document_id))];
      const documents = loadPolicySearchDocuments(req.workspace.id, item.id, documentIds);
      const documentsById = new Map(documents.map(document => [Number(document.id), document]));
      for (const claim of policyClaims) {
        const parsed = policyRetrieval.parsePolicySourceRef(claim.source_ref);
        const passage = policyRetrieval.materializePolicyCitation({
          document: documentsById.get(parsed.document_id),
          sourceRef: claim.source_ref,
          expectedChunkHash: claim.chunk_hash
        });
        if (passage.chunk_ordinal !== claim.chunk_ordinal) {
          throw new policyRetrieval.PolicyRetrievalError(
            'A selected policy citation failed its integrity check.',
            'stale_policy_citation', 409
          );
        }
        byRef.set(claim.source_ref, passage);
      }
    }
    if (evidenceClaims.length) {
      const passages = await evidenceRetrieval.materializeEvidencePassages({
        db,
        workspaceId: req.workspace.id,
        isoItemId: item.id,
        sourceRefs: evidenceClaims.map(claim => claim.source_ref),
        resolveUploadPath,
        maxPassages: ASSESSMENT_CITATION_KIND_LIMIT
      });
      const claimByRef = new Map(evidenceClaims.map(claim => [claim.source_ref, claim]));
      for (const passage of passages) {
        const claim = claimByRef.get(passage.source_ref);
        if (!claim || passage.chunk_sha256 !== claim.chunk_hash
            || passage.index_id !== claim.index_id
            || passage.chunk_ordinal !== claim.chunk_ordinal) {
          throw new policyRetrieval.PolicyRetrievalError(
            'A selected evidence citation failed its integrity check.',
            'stale_evidence_citation', 409
          );
        }
        byRef.set(claim.source_ref, passage);
      }
    }

    let totalCharacters = 0;
    const passages = citations.map(claim => {
      const source = byRef.get(claim.source_ref);
      if (!source) {
        throw new policyRetrieval.PolicyRetrievalError(
          'A selected citation is unavailable.',
          'assessment_citation_unavailable', 409
        );
      }
      const excerpt = String(source.excerpt || '').slice(0, ASSESSMENT_CITATION_EXCERPT_LIMIT);
      totalCharacters += excerpt.length;
      if (totalCharacters > ASSESSMENT_CITATION_TOTAL_LIMIT) {
        throw new policyRetrieval.PolicyRetrievalError(
          'The selected passages are too large for one assessment draft. Select fewer passages.',
          'assessment_citation_text_limit', 413
        );
      }
      return {
        source_ref: source.source_ref,
        source_type: source.source_type,
        label: boundedText(source.label, 500),
        excerpt,
        treatment: source.source_type === 'policy'
          ? 'documented_design_only'
          : 'candidate_implementation_or_operating_evidence',
        status: boundedText(source.status || source.document_status, 120),
        freshness: boundedText(source.freshness, 80),
        linked: !!source.linked,
        valid_until: boundedText(source.valid_until, 20),
        version_id: source.version_id == null ? null : Number(source.version_id),
        source_sha256: source.source_sha256,
        chunk_hash: source.chunk_hash || source.chunk_sha256,
        index_id: source.index_id || null,
        chunk_ordinal: source.chunk_ordinal
      };
    });
    const fingerprintBasis = passages.map(passage => ({
      source_ref: passage.source_ref,
      source_sha256: passage.source_sha256,
      chunk_hash: passage.chunk_hash,
      index_id: passage.index_id,
      chunk_ordinal: passage.chunk_ordinal,
      status: passage.status,
      freshness: passage.freshness,
      valid_until: passage.valid_until,
      version_id: passage.version_id,
      linked: passage.linked
    }));
    return {
      passages,
      fingerprint: crypto.createHash('sha256').update(JSON.stringify(fingerprintBasis)).digest('hex')
    };
  }

  function automaticPolicyDocumentSelection(workspaceId, isoItemId) {
    const rows = db.prepare(`SELECT d.id,
        EXISTS (
          SELECT 1 FROM document_requirement_links drl
          INNER JOIN requirements rq ON rq.id=drl.requirement_id
          INNER JOIN frameworks f ON f.id=rq.framework_id AND f.code='iso27001'
          WHERE drl.document_id=d.id AND rq.ref=?
        ) AS linked
      FROM generated_docs d
      WHERE d.workspace_id=?
        AND COALESCE(d.status,'draft') NOT IN ('withdrawn','retired')
        AND d.retired_at IS NULL
      ORDER BY linked DESC,d.updated_at DESC,d.id DESC
      LIMIT ?`).all(isoItemId, workspaceId, ASSESSMENT_AUTOMATIC_POLICY_DOCUMENT_LIMIT + 1);
    return {
      ids: rows.slice(0, ASSESSMENT_AUTOMATIC_POLICY_DOCUMENT_LIMIT).map(row => Number(row.id)),
      limited: rows.length > ASSESSMENT_AUTOMATIC_POLICY_DOCUMENT_LIMIT
    };
  }

  function automaticCitationClaim(kind, passage) {
    return {
      kind,
      source_ref: String(passage.source_ref || ''),
      chunk_hash: String(passage.chunk_hash || passage.chunk_sha256 || ''),
      index_id: kind === 'evidence' ? Number(passage.index_id) : null,
      chunk_ordinal: Number(passage.chunk_ordinal)
    };
  }

  function isDegradableAutomaticRetrievalError(error) {
    if (!(error instanceof policyRetrieval.PolicyRetrievalError)) return false;
    const code = String(error.code || '');
    if (/audit/i.test(code)
        || /^stale_/.test(code)
        || /^evidence_source_/.test(code)
        || code === 'evidence_index_corrupt'
        || code === 'policy_source_integrity_failed'
        || code === 'policy_model_integrity_failed'
        || code === 'policy_document_unavailable'
        || /^policy_citation_/.test(code)) {
      return false;
    }
    return [429, 500, 502, 503, 504].includes(Number(error.status));
  }

  function staleAutomaticContextError() {
    return new policyRetrieval.PolicyRetrievalError(
      'An automatically retrieved source changed during this run. The Copilot result was discarded; run it again to retrieve fresh context.',
      'stale_automatic_context', 409
    );
  }

  function normalizeAutomaticSourceChange(error) {
    if (error instanceof policyRetrieval.PolicyRetrievalError) {
      const code = String(error.code || '');
      if (/^stale_(policy|evidence|assessment_citation)/.test(code)
          || code === 'assessment_citation_unavailable') {
        return staleAutomaticContextError();
      }
    }
    return error;
  }

  async function retrieveAutomaticPolicyPassages(req, item, queries) {
    const result = {
      status: 'empty',
      documents_considered: 0,
      passages_used: 0
    };
    const limitations = [];
    const permissions = req.userPerms || new Set();
    if (!rbac.hasPermission(permissions, 'document.view')) {
      result.status = 'skipped';
      limitations.push('Automatic policy retrieval was skipped because policy content is not available under your current permissions.');
      return { result, limitations, claims: [] };
    }
    if (!policyRetrieval.isConfigured()) {
      result.status = 'degraded';
      limitations.push('Automatic policy retrieval was unavailable because the local policy models are not configured. Review active policies manually.');
      return { result, limitations, claims: [] };
    }

    const selection = automaticPolicyDocumentSelection(req.workspace.id, item.id);
    result.documents_considered = selection.ids.length;
    if (!selection.ids.length) {
      limitations.push('No active policy documents were available for automatic retrieval.');
      return { result, limitations, claims: [] };
    }
    if (selection.limited) {
      limitations.push(`Automatic policy retrieval considered the first ${ASSESSMENT_AUTOMATIC_POLICY_DOCUMENT_LIMIT} active documents, prioritizing documents already linked to this ISO item and then the most recently updated.`);
    }

    const documents = loadPolicySearchDocuments(req.workspace.id, item.id, selection.ids);
    const sourceFingerprint = policySourceFingerprint(documents);
    const retrieval = await policyRetrieval.retrievePolicyPassages({
      documents,
      queries,
      limit: ASSESSMENT_AUTOMATIC_POLICY_PASSAGE_LIMIT
    });
    let latestDocuments;
    try {
      latestDocuments = loadPolicySearchDocuments(req.workspace.id, item.id, selection.ids);
    } catch (error) {
      if (error instanceof policyRetrieval.PolicyRetrievalError
          && error.code === 'policy_document_unavailable') {
        throw new policyRetrieval.PolicyRetrievalError(
          'An active policy changed or became unavailable during automatic retrieval. No final Copilot context was sent.',
          'stale_policy_source', 409
        );
      }
      throw error;
    }
    if (policySourceFingerprint(latestDocuments) !== sourceFingerprint) {
      throw new policyRetrieval.PolicyRetrievalError(
        'An active policy changed during automatic retrieval. No Copilot context was sent.',
        'stale_policy_source', 409
      );
    }
    const latestById = new Map(latestDocuments.map(document => [Number(document.id), document]));
    const passages = retrieval.passages.slice(0, ASSESSMENT_AUTOMATIC_POLICY_PASSAGE_LIMIT).map(passage =>
      policyRetrieval.materializePolicyCitation({
        document: latestById.get(Number(passage.document_id)),
        sourceRef: passage.source_ref,
        expectedChunkHash: passage.chunk_hash
      })
    );
    result.passages_used = passages.length;
    result.status = passages.length ? 'used' : 'empty';
    if (retrieval.skipped_documents.length) {
      limitations.push('Some active policy documents had no usable searchable text and were not represented in automatic retrieval.');
    }
    if (!passages.length) {
      limitations.push('Automatic local policy retrieval did not surface a relevant passage; this is not proof that policy coverage is absent.');
    }
    return {
      result,
      limitations,
      claims: passages.map(passage => automaticCitationClaim('policy', passage))
    };
  }

  async function retrieveAutomaticEvidencePassages(req, item, queries) {
    const result = {
      status: 'empty',
      evidence_considered: 0,
      chunks_considered: 0,
      passages_used: 0
    };
    const limitations = [];
    const permissions = req.userPerms || new Set();
    const missing = ['evidence.view', 'evidence.download']
      .filter(permission => !rbac.hasPermission(permissions, permission));
    if (missing.length) {
      result.status = 'skipped';
      limitations.push('Automatic Evidence Library retrieval was skipped because evidence content is not available under your current permissions.');
      return { result, limitations, claims: [] };
    }
    if (!evidenceRetrieval.isConfigured()) {
      result.status = 'degraded';
      limitations.push('Automatic Evidence Library retrieval is not configured for this environment. The Copilot used other governed context only.');
      return { result, limitations, claims: [] };
    }
    const readyCount = evidenceRetrieval.readyEvidenceCount(db, req.workspace.id);
    if (!readyCount) {
      limitations.push('No current Evidence Library file has a ready AI index for automatic retrieval.');
      return { result, limitations, claims: [] };
    }

    const models = evidenceRetrieval.modelInfo();
    const retrieval = await evidenceRetrieval.searchEvidence({
      db,
      workspaceId: req.workspace.id,
      isoItemId: item.id,
      queries,
      resolveUploadPath,
      limit: ASSESSMENT_AUTOMATIC_EVIDENCE_PASSAGE_LIMIT,
      beforeEgress(stage, metadata) {
        const reranking = stage === 'reranking';
        try {
          logAction(req.user.id, req.workspace.id,
            reranking
              ? 'ai_assessment_copilot_evidence_rerank_egress_started'
              : 'ai_assessment_copilot_evidence_query_egress_started',
            item.type, item.id, {
              provider: 'OpenRouter',
              stage,
              automatic_context: true,
              external_processing: true,
              external_processing_acknowledged: true,
              acknowledgement_version: ASSESSMENT_AUTOMATIC_DISCLOSURE_VERSION,
              data_classification: 'non_confidential_trial',
              embedding_model: models.embedding_model,
              reranker_model: models.reranker_model,
              searched_evidence_count: Number(metadata && metadata.searched_evidence_count || 0),
              chunks_considered: Number(metadata && metadata.chunks_considered || 0),
              candidate_count: Number(metadata && metadata.candidate_count || 0),
              candidate_evidence_ids: reranking
                ? (metadata.candidate_evidence_ids || []).map(Number).filter(Number.isSafeInteger)
                  .slice(0, evidenceRetrieval.LIMITS.candidateChunks)
                : [],
              data_categories: reranking
                ? ['automatic_iso_control_guidance_sent_to_openrouter', 'automatically_shortlisted_non_confidential_evidence_plaintext_sent_to_logged_free_reranker']
                : ['automatic_iso_control_guidance_sent_to_logged_free_embedding_endpoint']
            }, { ...auditCtx(req), strict: true });
        } catch (_) {
          throw new policyRetrieval.PolicyRetrievalError(
            'The required automatic evidence-retrieval audit event could not be recorded. No further context was sent.',
            'assessment_copilot_retrieval_audit_failed', 500
          );
        }
      }
    });
    result.evidence_considered = Number(retrieval.searched_evidence_count || 0);
    result.chunks_considered = Number(retrieval.chunks_considered || 0);
    const canonical = retrieval.passages.length
      ? await evidenceRetrieval.materializeEvidencePassages({
        db,
        workspaceId: req.workspace.id,
        isoItemId: item.id,
        sourceRefs: retrieval.passages.slice(0, ASSESSMENT_AUTOMATIC_EVIDENCE_PASSAGE_LIMIT)
          .map(passage => passage.source_ref),
        resolveUploadPath,
        maxPassages: ASSESSMENT_AUTOMATIC_EVIDENCE_PASSAGE_LIMIT
      })
      : [];
    const canonicalByRef = new Map(canonical.map(passage => [passage.source_ref, passage]));
    const passages = retrieval.passages.slice(0, ASSESSMENT_AUTOMATIC_EVIDENCE_PASSAGE_LIMIT)
      .map(passage => canonicalByRef.get(passage.source_ref))
      .filter(Boolean);
    if (passages.length !== Math.min(retrieval.passages.length, ASSESSMENT_AUTOMATIC_EVIDENCE_PASSAGE_LIMIT)) {
      throw new policyRetrieval.PolicyRetrievalError(
        'An automatically retrieved evidence citation changed before it could be used.',
        'stale_evidence_citation', 409
      );
    }
    result.passages_used = passages.length;
    result.status = passages.length ? 'used' : 'empty';
    if (!passages.length) {
      limitations.push('Automatic Evidence Library retrieval did not surface a relevant passage; this is not proof that supporting evidence is absent.');
    }
    if (passages.some(passage => passage.freshness === 'expired')) {
      limitations.push('Automatic retrieval found expired historical evidence; it cannot independently demonstrate current control operation.');
    }
    return {
      result,
      limitations,
      claims: passages.map(passage => automaticCitationClaim('evidence', passage))
    };
  }

  async function retrieveAutomaticAssessmentSources(req, item) {
    const queries = buildPolicySearchQueries(item);
    let policy;
    try {
      policy = await retrieveAutomaticPolicyPassages(req, item, queries);
    } catch (error) {
      if (!isDegradableAutomaticRetrievalError(error)) throw error;
      policy = {
        result: { status: 'degraded', documents_considered: 0, passages_used: 0 },
        limitations: ['Automatic local policy retrieval was temporarily unavailable. The Copilot used other governed context only.'],
        claims: []
      };
    }

    let evidence;
    try {
      evidence = await retrieveAutomaticEvidencePassages(req, item, queries);
    } catch (error) {
      if (!isDegradableAutomaticRetrievalError(error)) throw error;
      evidence = {
        result: { status: 'degraded', evidence_considered: 0, chunks_considered: 0, passages_used: 0 },
        limitations: ['Automatic Evidence Library retrieval was temporarily unavailable. The Copilot used other governed context only.'],
        claims: []
      };
    }

    const claims = [
      ...policy.claims.slice(0, ASSESSMENT_AUTOMATIC_POLICY_PASSAGE_LIMIT),
      ...evidence.claims.slice(0, ASSESSMENT_AUTOMATIC_EVIDENCE_PASSAGE_LIMIT)
    ].slice(0, ASSESSMENT_CITATION_LIMIT);
    const basis = await materializeAssessmentCitations(req, item, claims);
    const limitations = boundedList([...policy.limitations, ...evidence.limitations], 12, 700);
    const sources = basis.passages.map(passage => ({
      ref: passage.source_ref,
      label: boundedText(passage.label, 500),
      source_type: passage.source_type
    }));
    return {
      claims,
      basis,
      retrieval: {
        policy: {
          status: policy.result.status,
          documents_considered: Number(policy.result.documents_considered || 0),
          passages_used: basis.passages.filter(passage => passage.source_type === 'policy').length
        },
        evidence: {
          status: evidence.result.status,
          evidence_considered: Number(evidence.result.evidence_considered || 0),
          chunks_considered: Number(evidence.result.chunks_considered || 0),
          passages_used: basis.passages.filter(passage => passage.source_type === 'evidence').length
        },
        limitations,
        sources
      }
    };
  }

  function assessmentStateFingerprint(state) {
    const source = state || {};
    const stableState = {
      status: source.status || 'Not Assessed',
      applicability: source.applicability || 'undecided',
      maturity: Number(source.maturity) || 0,
      scope_pct: source.scope_pct == null ? null : Number(source.scope_pct),
      inclusion_justification: source.inclusion_justification || '',
      exclusion_justification: source.exclusion_justification || '',
      notes: source.notes || '',
      review_status: source.review_status || 'none',
      review_requested_by: source.review_requested_by || null,
      review_requested_at: source.review_requested_at || null,
      reviewed_by: source.reviewed_by || null,
      reviewed_at: source.reviewed_at || null,
      review_reason: source.review_reason || '',
      last_updated: source.last_updated || '',
      record_version: Number(source.record_version) || 0,
      assessment_answers: source.assessment_answers || null
    };
    return crypto.createHash('sha256').update(JSON.stringify(stableState)).digest('hex');
  }

  // Build a minimum-necessary, tenant-scoped context for one control. Source
  // content is excluded unless the route has automatically shortlisted it and
  // independently rehydrated it from its current governed source.
  function buildAssessmentCopilotContext(req, item, questions, retrievedPassages = [], retrievalSummary = null) {
    const workspaceId = req.workspace.id;
    const sourceLabels = new Map();
    const addSource = (ref, label) => {
      sourceLabels.set(ref, label);
      return ref;
    };
    const state = db.prepare(`SELECT * FROM v_control_states
      WHERE workspace_id=? AND iso_item_id=?`).get(workspaceId, item.id) || {
      status: 'Not Assessed', maturity: 0, applicability: item.type === 'clause' ? 'included' : 'undecided'
    };

    const rawAnswers = req.body && req.body.answers && typeof req.body.answers === 'object' && !Array.isArray(req.body.answers)
      ? req.body.answers
      : {};
    const diagnostics = [];
    questions.forEach((question, index) => {
      const answer = rawAnswers[String(index)];
      if (!['yes', 'partial', 'no'].includes(answer)) return;
      const sourceRef = addSource(`diagnostic:${index}`, `Diagnostic ${index + 1}: ${boundedText(question, 120)}`);
      diagnostics.push({ source_ref: sourceRef, question: boundedText(question, 500), answer });
    });

    const allowedDraftStatuses = new Set([
      'Not Assessed', 'Not Implemented', 'Work In Progress', 'Partially Implemented', 'Implemented'
    ]);
    const requestedMaturity = Number(req.body && req.body.maturity);
    const draftNotes = boundedText(req.body && req.body.notes, 6000);
    const draft = {
      source_ref: addSource('current-draft', 'Current unsaved assessment form'),
      status: allowedDraftStatuses.has(req.body && req.body.status) ? req.body.status : boundedText(state.status, 80) || 'Not Assessed',
      maturity: Number.isInteger(requestedMaturity) && requestedMaturity >= 0 && requestedMaturity <= 5
        ? requestedMaturity
        : Math.max(0, Math.min(5, Number(state.maturity) || 0)),
      notes: draftNotes
    };

    const canViewEvidenceMetadata = rbac.hasPermission(req.userPerms || new Set(), 'evidence.view');
    const evidence = (canViewEvidenceMetadata
      ? evReads.controlPanelEvidence(db, workspaceId, item.id).slice(0, 30)
      : []).map(row => {
      const sourceRef = addSource(`evidence:${row.id}`, `Evidence metadata: ${boundedText(row.filename, 160)}`);
      return {
        source_ref: sourceRef,
        id: row.id,
        filename: boundedText(row.filename, 300),
        description: boundedText(row.description, 600),
        period_label: boundedText(row.period_label, 100),
        valid_from: boundedText(row.valid_from, 20),
        valid_until: boundedText(row.valid_until, 20),
        uploaded_at: boundedText(row.uploaded_at, 30),
        clause_section: boundedText(row.clause_section, 120)
      };
    });

    const canViewDocumentMetadata = rbac.hasPermission(req.userPerms || new Set(), 'document.view');
    const documents = (canViewDocumentMetadata
      ? docLinks.linkedDocsForControl(db, 'iso27001', item.id, workspaceId).slice(0, 30)
      : []).map(row => {
      const sourceRef = addSource(`document:${row.id}`, `Linked document metadata: ${boundedText(row.name, 160)}`);
      return {
        source_ref: sourceRef,
        id: row.id,
        name: boundedText(row.name, 300),
        category: boundedText(row.category, 100),
        status: boundedText(row.status, 80),
        section_ref: boundedText(row.section_ref, 120)
      };
    });

    const retrievedSourcePassages = retrievedPassages.map(passage => {
      const sourceRef = addSource(passage.source_ref, boundedText(passage.label, 500));
      return {
        source_ref: sourceRef,
        source_type: passage.source_type,
        retrieval_mode: 'automatic_candidate',
        treatment: passage.treatment,
        excerpt: boundedText(passage.excerpt, ASSESSMENT_CITATION_EXCERPT_LIMIT),
        status: boundedText(passage.status, 120),
        freshness: boundedText(passage.freshness, 80),
        linked: !!passage.linked
      };
    });

    const risks = db.prepare(`SELECT r.id, r.title, r.likelihood, r.impact, r.status
      FROM risks r INNER JOIN risk_controls rc ON rc.risk_id=r.id
      WHERE rc.iso_item_id=? AND r.workspace_id=?
      ORDER BY (r.likelihood * r.impact) DESC LIMIT 25`).all(item.id, workspaceId).map(row => {
      const sourceRef = addSource(`risk:${row.id}`, `Linked risk: ${boundedText(row.title, 160)}`);
      return {
        source_ref: sourceRef,
        id: row.id,
        title: boundedText(row.title, 300),
        likelihood: Number(row.likelihood) || null,
        impact: Number(row.impact) || null,
        status: boundedText(row.status, 80)
      };
    });

    const nonconformities = db.prepare(`SELECT id, title, severity, status, due_date
      FROM nonconformities
      WHERE iso_item_id=? AND workspace_id=? AND status NOT IN ('closed','verified')
      ORDER BY id DESC LIMIT 20`).all(item.id, workspaceId).map(row => {
      const sourceRef = addSource(`nonconformity:${row.id}`, `Open nonconformity: ${boundedText(row.title, 160)}`);
      return {
        source_ref: sourceRef,
        id: row.id,
        title: boundedText(row.title, 300),
        severity: boundedText(row.severity, 50),
        status: boundedText(row.status, 80),
        due_date: boundedText(row.due_date, 20)
      };
    });

    const priorPasses = db.prepare(`
      SELECT p.pass_number, p.label, p.status AS pass_status,
             h.notes, h.status AS item_status, h.maturity, h.snapshot_at
      FROM (
        SELECT MAX(id) AS max_id, pass_id
        FROM control_state_history
        WHERE workspace_id=? AND iso_item_id=? AND pass_id IS NOT NULL
        GROUP BY pass_id
      ) latest
      INNER JOIN control_state_history h ON h.id=latest.max_id
      INNER JOIN assessment_passes p ON p.id=h.pass_id
      WHERE h.notes IS NOT NULL AND TRIM(h.notes) != ''
      ORDER BY p.pass_number DESC LIMIT 3
    `).all(workspaceId, item.id).map(row => {
      const sourceRef = addSource(`prior-pass:${row.pass_number}`, `Prior assessment pass ${row.pass_number}`);
      return {
        source_ref: sourceRef,
        pass_number: row.pass_number,
        label: boundedText(row.label, 160),
        pass_status: boundedText(row.pass_status, 80),
        item_status: boundedText(row.item_status, 80),
        maturity: Number(row.maturity),
        notes: boundedText(row.notes, 2500),
        snapshot_at: boundedText(row.snapshot_at, 30)
      };
    });

    const workspaceSource = addSource('workspace-scope', 'Workspace industry and ISMS scope');
    const catalogSource = addSource(`catalog:${item.id}`, `ISO catalogue guidance for ${item.id}`);
    const stateSource = addSource('saved-state', 'Current saved assessment state');
    const context = {
      as_of_date: new Date().toISOString().slice(0, 10),
      workspace: {
        source_ref: workspaceSource,
        industry: boundedText(req.workspace.industry || req.workspace.sector, 300),
        scope: boundedText(req.workspace.scope, 1500)
      },
      iso_item: {
        source_ref: catalogSource,
        id: item.id,
        type: item.type,
        title: boundedText(item.title, 500),
        summary: boundedText(item.summary, 2000),
        purpose: boundedText(item.purpose, 2000),
        what_good_looks_like: boundedText(item.what_good_looks_like, 2500),
        minimum_certifiable: boundedText(item.minimum_certifiable, 2500),
        common_pitfalls: boundedList(item.common_pitfalls, 12, 600),
        evidence_to_look_for: Array.isArray(item.evidence_to_look_for)
          ? item.evidence_to_look_for.slice(0, 20).map(entry => ({
              item: boundedText(entry && entry.item, 500),
              what_it_tells_you: boundedText(entry && entry.what_it_tells_you, 800)
            }))
          : [],
        scoping_notes: boundedText(item.scoping_notes, 1800),
        maturity_ladder: item.maturity_ladder || null
      },
      saved_state: {
        source_ref: stateSource,
        status: boundedText(state.status, 80) || 'Not Assessed',
        maturity: Math.max(0, Math.min(5, Number(state.maturity) || 0)),
        applicability: item.type === 'clause' ? 'included' : boundedText(state.applicability, 80),
        notes: boundedText(state.notes, 4000),
        last_updated: boundedText(state.last_updated, 30)
      },
      current_draft: draft,
      diagnostic_answers: diagnostics,
      retrieved_source_passages: retrievedSourcePassages,
      automatic_retrieval_summary: retrievalSummary ? {
        policy: {
          status: boundedText(retrievalSummary.policy && retrievalSummary.policy.status, 40),
          documents_considered: Number(retrievalSummary.policy && retrievalSummary.policy.documents_considered || 0),
          passages_used: Number(retrievalSummary.policy && retrievalSummary.policy.passages_used || 0)
        },
        evidence: {
          status: boundedText(retrievalSummary.evidence && retrievalSummary.evidence.status, 40),
          evidence_considered: Number(retrievalSummary.evidence && retrievalSummary.evidence.evidence_considered || 0),
          chunks_considered: Number(retrievalSummary.evidence && retrievalSummary.evidence.chunks_considered || 0),
          passages_used: Number(retrievalSummary.evidence && retrievalSummary.evidence.passages_used || 0)
        },
        limitations: boundedList(retrievalSummary.limitations, 12, 700)
      } : null,
      evidence_metadata: evidence,
      linked_document_metadata: documents,
      linked_risks: risks,
      open_nonconformities: nonconformities,
      prior_passes: priorPasses
    };

    return {
      context,
      sourceLabels,
      state,
      counts: {
        diagnostics: diagnostics.length,
        evidence: evidence.length,
        documents: documents.length,
        risks: risks.length,
        nonconformities: nonconformities.length,
        prior_passes: priorPasses.length,
        retrieved_sources: retrievedSourcePassages.length,
        retrieved_policy: retrievedSourcePassages.filter(passage => passage.source_type === 'policy').length,
        retrieved_evidence: retrievedSourcePassages.filter(passage => passage.source_type === 'evidence').length
      },
      hasClientBasis: diagnostics.length > 0 || !!draftNotes || !!boundedText(state.notes, 20) ||
        retrievedSourcePassages.length > 0 || evidence.length > 0 || documents.length > 0 || risks.length > 0 ||
        nonconformities.length > 0 || priorPasses.length > 0
    };
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

    // A completed walkthrough is not the same thing as a defensible control
    // conclusion. Project the canonical workspace verdict into this page so an
    // "Implemented" count can never silently override missing evidence or a
    // failed certification gate.
    const truth = buildWorkspaceTruth(db, req.workspace);
    const totalItems = Object.values(dist).reduce((sum, count) => sum + count, 0);
    const assessedCount = Math.max(0, totalItems - notAssessedCount);
    const evidencedImplemented = Math.max(0, dist.Implemented - evidenceAsks.length);
    const evidenceCoverage = dist.Implemented > 0
      ? Math.round((evidencedImplemented / dist.Implemented) * 100)
      : 0;
    const openRemediationTasks = gaps.filter(g => g.has_open_task).length;
    const controlsQualityIssues = truth.issues.filter(issue => issue.domain === 'controls');

    res.render('controls_assess_summary', {
      user: req.user, ws: req.workspace, gaps, docGaps, evidenceAsks, untreatedLinkedRisks,
      notAssessedCount, dist, truth, totalItems, assessedCount, evidencedImplemented,
      evidenceCoverage, openRemediationTasks, controlsQualityIssues,
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
    // each INSERT - duplicate "Remediate A.5.15…" tasks for the same control.
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
    const activePass = getActivePass(req.workspace.id);
    const next = activePass
      ? assessmentPassQuality.nextUnconcludedItem(db, req.workspace.id, activePass, -1)
      : nextUnassessedItem(req.workspace.id, 0);
    if (next) return res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${next.id}`);
    const first = db.prepare(`SELECT id FROM iso_items WHERE type IN ('clause','control') ORDER BY sort_order LIMIT 1`).get();
    res.redirect(`/workspaces/${req.workspace.id}/controls/assess/${first.id}?done=1`);
  });

  function renderAssessment(req, res, nextMw) {
    // Reserved literal sub-routes - let them fall through to their own handlers
    // registered later in the file.
    if (['summary.docx'].includes(req.params.isoId)) return nextMw();
    const item = hydrateAssessmentItem(db.prepare(`SELECT * FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(req.params.isoId));
    if (!item) return res.status(404).send('ISO item not found');

    const recordedState = db.prepare('SELECT * FROM v_control_states WHERE workspace_id=? AND iso_item_id=?').get(req.workspace.id, item.id) || {
      status: 'Not Assessed', applicability: item.type === 'clause' ? 'included' : 'undecided',
      maturity: 0, notes: '', scope_pct: null, review_status: 'none', record_version: 0
    };
    const activePass = getActivePass(req.workspace.id);
    const privateDraft = personalDrafts.get(db,{workspaceId:req.workspace.id,actorId:req.user.id,kind:'assessment',recordId:item.id,contextKey:String(activePass?.id || '')});
    const recovery = req.assessmentRecovery || null;
    const enteredValues = recovery ? Object.fromEntries(Object.entries(recovery.body).filter(([key,value])=>(personalDrafts.fields.assessment.includes(key)||/^q_\d+$/.test(key))&&['string','number','boolean'].includes(typeof value)).map(([key,value])=>[key,String(value)])) : privateDraft.draft?.payload;
    const state = enteredValues ? { ...recordedState, ...enteredValues } : recordedState;

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
    // sequentially - they bounce between themes. The nav builds an index of
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
    const diagnosticState = diagnostics.read(recordedState.assessment_answers, item.id, questions);
    let savedAnswers = diagnosticState.answers;
    const diagnosticDraftChanged = !!(enteredValues?.diagnostic_set_id && enteredValues.diagnostic_set_id !== diagnosticState.current.setId);
    if (enteredValues && !diagnosticDraftChanged) savedAnswers = {...savedAnswers,...Object.fromEntries(Object.entries(enteredValues).filter(([k]) => /^q_\d+$/.test(k)).map(([k,v]) => [k.slice(2),v]))};
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
    const pagePermissions = res.locals.userPerms || req.userPerms || new Set();
    const canViewEvidenceMetadata = rbac.hasPermission(pagePermissions, 'evidence.view');
    const canDownloadEvidenceContent = rbac.hasPermission(pagePermissions, 'evidence.download');
    const evidenceList = canViewEvidenceMetadata
      ? evReads.controlPanelEvidence(db, req.workspace.id, item.id)
      : [];

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

    // Local policy coverage search is deliberately broader than the governed
    // link list: it can discover a relevant, active policy that has not yet
    // been mapped to this control. Do not expose even document names when the
    // current user lacks document.view.
    const canSearchPolicyContent = rbac.hasPermission(res.locals.userPerms || new Set(), 'document.view');
    const policySearchDocs = canSearchPolicyContent ? db.prepare(`SELECT d.id, d.name, d.category,
        COALESCE(d.status,'draft') AS status, d.version, d.updated_at,
        EXISTS (
          SELECT 1 FROM document_requirement_links drl
          INNER JOIN requirements rq ON rq.id=drl.requirement_id
          INNER JOIN frameworks f ON f.id=rq.framework_id AND f.code='iso27001'
          WHERE drl.document_id=d.id AND rq.ref=?
        ) AS linked
      FROM generated_docs d
      WHERE d.workspace_id=?
        AND COALESCE(d.status,'draft') NOT IN ('withdrawn','retired')
        AND d.retired_at IS NULL
      ORDER BY linked DESC, d.updated_at DESC, d.name`).all(item.id, req.workspace.id) : [];

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
    if (enteredValues?.notes !== undefined) currentPassNotes = enteredValues.notes;
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
    const reviewContext = require('../lib/control-review').context(db,req.workspace,req.user,'iso27001',item.id);
    const isReviewer = reviewContext.canReview;

    const localPolicyConfigured = policyRetrieval.isConfigured();
    const canUseExternalPolicyProcessing = rbac.hasPermission(res.locals.userPerms || new Set(), 'ai.external_process');
    const openRouterPolicyConfigured = canUseExternalPolicyProcessing && openRouterPolicyRetrieval.isConfigured();
    const policyRetrievalProviders = {
      local: {
        configured: localPolicyConfigured,
        label: 'Local models (private)',
        message: policyRetrieval.configurationError(),
        models: policyRetrieval.modelInfo()
      },
      'openrouter-nemotron': {
        configured: openRouterPolicyConfigured,
        authorized: canUseExternalPolicyProcessing,
        label: 'OpenRouter NVIDIA free trial',
        message: canUseExternalPolicyProcessing
          ? openRouterPolicyRetrieval.configurationError()
          : 'A manager must grant ai.external_process before selected text can leave Nimbus.',
        models: openRouterPolicyRetrieval.modelInfo(),
        disclosure: openRouterPolicyRetrieval.DATA_DISCLOSURE,
        max_documents: openRouterPolicyRetrieval.MAX_DOCUMENTS
      }
    };
    const canSearchEvidence = canViewEvidenceMetadata
      && canDownloadEvidenceContent
      && canUseExternalPolicyProcessing;
    const evidenceAi = {
      configured: canSearchEvidence && evidenceRetrieval.isConfigured(),
      configuration_error: canSearchEvidence
        ? evidenceRetrieval.configurationError()
        : 'You need evidence.view, evidence.download, and manager-granted ai.external_process permissions to search evidence contents.',
      can_search: canSearchEvidence,
      ready_count: canViewEvidenceMetadata && canDownloadEvidenceContent
        ? evidenceRetrieval.readyEvidenceCount(db, req.workspace.id)
        : 0,
      disclosure: openRouterPolicyRetrieval.DATA_DISCLOSURE,
      models: evidenceRetrieval.modelInfo()
    };

    res.render('controls_assess', {
      user: req.user, ws: req.workspace, item, state, totals, position, sectionPosition, relatedRows,
      prevId, nextId: nextById, doneFlag: !!req.query.done,
      questions, savedAnswers, suggestedStatus, diagnosticState, diagnosticDraftChanged, recovery, recordedState, privateDraft,
      mutationKey: crypto.randomUUID(),
      evidenceList, linkedRisks, linkedDocs, openNCs, linkableDocs,
      activePass, currentPassNotes, priorPassNotes,
      crosswalksByFramework,
      navGroups,
      comments, firmUsers,
      requestedByName, reviewedByName, isReviewer, reviewContext,
      assessmentStateFingerprint: assessmentStateFingerprint(recordedState),
      canSearchPolicyContent,
      policySearchDocs,
      policyRetrievalConfigured: localPolicyConfigured || openRouterPolicyConfigured,
      policyRetrievalMessage: localPolicyConfigured || openRouterPolicyConfigured
        ? ''
        : `${policyRetrieval.configurationError()} ${openRouterPolicyRetrieval.configurationError()}`,
      policyRetrievalModels: policyRetrieval.modelInfo(),
      policyRetrievalProviders,
      evidenceAi,
      aiConfigured: ai.isConfigured() && canUseExternalPolicyProcessing,
      aiConfigurationMessage: canUseExternalPolicyProcessing
        ? ai.configurationError()
        : 'A manager must grant ai.external_process before assessment context can be sent to an external AI provider.',
      aiExternalAuthorized: canUseExternalPolicyProcessing,
      aiProvider: ai.providerLabel(),
      aiModel: ai.model(),
      aiModels: ai.availableModels()
    });
  }
  app.get('/workspaces/:wsId/controls/assess/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), renderAssessment);

  // Evidence Library retrieval. Query embedding shortlists persistent vectors,
  // then the fixed NVIDIA reranker receives only bounded candidate excerpts.
  // Results are advisory and never mutate assessment state or evidence links.
  app.post('/workspaces/:wsId/controls/assess/:isoId/evidence-search', requireAuth, requireWorkspace,
    requirePermission('control.update'), async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      const permissions = req.userPerms || new Set();
      const required = ['evidence.view', 'evidence.download', 'ai.external_process'];
      const missing = required.filter(permission => !rbac.hasPermission(permissions, permission));
      if (missing.length) {
        return res.status(403).json({
          ok: false,
          code: 'external_evidence_processing_forbidden',
          error: `Evidence search requires ${missing.join(', ')} permission${missing.length === 1 ? '' : 's'}.`
        });
      }
      if (!req.body || req.body.ai_external_ack !== 'accepted'
          || req.body.ai_data_classification !== 'non_confidential_trial') {
        return res.status(400).json({
          ok: false,
          code: 'external_evidence_acknowledgement_required',
          error: 'Confirm that the indexed files are sanitized, non-confidential trial evidence before reranking excerpts with the logged OpenRouter/NVIDIA free endpoint.'
        });
      }
      if (!evidenceRetrieval.isConfigured()) {
        return res.status(503).json({
          ok: false,
          code: 'openrouter_evidence_not_configured',
          error: evidenceRetrieval.configurationError()
        });
      }
      const item = hydrateAssessmentItem(db.prepare(`SELECT * FROM iso_items
        WHERE id=? AND type IN ('clause','control')`).get(req.params.isoId));
      if (!item) return res.status(404).json({ ok: false, error: 'ISO item not found.' });
      const runKey = `${req.workspace.id}:${req.user.id}:${item.id}`;
      if (activeExternalEvidenceSearchRuns.has(runKey)) {
        return res.status(429).json({
          ok: false,
          code: 'evidence_search_busy',
          error: 'An Evidence Library search is already running for this item.'
        });
      }
      activeExternalEvidenceSearchRuns.add(runKey);
      const startedAt = Date.now();
      let audited = false;
      try {
        const result = await evidenceRetrieval.searchEvidence({
          db,
          workspaceId: req.workspace.id,
          isoItemId: item.id,
          queries: buildPolicySearchQueries(item),
          resolveUploadPath,
          beforeEgress(stage, metadata) {
            const reranking = stage === 'reranking';
            logAction(req.user.id, req.workspace.id,
              reranking ? 'ai_evidence_rerank_egress_started' : 'ai_evidence_query_egress_started',
              item.type, item.id, {
                provider: 'OpenRouter',
                stage,
                external_processing: true,
                external_processing_acknowledged: true,
                acknowledgement_version: evidenceRetrieval.DISCLOSURE_VERSION,
                embedding_model: evidenceRetrieval.modelInfo().embedding_model,
                reranker_model: evidenceRetrieval.modelInfo().reranker_model,
                searched_evidence_count: Number(metadata && metadata.searched_evidence_count || 0),
                chunks_considered: Number(metadata && metadata.chunks_considered || 0),
                candidate_count: Number(metadata && metadata.candidate_count || 0),
                candidate_evidence_ids: reranking
                  ? (metadata.candidate_evidence_ids || []).map(Number).filter(Number.isSafeInteger).slice(0, evidenceRetrieval.LIMITS.candidateChunks)
                  : [],
                data_categories: reranking
                  ? ['iso_control_guidance_sent_to_openrouter', 'shortlisted_non_confidential_evidence_plaintext_sent_to_logged_free_reranker']
                  : ['iso_control_guidance_sent_to_logged_free_embedding_endpoint']
              }, { ...auditCtx(req), strict: true });
            audited = true;
          }
        });
        const citationPassages = result.passages.length
          ? await evidenceRetrieval.materializeEvidencePassages({
            db,
            workspaceId: req.workspace.id,
            isoItemId: item.id,
            sourceRefs: result.passages.map(passage => passage.source_ref),
            resolveUploadPath,
            maxPassages: evidenceRetrieval.LIMITS.resultPassages
          })
          : [];
        const citationByRef = new Map(citationPassages.map(passage => [passage.source_ref, passage]));
        result.passages = result.passages.map(passage => {
          const canonical = citationByRef.get(passage.source_ref);
          if (!canonical) {
            throw new policyRetrieval.PolicyRetrievalError(
              'An evidence citation changed before the result could be returned.',
              'stale_evidence_citation', 409
            );
          }
          return {
            ...passage,
            citation_token: issueAssessmentCitationToken(req, item, 'evidence', canonical)
          };
        });
        logAction(req.user.id, req.workspace.id, 'ai_evidence_search_completed', item.type, item.id, {
          provider: 'OpenRouter',
          searched_evidence_count: result.searched_evidence_count,
          chunks_considered: result.chunks_considered,
          passage_count: result.passages.length,
          duration_ms: Date.now() - startedAt
        }, auditCtx(req));
        return res.json({ ok: true, result });
      } catch (error) {
        logAction(req.user.id, req.workspace.id, 'ai_evidence_search_failed', item.type, item.id, {
          provider: 'OpenRouter',
          external_egress_started: audited,
          error_type: boundedText(error && error.name, 80) || 'Error',
          error_code: boundedText(error && error.code, 100),
          duration_ms: Date.now() - startedAt
        }, auditCtx(req));
        const publicError = error instanceof policyRetrieval.PolicyRetrievalError;
        const status = publicError ? Number(error.status) : 500;
        return res.status(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500).json({
          ok: false,
          code: publicError ? boundedText(error.code, 100) || 'evidence_retrieval_failed' : 'evidence_retrieval_failed',
          error: publicError
            ? boundedText(error.message, 500) || 'Evidence retrieval failed.'
            : 'Evidence retrieval failed because of an internal error. No result was retained.'
        });
      } finally {
        activeExternalEvidenceSearchRuns.delete(runKey);
      }
    });

  // Policy coverage search. Local ONNX remains the private default. The
  // OpenRouter NVIDIA free-model trial is a separate, explicit choice with a
  // literal per-run acknowledgement before any selected text can leave Nimbus.
  app.post('/workspaces/:wsId/controls/assess/:isoId/policy-search', requireAuth, requireWorkspace,
    requirePermission('control.update'), requirePermission('document.view'), async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      const item = hydrateAssessmentItem(db.prepare(`SELECT * FROM iso_items
        WHERE id=? AND type IN ('clause','control')`).get(req.params.isoId));
      if (!item) return res.status(404).json({ ok: false, error: 'ISO item not found.' });
      const engine = boundedText(req.body && req.body.engine, 40) || 'local';
      if (!['local', 'openrouter-nemotron'].includes(engine)) {
        return res.status(400).json({ ok: false, code: 'policy_engine_invalid', error: 'Choose a supported policy-search engine.' });
      }
      const external = engine === 'openrouter-nemotron';
      if (external && !rbac.hasPermission(req.userPerms || new Set(), 'ai.external_process')) {
        return res.status(403).json({
          ok: false,
          code: 'external_processing_forbidden',
          error: 'You do not have permission to send selected policy text to an external AI provider.'
        });
      }
      if (external ? !openRouterPolicyRetrieval.isConfigured() : !policyRetrieval.isConfigured()) {
        const message = external ? openRouterPolicyRetrieval.configurationError() : policyRetrieval.configurationError();
        return res.status(503).json({ ok: false, code: external ? 'openrouter_policy_not_configured' : 'policy_models_missing', error: message });
      }
      if (external && (!req.body || req.body.external_processing_acknowledged !== true)) {
        return res.status(400).json({
          ok: false,
          code: 'external_processing_acknowledgement_required',
          error: 'Confirm that the selected policies are non-confidential trial data before sending text to the logged OpenRouter/NVIDIA free endpoints.'
        });
      }
      const parsed = parsePolicyDocumentIds(req.body && req.body.document_ids);
      if (parsed.error) return res.status(parsed.error.includes('no more than') ? 413 : 400).json({ ok: false, error: parsed.error });
      if (external && parsed.ids.length > openRouterPolicyRetrieval.MAX_DOCUMENTS) {
        return res.status(413).json({
          ok: false,
          code: 'openrouter_policy_document_limit',
          error: `Select no more than ${openRouterPolicyRetrieval.MAX_DOCUMENTS} policies for the OpenRouter free-model trial.`
        });
      }

      const externalRunKey = external ? `${req.workspace.id}:${req.user.id}:${item.id}` : null;
      if (externalRunKey && activeExternalPolicySearchRuns.has(externalRunKey)) {
        return res.status(429).json({ ok: false, code: 'openrouter_policy_run_active', error: 'An OpenRouter policy search is already running for this item.' });
      }
      if (externalRunKey) activeExternalPolicySearchRuns.add(externalRunKey);

      const startedAt = Date.now();
      let documents;
      let basisFingerprint;
      let startedAudit = false;
      try {
        documents = loadPolicySearchDocuments(req.workspace.id, item.id, parsed.ids);
        basisFingerprint = policySourceFingerprint(documents);
        const models = external ? openRouterPolicyRetrieval.modelInfo() : policyRetrieval.modelInfo();
        logAction(req.user.id, req.workspace.id, 'ai_policy_search_started', item.type, item.id, {
          engine,
          provider: external ? 'OpenRouter' : 'local',
          local_only: !external,
          external_processing: external,
          external_processing_acknowledged: external,
          acknowledgement_version: external ? 'openrouter_nvidia_free_logging_v1' : null,
          selected_document_ids: parsed.ids,
          selected_document_count: documents.length,
          embedding_model: models.embedding_model,
          embedding_revision: models.embedding_revision,
          reranker_model: models.reranker_model,
          reranker_revision: models.reranker_revision,
          data_categories: external
            ? ['iso_control_guidance_sent_to_openrouter', 'selected_html_converted_controlled_document_plaintext_sent_to_openrouter_logged_free_trial']
            : ['selected_controlled_document_text_local_only']
        }, { ...auditCtx(req), strict: true });
        startedAudit = true;

        const retrievalInput = {
          documents,
          queries: buildPolicySearchQueries(item),
          limit: policyRetrieval.LIMITS.resultPassages
        };
        const retrieval = external
          ? await openRouterPolicyRetrieval.withRunSlot(async () => {
            let readyDocuments;
            try {
              readyDocuments = loadPolicySearchDocuments(req.workspace.id, item.id, parsed.ids);
            } catch (_) {
              throw new policyRetrieval.PolicyRetrievalError(
                'A selected policy changed or became unavailable while this search was waiting. No text was sent; refresh and try again.',
                'stale_policy_source', 409
              );
            }
            if (policySourceFingerprint(readyDocuments) !== basisFingerprint) {
              throw new policyRetrieval.PolicyRetrievalError(
                'A selected policy changed while this search was waiting. No text was sent; refresh and try again.',
                'stale_policy_source', 409
              );
            }
            return policyRetrieval.retrievePolicyPassages({
              ...retrievalInput,
              retrievalBackend: await openRouterPolicyRetrieval.backend(),
              retrievalModels: models,
              retrievalLimitations: openRouterPolicyRetrieval.limitations(),
              minimumScore: openRouterPolicyRetrieval.minimumScore(),
              maxTotalCharacters: openRouterPolicyRetrieval.MAX_TOTAL_CHARACTERS,
              maxRawTotalCharacters: openRouterPolicyRetrieval.MAX_RAW_TOTAL_CHARACTERS,
              includeDocumentNames: false
            });
          })
          : await policyRetrieval.retrievePolicyPassages(retrievalInput);

        let latestDocuments;
        try {
          latestDocuments = loadPolicySearchDocuments(req.workspace.id, item.id, parsed.ids);
        } catch (_) {
          latestDocuments = null;
        }
        if (!latestDocuments || policySourceFingerprint(latestDocuments) !== basisFingerprint) {
          logAction(req.user.id, req.workspace.id, 'ai_policy_search_discarded', item.type, item.id, {
            engine, local_only: !external, reason: 'stale_policy_source',
            selected_document_ids: parsed.ids, duration_ms: Date.now() - startedAt
          }, auditCtx(req));
          return res.status(409).json({
            ok: false,
            code: 'stale_policy_source',
            error: 'A selected policy changed while it was being analysed. The results were discarded; refresh and search again.'
          });
        }

        logAction(req.user.id, req.workspace.id, 'ai_policy_search', item.type, item.id, {
          engine,
          provider: external ? 'OpenRouter' : 'local',
          local_only: !external,
          external_processing: external,
          selected_document_ids: parsed.ids,
          selected_document_count: retrieval.selected_document_count,
          searched_document_count: retrieval.searched_document_count,
          chunks_considered: retrieval.chunks_considered,
          passage_count: retrieval.passages.length,
          skipped_document_count: retrieval.skipped_documents.length,
          duration_ms: Date.now() - startedAt
        }, auditCtx(req));
        const documentById = new Map(documents.map(document => [Number(document.id), document]));
        const publicRetrieval = {
          ...retrieval,
          passages: retrieval.passages.map(passage => {
            const document = documentById.get(Number(passage.document_id));
            if (!document) {
              throw new policyRetrieval.PolicyRetrievalError(
                'A policy citation changed before the result could be returned.',
                'stale_policy_citation', 409
              );
            }
            return {
              ...passage,
              citation_token: issueAssessmentCitationToken(req, item, 'policy', passage)
            };
          })
        };
        return res.json({
          ok: true,
          ...publicRetrieval,
          control: { id: item.id, title: boundedText(item.title, 500) },
          source_fingerprint: basisFingerprint,
          engine,
          provider: external ? 'OpenRouter' : 'local',
          local_only: !external
        });
      } catch (error) {
        if (startedAudit) {
          logAction(req.user.id, req.workspace.id, 'ai_policy_search_failed', item.type, item.id, {
            engine,
            provider: external ? 'OpenRouter' : 'local',
            local_only: !external,
            external_processing: external,
            selected_document_ids: parsed.ids,
            error_type: boundedText(error && error.name, 80) || 'Error',
            error_code: boundedText(error && error.code, 100),
            duration_ms: Date.now() - startedAt
          }, auditCtx(req));
        }
        const publicError = error instanceof policyRetrieval.PolicyRetrievalError;
        const status = publicError ? Number(error && error.status) : 500;
        return res.status(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500).json({
          ok: false,
          code: publicError ? (boundedText(error && error.code, 100) || 'policy_retrieval_failed') : 'policy_retrieval_failed',
          error: publicError
            ? (boundedText(error && error.message, 500) || 'Policy analysis failed.')
            : 'Policy analysis failed because of an internal error. No result was retained.'
        });
      } finally {
        if (externalRunKey) activeExternalPolicySearchRuns.delete(externalRunKey);
      }
    });

  // Assessment copilot. One request automatically retrieves bounded candidate
  // passages from governed sources, then returns a draft and writes only
  // mandatory audit events. The existing form, optimistic-concurrency token,
  // Save action, assessment pass, and reviewer signoff remain authoritative.
  app.post('/workspaces/:wsId/controls/assess/:isoId/copilot', requireAuth, requireWorkspace,
    requirePermission('control.update'), async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      if (!ai.isConfigured()) {
        return res.status(503).json({ ok: false, error: `${ai.configurationError()} Update .env and restart.` });
      }
      if (!rbac.hasPermission(req.userPerms || new Set(), 'ai.external_process')) {
        return res.status(403).json({
          ok: false,
          code: 'assessment_external_processing_forbidden',
          error: 'You do not have permission to send assessment context to an external AI provider.'
        });
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (Object.prototype.hasOwnProperty.call(body, 'selected_citations')
          || Object.prototype.hasOwnProperty.call(body, 'selected_source_passages')) {
        return res.status(400).json({
          ok: false,
          code: 'assessment_client_sources_rejected',
          error: 'Assessment Copilot source selection is automatic and server-owned. Remove client-supplied source fields and try again.'
        });
      }
      if (body.automatic_context !== true
          || body.ai_external_ack !== 'accepted'
          || body.ai_data_classification !== 'non_confidential_trial'
          || body.ai_disclosure_version !== ASSESSMENT_AUTOMATIC_DISCLOSURE_VERSION) {
        return res.status(400).json({
          ok: false,
          code: 'assessment_external_acknowledgement_required',
          error: 'Confirm automatic context for this one Copilot run and that the assessment context and automatically shortlisted excerpts are sanitized non-confidential trial data.'
        });
      }
      const item = hydrateAssessmentItem(db.prepare(`SELECT * FROM iso_items
        WHERE id=? AND type IN ('clause','control')`).get(req.params.isoId));
      if (!item) return res.status(404).json({ ok: false, error: 'ISO item not found.' });
      const questions = getAssessmentQuestions(item);
      const selectedModel = ai.resolveModel(body.model);
      const initialBundle = buildAssessmentCopilotContext(req, item, questions);
      const requestedSnapshot = boundedText(body.last_updated_snapshot, 30);
      const basisSnapshot = boundedText(initialBundle.state.last_updated, 30);
      const requestedFingerprint = boundedText(body.state_fingerprint_snapshot, 64);
      const basisFingerprint = assessmentStateFingerprint(initialBundle.state);
      if (requestedSnapshot !== basisSnapshot || requestedFingerprint !== basisFingerprint) {
        return res.status(409).json({
          ok: false,
          code: 'stale_assessment',
          error: 'This assessment changed after the page loaded. Refresh it before asking the copilot again.'
        });
      }

      const runKey = `${req.workspace.id}:${req.user.id}:${item.id}`;
      if (activeAssessmentCopilotRuns.has(runKey)) {
        return res.status(429).json({
          ok: false,
          code: 'assessment_copilot_busy',
          error: 'A copilot draft is already running for this assessment. Wait for it to finish before trying again.'
        });
      }
      activeAssessmentCopilotRuns.add(runKey);

      try {
        let automatic;
        try {
          automatic = await retrieveAutomaticAssessmentSources(req, item);
        } catch (error) {
          throw normalizeAutomaticSourceChange(error);
        }
        const bundle = buildAssessmentCopilotContext(
          req, item, questions, automatic.basis.passages, automatic.retrieval
        );
        if (boundedText(bundle.state.last_updated, 30) !== basisSnapshot
            || assessmentStateFingerprint(bundle.state) !== basisFingerprint) {
          throw new policyRetrieval.PolicyRetrievalError(
            'This assessment changed during automatic retrieval. No final Copilot context was sent; refresh and run it again.',
            'stale_assessment', 409
          );
        }

        let preEgressBasis;
        try {
          preEgressBasis = await materializeAssessmentCitations(req, item, automatic.claims);
        } catch (error) {
          throw normalizeAutomaticSourceChange(error);
        }
        if (preEgressBasis.fingerprint !== automatic.basis.fingerprint) {
          throw staleAutomaticContextError();
        }
        try {
          logAction(req.user.id, req.workspace.id, 'ai_assessment_copilot_started', item.type, item.id, {
            requested_model: selectedModel,
            provider: ai.providerLabel(),
            context_counts: bundle.counts,
            automatic_context: true,
            external_processing: true,
            external_processing_acknowledged: true,
            acknowledgement_version: ASSESSMENT_AUTOMATIC_DISCLOSURE_VERSION,
            data_classification: 'non_confidential_trial',
            retrieval_fingerprint: automatic.basis.fingerprint,
            automatically_shortlisted_source_refs: automatic.basis.passages.map(passage => passage.source_ref),
            automatically_shortlisted_source_count: automatic.basis.passages.length,
            automatically_shortlisted_characters: automatic.basis.passages
              .reduce((sum, passage) => sum + passage.excerpt.length, 0),
            retrieval: {
              policy: automatic.retrieval.policy,
              evidence: automatic.retrieval.evidence
            },
            data_categories: [
              'workspace_scope', 'iso_guidance', 'assessment_draft', 'diagnostic_answers', 'linked_metadata',
              ...(automatic.basis.passages.length
                ? ['automatically_shortlisted_policy_or_evidence_excerpts']
                : [])
            ]
          }, { ...auditCtx(req), strict: true });
        } catch (_) {
          throw new policyRetrieval.PolicyRetrievalError(
            'The required automatic-context audit event could not be recorded. No final Copilot context was sent.',
            'assessment_copilot_audit_failed', 500
          );
        }

        const raw = await ai.suggestControlAssessment({ context: bundle.context, model: selectedModel });
        const latestState = db.prepare(`SELECT * FROM v_control_states
          WHERE workspace_id=? AND iso_item_id=?`).get(req.workspace.id, item.id);
        const latestSnapshot = boundedText(latestState && latestState.last_updated, 30);
        if (latestSnapshot !== basisSnapshot || assessmentStateFingerprint(latestState) !== basisFingerprint) {
          logAction(req.user.id, req.workspace.id, 'ai_assessment_copilot_discarded', item.type, item.id, {
            reason: 'stale_assessment',
            requested_model: selectedModel,
            actual_model: raw.model || selectedModel
          }, auditCtx(req));
          return res.status(409).json({
            ok: false,
            code: 'stale_assessment',
            error: 'This assessment changed while the copilot was drafting. Its response was discarded; refresh and run it again.'
          });
        }
        let latestAutomaticBasis;
        try {
          latestAutomaticBasis = await materializeAssessmentCitations(req, item, automatic.claims);
        } catch (error) {
          const normalized = normalizeAutomaticSourceChange(error);
          if (!(normalized instanceof policyRetrieval.PolicyRetrievalError)
              || normalized.code !== 'stale_automatic_context') {
            throw normalized;
          }
          logAction(req.user.id, req.workspace.id, 'ai_assessment_copilot_discarded', item.type, item.id, {
            reason: 'stale_automatic_context',
            requested_model: selectedModel,
            actual_model: raw.model || selectedModel,
            error_code: boundedText(error && error.code, 100)
          }, auditCtx(req));
          return res.status(409).json({
            ok: false,
            code: 'stale_automatic_context',
            error: 'An automatically retrieved source changed while the Copilot was drafting. Its response was discarded; run it again to retrieve fresh context.'
          });
        }
        if (latestAutomaticBasis.fingerprint !== automatic.basis.fingerprint) {
          logAction(req.user.id, req.workspace.id, 'ai_assessment_copilot_discarded', item.type, item.id, {
            reason: 'stale_automatic_context',
            requested_model: selectedModel,
            actual_model: raw.model || selectedModel
          }, auditCtx(req));
          return res.status(409).json({
            ok: false,
            code: 'stale_automatic_context',
            error: 'An automatically retrieved source changed while the Copilot was drafting. Its response was discarded; run it again to retrieve fresh context.'
          });
        }
        const statuses = new Set([
          'Not Assessed', 'Not Implemented', 'Work In Progress', 'Partially Implemented', 'Implemented'
        ]);
        const providerLimitations = boundedList(raw.limitations, 12, 700);
        const retrievalLimitations = boundedList(automatic.retrieval.limitations, 12, 700);
        const suggestion = {
          status: statuses.has(raw.status) ? raw.status : 'Not Assessed',
          maturity: Math.max(0, Math.min(5, Number(raw.maturity) || 0)),
          confidence: ['low', 'medium', 'high'].includes(String(raw.confidence || '').toLowerCase())
            ? String(raw.confidence).toLowerCase()
            : 'low',
          rationale: boundedText(raw.rationale, 2500),
          notes_draft: boundedText(raw.notes_draft, 6000),
          gaps: boundedList(raw.gaps, 12, 700),
          missing_evidence: boundedList(raw.missing_evidence, 12, 700),
          follow_up_questions: boundedList(raw.follow_up_questions, 12, 700),
          recommended_actions: boundedList(raw.recommended_actions, 12, 700),
          limitations: providerLimitations
        };
        const returnedRefs = boundedList(raw.source_refs, 30, 160)
          .filter(ref => bundle.sourceLabels.has(ref));
        suggestion.sources = returnedRefs.map(ref => ({ ref, label: bundle.sourceLabels.get(ref) }));

        const enforcedLimitations = [];
        if (!bundle.hasClientBasis) {
          suggestion.status = 'Not Assessed';
          suggestion.maturity = 0;
          suggestion.confidence = 'low';
          enforcedLimitations.push('No client-specific assessment basis was supplied. Gather current-state information before selecting a status.');
        }
        const evidenceBasisCount = bundle.counts.evidence + bundle.counts.retrieved_evidence;
        if (suggestion.status === 'Implemented' && evidenceBasisCount === 0) {
          suggestion.confidence = 'low';
          enforcedLimitations.push('No linked evidence metadata is available. An Implemented draft requires human verification of operating evidence.');
        }
        if (suggestion.maturity >= 3 && evidenceBasisCount === 0) {
          suggestion.confidence = 'low';
          enforcedLimitations.push('Capability level 3 or above requires records demonstrating consistent operation; no linked evidence metadata is available.');
        }
        const providerRoom = Math.max(0, 16 - enforcedLimitations.length - retrievalLimitations.length);
        suggestion.limitations = boundedList([
          ...enforcedLimitations,
          ...providerLimitations.slice(0, providerRoom),
          ...retrievalLimitations
        ], 16, 700);

        logAction(req.user.id, req.workspace.id, 'ai_assessment_copilot', item.type, item.id, {
          requested_model: raw.requested_model || selectedModel,
          actual_model: raw.model || selectedModel,
          suggested_status: suggestion.status,
          suggested_maturity: suggestion.maturity,
          confidence: suggestion.confidence,
          source_count: suggestion.sources.length,
          context_counts: bundle.counts
        }, auditCtx(req));

        return res.json({
          ok: true,
          suggestion,
          model: raw.model || selectedModel,
          provider: ai.providerLabel(),
          context_counts: bundle.counts,
          retrieval: automatic.retrieval,
          retrieval_fingerprint: automatic.basis.fingerprint,
          saved_state_snapshot: boundedText(bundle.state.last_updated, 30),
          saved_state_fingerprint: basisFingerprint
        });
      } catch (error) {
        logAction(req.user.id, req.workspace.id, 'ai_assessment_copilot_failed', item.type, item.id, {
          requested_model: selectedModel,
          provider: ai.providerLabel(),
          error_type: boundedText(error && error.name, 80) || 'Error'
        }, auditCtx(req));
        const publicError = error instanceof policyRetrieval.PolicyRetrievalError;
        const status = publicError ? Number(error.status) : 502;
        return res.status(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502).json({
          ok: false,
          code: publicError ? boundedText(error.code, 100) || 'assessment_automatic_context_failed' : 'assessment_copilot_failed',
          error: publicError
            ? boundedText(error.message, 500) || 'Automatic assessment context could not be verified.'
            : error.message || 'AI assessment request failed.'
        });
      } finally {
        activeAssessmentCopilotRuns.delete(runKey);
      }
    });

  app.post('/workspaces/:wsId/controls/assess/:isoId', requireAuth, requireWorkspace, requirePermission('control.update'), (req, res, nextMw) => {
    const item = hydrateAssessmentItem(db.prepare(`SELECT * FROM iso_items WHERE id=? AND type IN ('clause','control')`).get(req.params.isoId));
    if (!item) return res.status(404).send('Not found');
    const base = `/workspaces/${req.workspace.id}/controls/assess`;
    // Skipping is navigation. It must not create state, a pass or a history entry.
    if (req.body.action === 'skip') {
      // Native form submission retains edits privately too, without JavaScript.
      if (req.body.private_draft_generation !== undefined && !req.body.draft_id) {
        try {
          if (req.body.assessment_context !== undefined && String(req.body.assessment_context) !== String(getActivePass(req.workspace.id)?.id || '')) throw personalDrafts.failure('The assessment pass changed. Your entered edits are preserved; review the current pass before retaining them here.');
          personalDrafts.save(db,{workspaceId:req.workspace.id,actorId:req.user.id,kind:'assessment',recordId:item.id,contextKey:String(getActivePass(req.workspace.id)?.id || ''),encryptionEnabled:!!req.workspace.encryption_enabled}, {
            payload:req.body,baseVersion:String(req.body.expected_record_version || 0),generation:Number(req.body.private_draft_generation),expectedDraftVersion:Number(req.body.private_draft_version),clientSaveId:crypto.randomUUID()
          });
        } catch(error) { req.assessmentRecovery={body:req.body,message:error.message};res.status(error.status||422);return renderAssessment(req,res,nextMw); }
      }
      const next = db.prepare("SELECT id FROM iso_items WHERE type IN ('clause','control') AND sort_order>? ORDER BY sort_order LIMIT 1").get(item.sort_order);
      return res.redirect(next ? `${base}/${next.id}` : `${base}?done=1`);
    }
    const pass = getActivePass(req.workspace.id);
    const context = { workspaceId:req.workspace.id, actorId:req.user.id, kind:'assessment', recordId:item.id,
      contextKey:String(pass?.id || ''), encryptionEnabled:!!req.workspace.encryption_enabled };
    let effectiveBody = req.body;
    try {
      const result = personalDrafts.commit(db, context, req.body, body => {
        effectiveBody = body;
        if (body.assessment_context !== undefined && String(body.assessment_context) !== context.contextKey) {
          throw personalDrafts.failure('The assessment pass changed. Your edits are preserved below. Review the current pass before recording them.');
        }
        const prior = db.prepare('SELECT * FROM v_control_states WHERE workspace_id=? AND iso_item_id=?').get(req.workspace.id,item.id);
        const expected = body.expected_record_version;
        if (expected === undefined) throw personalDrafts.failure('This form predates version protection. Your edits are preserved; compare them and record from this updated form.');
        if (expected !== undefined && (!/^\d+$/.test(String(expected)) || Number(expected) !== Number(prior?.record_version || 0))) {
          throw personalDrafts.failure('Another consultant changed this assessment. Compare the recorded version below with your edits before recording a new conclusion.');
        }
        if (expected === undefined && body.last_updated_snapshot && body.last_updated_snapshot !== prior?.last_updated) {
          throw personalDrafts.failure('Another consultant changed this assessment. Your edits are preserved below.');
        }
        const { applicability, status, maturity, inclusion_justification, exclusion_justification, notes, scope_pct } = body;
        const validStatuses = ['Not Assessed','Not Implemented','Work In Progress','Partially Implemented','Implemented','Not Applicable'];
        if (status !== undefined && (!validStatuses.includes(status) || (item.type === 'clause' && status === 'Not Applicable'))) throw personalDrafts.failure('Choose a valid conclusion. Mandatory clauses cannot be Not Applicable.',422);
        if (applicability !== undefined && !['included','excluded','undecided'].includes(applicability)) throw personalDrafts.failure('Choose Included, Excluded or Undecided.',422);
        if (maturity !== undefined && maturity !== '' && !/^[0-5]$/.test(String(maturity))) throw personalDrafts.failure('Capability must be a whole number from 0 to 5.',422);
        if (scope_pct !== undefined && scope_pct !== '' && (!/^\d+$/.test(String(scope_pct)) || Number(scope_pct)>100)) throw personalDrafts.failure('Scope must be a whole percentage from 0 to 100.',422);
        for (const field of ['notes','inclusion_justification','exclusion_justification']) if (String(body[field] || '').length > 40000) throw personalDrafts.failure('Assessment text must be 40,000 characters or fewer per field.',422);
        const sets=[], vals=[];
        const put=(key,value)=>{ sets.push(`${key}=?`); vals.push(value); };
        if (item.type === 'control' && applicability !== undefined) put('applicability',applicability);
        if (item.type === 'clause') put('applicability','included');
        if (status !== undefined) put('status',status);
        if (maturity !== undefined && maturity !== '') put('maturity',Number(maturity));
        if (item.type === 'control' && inclusion_justification !== undefined) put('inclusion_justification',inclusion_justification || null);
        if (item.type === 'control' && exclusion_justification !== undefined) put('exclusion_justification',exclusion_justification || null);
        if (notes !== undefined) put('notes',notes || null);
        if (scope_pct !== undefined) put('scope_pct',scope_pct === '' ? null : Number(scope_pct));
        if (body.diagnostic_set_id !== undefined || Object.keys(body).some(k=>/^q_\d+$/.test(k))) put('assessment_answers',diagnostics.serialize(item.id,getAssessmentQuestions(item),body));
        const reviewInvalidated = !!(prior && prior.review_status && prior.review_status !== 'none' && sets.some((s,i) => String(prior[s.slice(0,-2)] ?? '') !== String(vals[i] ?? '')));
        if (reviewInvalidated) sets.push("review_status='none'",'review_requested_by=NULL','review_requested_at=NULL','reviewed_by=NULL','reviewed_at=NULL','review_reason=NULL');
        sets.push('last_updated=CURRENT_TIMESTAMP');
        if (status && status !== 'Not Assessed') sets.push('last_verified_at=CURRENT_TIMESTAMP');
        const state = getOrCreateState(req.workspace.id,item.id);
        const requirementId=ctlWrites.requirementId(db,'iso27001',item.id);
        if (!requirementId) throw personalDrafts.failure('The requirement is unavailable. Your edits have been retained.',422);
        const converted=ctlWrites.convergeSets(sets,vals);
        const updated=db.prepare(`UPDATE control_instances SET ${converted.sets.join(',')} WHERE workspace_id=? AND requirement_id=? AND entity_id IS NULL AND record_version=?`)
          .run(...converted.vals,req.workspace.id,requirementId,state.record_version);
        if (!updated.changes) throw personalDrafts.failure('The recorded assessment changed. Compare your edits before retrying.');
        const current=db.prepare('SELECT * FROM v_control_states WHERE workspace_id=? AND iso_item_id=?').get(req.workspace.id,item.id);
        const passId=ensureActivePassId(req.workspace.id,req.user.id);
        db.prepare(`INSERT INTO control_state_history(workspace_id,iso_item_id,changed_by,status,applicability,maturity,scope_pct,inclusion_justification,exclusion_justification,notes,assessment_answers,pass_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.workspace.id,item.id,req.user.id,current.status,current.applicability,current.maturity,current.scope_pct,current.inclusion_justification,current.exclusion_justification,current.notes,current.assessment_answers,passId);
        fts.refresh(req.workspace.id,'control',item.id);
        logAction(req.user.id,req.workspace.id,'gap_assess_item',item.type,item.id,{status,applicability,review_invalidated:reviewInvalidated,record_version:current.record_version},auditCtx(req));
        const active=getActivePass(req.workspace.id);
        const next=active ? assessmentPassQuality.nextUnconcludedItem(db,req.workspace.id,active,item.sort_order) : nextUnassessedItem(req.workspace.id,item.sort_order);
        return { url:next ? `${base}/${next.id}` : `${base}?done=1` };
      });
      return res.redirect(result.url);
    } catch(error) {
      if (!error.status) return nextMw(error);
      req.assessmentRecovery={body:effectiveBody,message:error.message};
      res.status(error.status);
      return renderAssessment(req,res,nextMw);
    }
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

  // Exact recorded-version review commands; independent authority is shared across programmes.
  for(const command of ['flag-for-review','review-action','clear-flag']) {
    const permission=command==='review-action'?'assessment.signoff':'control.update';
    app.post('/workspaces/:wsId/controls/assess/:isoId/'+command,requireAuth,requireWorkspace,requirePermission(permission),(req,res)=>{
      const item=db.prepare('SELECT id,title FROM iso_items WHERE id=?').get(req.params.isoId);
      if(!item)return res.status(404).send('Not found');
      const path=`/workspaces/${req.workspace.id}/controls/assess/${item.id}`;
      try{
        const action=command==='flag-for-review'?'request':command==='clear-flag'?'clear':String(req.body.action||'');
        require('../lib/control-review').transition(db,{workspace:req.workspace,actor:req.user,framework:'iso27001',itemId:item.id,action,
          expectedRecordVersion:req.body.expected_record_version,note:command==='flag-for-review'?req.body.reason:req.body.note},
          details=>logAction(req.user.id,req.workspace.id,'assessment_review_'+action,'iso27001_assessment',item.id,details,auditCtx(req)));
        return res.redirect(path);
      }catch(error){
        return res.status(Number(error.status)||422).render('assessment_review_error',{user:req.user,ws:req.workspace,item,path,message:error.message,
          note:String(req.body.note||req.body.reason||'').slice(0,4000)});
      }
    });
  }

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

    const passVersions=db.prepare(`SELECT m.id,m.assessment_pass_id,m.engagement_id,m.completion_generation,m.source_cutoff,
      (SELECT COUNT(*) FROM assessment_pass_manifest_items i WHERE i.manifest_id=m.id) item_count,
      (SELECT COUNT(*) FROM consulting_report_pass_sources s JOIN consulting_report_snapshots r ON r.id=s.report_id WHERE s.manifest_id=m.id AND r.status='published') published_reports
      FROM assessment_pass_manifests m WHERE m.workspace_id=? ORDER BY m.assessment_pass_id DESC,m.completion_generation DESC`).all(wsId);
    passes.forEach(p => { p.quality = assessmentPassQuality.qualityForPass(db, wsId, p); p.manifests=passVersions.filter(m=>m.assessment_pass_id===p.id); });
    const active = passes.find(p => p.status === 'in_progress') || null;

    // Total clauses + controls for progress denominator.
    const totalItems = db.prepare(`SELECT COUNT(*) c FROM iso_items WHERE type IN ('clause','control')`).get().c;
    const assessedNow = db.prepare(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, wsId).cs}
      WHERE workspace_id=? AND status != 'Not Assessed'`).get(wsId).c;
    const legacyBaseline = passes.length === 0 && assessedNow > 0
      ? db.prepare(`SELECT COUNT(*) assessed, MIN(last_updated) first_updated, MAX(last_updated) last_updated
          FROM ${ctlReads.tables(db, wsId).cs} WHERE workspace_id=? AND status != 'Not Assessed'`).get(wsId)
      : null;
    const canAdoptBaseline = rbac.hasPermission(res.locals.userPerms, 'assessment.signoff');
    const canSignoff = canAdoptBaseline;

    // Find the next un-assessed item (continue button target).
    const nextItem = active
      ? assessmentPassQuality.nextUnconcludedItem(db, wsId, active, -1)
      : nextUnassessedItem(wsId, -1);

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
      totalItems, assessedNow, legacyBaseline, canAdoptBaseline, canSignoff,
      nextItem,
      orientation, trend, heatmap, themeNames: ANNEX_THEMES
    });
  });

  // Workspaces assessed before pass tracking have authoritative current-state
  // conclusions but no reportable lineage. A sign-off holder can adopt a fully
  // concluded set as Pass 1. This does not claim that historical fieldwork was
  // performed in the platform: it records one immutable adoption event, the source
  // timestamps and a digest of exactly what was adopted.
  app.post('/workspaces/:wsId/gap-assessment/adopt-baseline', requireAuth, requireWorkspace,
    requirePermission('assessment.signoff'), (req, res) => {
      const wsId = req.workspace.id;
      const totalItems = db.prepare(`SELECT COUNT(*) c FROM iso_items
        WHERE type IN ('clause','control')`).get().c;
      const T = ctlReads.tables(db, wsId);

      const adopt = db.transaction(() => {
        const existingPasses = db.prepare(`SELECT COUNT(*) c FROM assessment_passes
          WHERE workspace_id=?`).get(wsId).c;
        if (existingPasses > 0) return { ok: false, reason: 'already_adopted' };

        const rows = db.prepare(`SELECT i.id AS iso_item_id,
            cs.status, cs.applicability, cs.maturity, cs.scope_pct,
            cs.inclusion_justification, cs.exclusion_justification,
            cs.notes, cs.assessment_answers, cs.last_updated
          FROM iso_items i
          LEFT JOIN ${T.cs} cs ON cs.workspace_id=? AND cs.iso_item_id=i.id
          WHERE i.type IN ('clause','control')
          ORDER BY i.sort_order, i.id`).all(wsId);
        const concluded = rows.filter(row => row.status && row.status !== 'Not Assessed');
        if (rows.length !== totalItems || concluded.length !== totalItems) {
          return {
            ok: false,
            reason: 'incomplete',
            remaining: Math.max(0, totalItems - concluded.length)
          };
        }

        const snapshotHash = crypto.createHash('sha256').update(JSON.stringify(rows.map(row => ({
          iso_item_id: row.iso_item_id,
          status: row.status,
          applicability: row.applicability,
          maturity: row.maturity,
          scope_pct: row.scope_pct,
          inclusion_justification: row.inclusion_justification,
          exclusion_justification: row.exclusion_justification,
          notes: row.notes,
          assessment_answers: row.assessment_answers,
          source_updated_at: row.last_updated
        })))).digest('hex');
        const adoptedAt = db.prepare(`SELECT datetime('now') AS value`).get().value;
        const sourceDates = rows.reduce((acc, row) => {
          if (!row.last_updated) return acc;
          if (!acc.first || row.last_updated < acc.first) acc.first = row.last_updated;
          if (!acc.last || row.last_updated > acc.last) acc.last = row.last_updated;
          return acc;
        }, { first: null, last: null });
        const notes = 'Controlled adoption of the pre-existing assessment baseline. Current conclusions were copied without alteration; this adoption records lineage from this point forward and does not represent retrospective fieldwork in the platform.';
        const passId = Number(db.prepare(`INSERT INTO assessment_passes
          (workspace_id, pass_number, label, notes, status, started_at, started_by)
          VALUES (?, 1, 'Imported assessment baseline', ?, 'in_progress', ?, ?)`)
          .run(wsId, notes, adoptedAt, req.user.id).lastInsertRowid);
        const insertSnapshot = db.prepare(`INSERT INTO control_state_history
          (workspace_id, iso_item_id, snapshot_at, changed_by, status, applicability,
           maturity, scope_pct, inclusion_justification, exclusion_justification,
           notes, assessment_answers, pass_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        rows.forEach(row => insertSnapshot.run(
          wsId, row.iso_item_id, adoptedAt, req.user.id, row.status,
          row.applicability, row.maturity, row.scope_pct,
          row.inclusion_justification, row.exclusion_justification,
          row.notes, row.assessment_answers, passId
        ));
        return { ok: true, passId, snapshotHash, adoptedAt, sourceDates, count: rows.length };
      });

      let result;
      try {
        // Acquire the SQLite write reservation before the zero-pass check so
        // two app processes cannot both prepare a competing Pass 1 adoption.
        result = adopt.immediate();
      } catch (error) {
        if (error && error.code && error.code.startsWith('SQLITE_CONSTRAINT')) {
          return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
            'The baseline was already adopted by another user. Refresh to see the report options.', 'info'));
        }
        if (error && error.code === 'SQLITE_BUSY') {
          return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
            'Another baseline decision is being recorded. Wait a moment, then refresh before trying again.', 'info'));
        }
        throw error;
      }
      if (!result.ok && result.reason === 'already_adopted') {
        return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
          'This workspace already has formal assessment-pass history. No baseline was changed.', 'error'));
      }
      if (!result.ok) {
        return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
          `Baseline adoption is locked. ${result.remaining} requirement${result.remaining === 1 ? '' : 's'} still need${result.remaining === 1 ? 's' : ''} a conclusion.`, 'error'));
      }

      logAction(req.user.id, wsId, 'adopt_assessment_baseline', 'assessment_pass', result.passId, {
        source: 'pre_pass_control_states',
        item_count: result.count,
        snapshot_sha256: result.snapshotHash,
        adopted_at: result.adoptedAt,
        source_first_updated_at: result.sourceDates.first,
        source_last_updated_at: result.sourceDates.last,
        disclosure: 'Current conclusions copied without alteration; no retrospective fieldwork claimed.'
      }, auditCtx(req));
      return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
        'Imported baseline adopted as Pass 1. A different senior consultant or manager must independently sign it off before governed reporting.'));
    });

  app.post('/workspaces/:wsId/gap-assessment/start', requireAuth, requireWorkspace, requirePermission('assessment.start_pass'), (req, res) => {
    const wsId = req.workspace.id;
    // Only a sign-off holder may complete a pass. Starting a new pass must
    // never silently sign off the current preparer's work.
    const active = getActivePass(wsId);
    if (active) {
      return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
        `Pass ${active.pass_number} is still active. An independent reviewer must complete it before another pass can start.`, 'error'));
    }
    const lastNum = db.prepare(`SELECT COALESCE(MAX(pass_number), 0) AS n
      FROM assessment_passes WHERE workspace_id=?`).get(wsId).n;
    const nextNum = lastNum + 1;
    const hasImportedBaseline = nextNum === 1 && db.prepare(`SELECT COUNT(*) c FROM ${ctlReads.tables(db, wsId).cs}
      WHERE workspace_id=? AND status != 'Not Assessed'`).get(wsId).c > 0;
    const label = (req.body.label || '').toString().trim()
      || (nextNum === 1 ? (hasImportedBaseline ? 'Baseline verification' : 'Initial gap assessment') : `Re-assessment ${nextNum - 1}`);
    const notes = (req.body.notes || '').toString().trim() || null;
    const id = db.prepare(`INSERT INTO assessment_passes
      (workspace_id, pass_number, label, notes, status, started_by)
      VALUES (?, ?, ?, ?, 'in_progress', ?)`)
      .run(wsId, nextNum, label, notes, req.user.id).lastInsertRowid;
    logAction(req.user.id, wsId, 'start_assessment_pass', 'pass', id, { pass_number: nextNum, label });
    res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`, `Started Pass ${nextNum}: ${label}`));
  });

  app.post('/workspaces/:wsId/gap-assessment/:passId/complete', requireAuth, requireWorkspace, requirePermission('assessment.signoff'), (req, res) => {
    const wsId = req.workspace.id;
    const p = db.prepare(`SELECT * FROM assessment_passes WHERE id=? AND workspace_id=?`).get(req.params.passId, wsId);
    if (!p) return res.status(404).send('Not found');
    if (p.status === 'completed') return res.redirect(`/workspaces/${wsId}/gap-assessment`);
    if (Number(p.started_by) === Number(req.user.id)) {
      return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
        `Pass ${p.pass_number} requires independent sign-off by a different senior consultant or manager.`, 'error'));
    }
    const quality = assessmentPassQuality.qualityForPass(db, wsId, p);
    if (!quality.ready) {
      return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
        `Pass ${p.pass_number} cannot be completed. ${assessmentPassQuality.gateMessage(quality)}`, 'error'));
    }
    // Conditional UPDATE: only commit if the pass is still in_progress. Two
    // consultants clicking "Complete pass" simultaneously: the first UPDATE
    // matches and writes completed_by; the second sees changes=0 and is told
    // it was already completed. Replaces the previous LWW behaviour where both
    // writes succeeded and the audit trail recorded two different completers.
    let deliveryProjection;
    let result;
    try {
      db.transaction(() => {
        deliveryProjection = consultingDelivery.materializeAssessmentPass(db, req.workspace, p, req.user.id);
        result = db.prepare(`UPDATE assessment_passes
          SET status='completed', completed_at=datetime('now'), completed_by=?
          WHERE id=? AND status='in_progress'`).run(req.user.id, p.id);
        if (result.changes === 0) throw Object.assign(new Error('PASS_ALREADY_COMPLETED'), { code: 'PASS_ALREADY_COMPLETED' });
      })();
    } catch (error) {
      if (error && error.code === 'PASS_ALREADY_COMPLETED') {
        return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
          `Pass ${p.pass_number} was just completed by another consultant.`, 'info'));
      }
      return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
        `Pass ${p.pass_number} was not completed because its governed delivery record could not be frozen: ${error.message}`, 'error'));
    }
    if (result.changes === 0) {
      return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
        `Pass ${p.pass_number} was just completed by another consultant.`, 'info'));
    }
    logAction(req.user.id, wsId, 'complete_assessment_pass', 'pass', p.id, {
      pass_number: p.pass_number, delivery_projection: deliveryProjection
    });
    res.redirect(withToast(`/workspaces/${wsId}/delivery/pass-manifests/${deliveryProjection.manifestId}`,
      `Completed Pass ${p.pass_number}: ${p.label}. Retained ${deliveryProjection.frozen} exact assessment versions for reporting.`));
  });

  app.post('/workspaces/:wsId/gap-assessment/:passId/reopen', requireAuth, requireWorkspace, requirePermission('assessment.signoff'), (req, res) => {
    const wsId = req.workspace.id;
    const p = db.prepare(`SELECT * FROM assessment_passes WHERE id=? AND workspace_id=?`).get(req.params.passId, wsId);
    if (!p) return res.status(404).send('Not found');
    // Reopening is a governed exception; never auto-sign off a different pass.
    const other = getActivePass(wsId);
    if (other && other.id !== p.id) {
      return res.redirect(withToast(`/workspaces/${wsId}/gap-assessment`,
        `Pass ${other.pass_number} is active. Complete it before reopening Pass ${p.pass_number}.`, 'error'));
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
