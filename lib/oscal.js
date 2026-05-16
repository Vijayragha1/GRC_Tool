// OSCAL export. Generates two NIST OSCAL JSON documents from workspace data:
//   - Component Definition  (SoA = Annex A controls in scope, justification,
//                            implementation status, evidence pointers)
//   - Assessment Results    (unified findings -> OSCAL observation+finding
//                            records, with per-finding control linkage)
//
// We hit the major required fields of each model (uuid, metadata, the
// model-specific top-level container, and the leaf records) and keep
// optional fields when they carry meaning for an auditor. Round-trip
// fidelity is out of scope - this is one-way export.
//
// Spec: https://pages.nist.gov/OSCAL/concepts/layer/
// Schema reference: https://github.com/usnistgov/OSCAL (component-definition
// model, assessment-results model).
//
// Why we don't depend on @easydynamics/oscal-sdk or similar: those packages
// pull large dependency trees and we want this offline-self-contained. The
// shapes are small enough to hand-construct correctly.

const crypto = require('crypto');
const { db } = require('../db');
const findingsLib = require('./findings');

// OSCAL uses lowercase UUIDs with dashes. Node's crypto.randomUUID gives us
// exactly that shape. Wrapping for clarity.
function uuid() { return crypto.randomUUID(); }

// Deterministic UUID from a string seed. OSCAL components reference each
// other by uuid, so re-exporting the same workspace twice should produce
// stable UUIDs (an auditor diff'ing two exports doesn't want every uuid to
// change). v5-style: SHA-1 the seed, slice into the UUID format, set the
// version+variant bits per RFC 4122.
function stableUuid(seed) {
  const h = crypto.createHash('sha1').update(String(seed)).digest('hex');
  const bytes = Buffer.from(h.slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const s = bytes.toString('hex');
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20,32)}`;
}

// OSCAL timestamps are ISO 8601 with a timezone. The Z form is fine.
function isoNow() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

// Common metadata block. Every OSCAL document carries one.
function makeMetadata(title, ws) {
  return {
    title,
    'last-modified': isoNow(),
    version: '1.0.0',
    'oscal-version': '1.1.2',
    parties: [
      {
        uuid: stableUuid('party:firm:' + ws.firm_id),
        type: 'organization',
        name: 'Consulting firm',
        remarks: 'The consultancy producing this assessment artefact.'
      },
      {
        uuid: stableUuid('party:client:' + ws.id),
        type: 'organization',
        name: ws.brand_display_name || ws.client_name,
        remarks: ws.industry ? `Industry: ${ws.industry}` : undefined
      }
    ].filter(p => p.name)
  };
}

// =============================================================
// Component Definition - the SoA as an OSCAL component-definition.
// One "component" per Annex A control included in the SoA, with its
// implementation status, control-implementation justification (which
// risks it treats), and pointers to evidence files.
// =============================================================
function buildComponentDefinition(ws) {
  const wsId = ws.id;

  // SoA rows = every iso item of type 'control' with applicability and
  // status from control_states.
  const rows = db.prepare(`
    SELECT i.id, i.title, i.category,
           COALESCE(cs.applicability, 'undecided') AS applicability,
           COALESCE(cs.status, 'Not Assessed')     AS status,
           cs.inclusion_justification, cs.exclusion_justification,
           cs.notes
    FROM iso_items i
    LEFT JOIN control_states cs
      ON cs.iso_item_id = i.id AND cs.workspace_id = ?
    WHERE i.type = 'control'
    ORDER BY i.sort_order
  `).all(wsId);

  // Risks treated by each control, for inclusion justifications.
  const treatedBy = {};
  for (const r of db.prepare(`
    SELECT rc.iso_item_id, r.id AS risk_id, r.title AS risk_title,
           r.likelihood, r.impact
    FROM risk_controls rc
    INNER JOIN risks r ON r.id = rc.risk_id
    WHERE r.workspace_id = ?
  `).all(wsId)) {
    (treatedBy[r.iso_item_id] = treatedBy[r.iso_item_id] || []).push(r);
  }

  // Evidence file count per control (via the unified evidence_links table,
  // ISO 27001 rows only).
  const evCountByControl = {};
  for (const r of db.prepare(`
    SELECT item_ref, COUNT(*) AS c
    FROM evidence_links el
    INNER JOIN evidence e ON e.id = el.evidence_id
    WHERE el.framework='iso27001' AND e.workspace_id=? AND e.superseded_at IS NULL
    GROUP BY item_ref
  `).all(wsId)) {
    evCountByControl[r.item_ref] = r.c;
  }

  // OSCAL implementation-status map.
  function oscalStatus(s) {
    if (s === 'Implemented') return 'implemented';
    if (s === 'Partially Implemented') return 'partial';
    if (s === 'Work In Progress') return 'planned';
    if (s === 'Not Implemented') return 'planned';
    if (s === 'Not Applicable') return 'not-applicable';
    return 'planned';
  }

  // One OSCAL component per *included* Annex A control. Excluded controls
  // become a separate "excluded controls" component group via a single
  // catch-all component with a "controls-excluded" prop, so the auditor
  // sees the full SoA picture.
  const components = [];
  const included = rows.filter(r => r.applicability === 'included');
  const excluded = rows.filter(r => r.applicability === 'excluded');
  const undecided = rows.filter(r => !['included','excluded'].includes(r.applicability));

  for (const r of included) {
    const code = r.id.replace(/^annex-/, '').toUpperCase();
    const title = (r.title || '').replace(/^A\.[0-9.]+ /, '');
    const risks = treatedBy[r.id] || [];
    const evCount = evCountByControl[r.id] || 0;
    const justification = r.inclusion_justification ||
      (risks.length
        ? `Treats ${risks.map(rk => `R-${rk.risk_id} ${rk.risk_title} (L${rk.likelihood}xI${rk.impact})`).join('; ')}`
        : 'Included per consultant judgement; specific risk linkage pending.');

    components.push({
      uuid: stableUuid(`component:${wsId}:${r.id}`),
      type: 'service',
      title: `${code} ${title}`,
      description: justification,
      props: [
        { name: 'control-id', value: code },
        { name: 'annex-a-category', value: r.category || 'unknown' },
        { name: 'implementation-status', value: oscalStatus(r.status) },
        { name: 'evidence-count', value: String(evCount) }
      ],
      'control-implementations': [{
        uuid: stableUuid(`ci:${wsId}:${r.id}`),
        source: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/iso27001-annex-a-2022.xml',
        description: `ISO 27001:2022 Annex A ${code}.`,
        'implemented-requirements': [{
          uuid: stableUuid(`req:${wsId}:${r.id}`),
          'control-id': code.toLowerCase().replace(/\./g, '_'),
          description: justification,
          props: [
            { name: 'implementation-status', value: oscalStatus(r.status) }
          ]
        }]
      }],
      remarks: r.notes || undefined
    });
  }

  // Single rolled-up component listing excluded controls + justifications.
  // Splitting this into one component per excluded control would inflate
  // the document for low informational value.
  if (excluded.length) {
    components.push({
      uuid: stableUuid(`component:${wsId}:excluded`),
      type: 'service',
      title: `Excluded Annex A controls (${excluded.length})`,
      description:
        'Annex A controls excluded from the SoA per clause 6.1.3.d. Each ' +
        'row carries the exclusion justification recorded at workspace ' +
        'level.',
      props: [
        { name: 'role', value: 'excluded-controls-summary' }
      ],
      remarks: excluded.map(r => {
        const code = r.id.replace(/^annex-/, '').toUpperCase();
        return `${code}: ${r.exclusion_justification || '(no justification recorded)'}`;
      }).join('\n')
    });
  }

  return {
    'component-definition': {
      uuid: stableUuid(`compdef:${wsId}`),
      metadata: makeMetadata(
        `Statement of Applicability - ${ws.brand_display_name || ws.client_name}`,
        ws
      ),
      components,
      'back-matter': {
        resources: [{
          uuid: stableUuid(`source:iso27001:${wsId}`),
          title: 'ISO/IEC 27001:2022 Annex A',
          description:
            'The Annex A controls catalogue from ISO/IEC 27001:2022. ' +
            'This document references those controls by their Annex A ' +
            'code (e.g. A.5.15) rather than by an OSCAL catalog UUID, ' +
            'because no standardised OSCAL ISO 27001 catalog has been ' +
            'published. An auditor can resolve each control-id against ' +
            'the published standard.',
          rlinks: [
            { href: 'https://www.iso.org/standard/27001', 'media-type': 'text/html' }
          ]
        }]
      }
    },
    // Side metadata for our own use - lets the route surface a sensible
    // filename and summary without re-walking the OSCAL tree.
    _summary: {
      included: included.length,
      excluded: excluded.length,
      undecided: undecided.length,
      total: rows.length
    }
  };
}

// =============================================================
// Assessment Results - unified findings as OSCAL findings + observations.
// One "observation" per unified finding (severity, source, item linkage),
// plus one "finding" record per OPEN observation so an auditor's tooling
// can filter on the standard OSCAL field set.
// =============================================================
function buildAssessmentResults(ws) {
  const findings = findingsLib.getUnifiedFindings(ws.id, {});
  const observations = [];
  const oscalFindings = [];

  // OSCAL "type" enum for observations: examination | interview |
  // test | mitigation | finding | historic. Our finding sources map:
  //   nonconformity      -> finding   (formally recorded NC)
  //   audit_finding      -> examination
  //   audit_observation  -> examination
  //   gap_assessment     -> finding   (consultant judgement)
  function obsType(source) {
    if (source === 'nonconformity' || source === 'gap_assessment') return 'finding';
    return 'examination';
  }

  for (const f of findings) {
    const obsUuid = stableUuid(`obs:${ws.id}:${f.id}`);
    const code = f.item_ref
      ? f.item_ref.replace(/^annex-/, '').replace(/^clause-/, '').replace(/^ai-clause-/, '').replace(/^ai-/, '').toUpperCase()
      : null;

    observations.push({
      uuid: obsUuid,
      title: f.title,
      description: f.description || f.title,
      methods: [obsType(f.source)],
      types: [obsType(f.source)],
      collected: f.created_at ? f.created_at.replace(' ', 'T') + 'Z' : isoNow(),
      props: [
        { name: 'source',    value: f.source },
        { name: 'severity',  value: f.severity },
        { name: 'status',    value: f.status },
        { name: 'framework', value: f.framework },
        ...(code ? [{ name: 'control-id', value: code }] : []),
        ...(f.owner    ? [{ name: 'owner', value: f.owner }] : []),
        ...(f.due_date ? [{ name: 'due-date', value: f.due_date }] : [])
      ],
      remarks: f.source_label
    });

    // OSCAL "finding" record for anything still open. Closed observations
    // remain in the document as historic data but don't get a finding wrapper.
    if (f.status === 'open') {
      oscalFindings.push({
        uuid: stableUuid(`finding:${ws.id}:${f.id}`),
        title: `${f.title}${code ? ` (${code})` : ''}`,
        description: f.description || f.title,
        props: [
          { name: 'severity',  value: f.severity },
          { name: 'source',    value: f.source },
          { name: 'framework', value: f.framework }
        ],
        'related-observations': [{ 'observation-uuid': obsUuid }],
        ...(code ? {
          target: {
            type: 'objective-id',
            'target-id': code,
            status: { state: 'not-satisfied' }
          }
        } : {})
      });
    }
  }

  // OSCAL assessment-results requires at least one "result" block with a
  // start time. We model the whole engagement as one rolling result; an
  // auditor wanting per-pass results can read the unified findings ledger
  // directly.
  const resultUuid = stableUuid(`result:${ws.id}`);
  const start = isoNow();

  return {
    'assessment-results': {
      uuid: stableUuid(`ar:${ws.id}`),
      metadata: makeMetadata(
        `Assessment Results - ${ws.brand_display_name || ws.client_name}`,
        ws
      ),
      'import-ap': {
        // Required field. We don't produce a separate Assessment Plan
        // document, so we self-reference: the assessment plan is implicit
        // in the engagement workflow that produced these findings.
        href: '#self'
      },
      results: [{
        uuid: resultUuid,
        title: 'Engagement findings (rolling)',
        description:
          'All findings recorded against this engagement across the four ' +
          'sources tracked by the tool: nonconformities (clause 10.2), ' +
          'audit findings, audit observations, and gap-assessment ' +
          'statuses. Severity is normalised across sources.',
        start,
        'reviewed-controls': {
          'control-selections': [{
            description: 'ISO 27001:2022 Annex A controls in scope for this engagement.'
          }]
        },
        observations,
        findings: oscalFindings
      }]
    },
    _summary: {
      observations: observations.length,
      open_findings: oscalFindings.length
    }
  };
}

module.exports = { buildComponentDefinition, buildAssessmentResults };
