// Seed two realistic ISO 27001 engagements for demos. Idempotent:
// re-running deletes the previous demo client (by client_name) and recreates
// everything fresh. Run with: node scripts/seed-demo-clients.js
//
// Personas:
//   - Northwind Financial Services (UK fintech, mid-implementation,
//     90 of 93 SoA decisions, ~12 risks, 1 internal audit + 5 findings,
//     2 MRMs, 6 NCs, 4 improvements, branded navy)
//   - Helio Software Inc. (SaaS startup, early gap-assessment, ~70 SoA
//     decisions with many undecided, ~8 risks, 0 audits, 0 MRMs, 2 open
//     NCs, branded green)
//
// Designed to make the consultant-side dashboards / portfolio / changes-since
// reports light up with realistic data so demos read as production-shaped.

'use strict';

const { db, ensureWorkspaceMethodology, logAction } = require('../db');

const FIRM_ID = 1;
const USER_ID = 1;

// -------- helpers --------
function offsetDate(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}
function offsetDateTime(days) {
  return new Date(Date.now() + days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
}
function randomSha() {
  // Deterministic-ish fake hash so re-runs produce identical seed data.
  const c = 'abcdef0123456789';
  let s = '';
  for (let i = 0; i < 64; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

// Wipe any prior demo state for these clients so the script is idempotent.
function wipeClient(clientName) {
  const ws = db.prepare(`SELECT id FROM workspaces WHERE client_name = ? AND firm_id = ?`).get(clientName, FIRM_ID);
  if (!ws) return;
  // CASCADE handles most of the children; we manually clear what doesn't cascade.
  db.prepare(`DELETE FROM audit_findings WHERE audit_id IN (SELECT id FROM audits WHERE workspace_id = ?)`).run(ws.id);
  db.prepare(`DELETE FROM document_controls WHERE document_id IN (SELECT id FROM generated_docs WHERE workspace_id = ?)`).run(ws.id);
  db.prepare(`DELETE FROM doc_versions WHERE document_id IN (SELECT id FROM generated_docs WHERE workspace_id = ?)`).run(ws.id);
  try { db.prepare(`DELETE FROM risk_treatment_actions WHERE workspace_id = ?`).run(ws.id); } catch (_) {}
  try { db.prepare(`DELETE FROM tasks WHERE workspace_id = ?`).run(ws.id); } catch (_) {}
  try { db.prepare(`DELETE FROM suppliers WHERE workspace_id = ?`).run(ws.id); } catch (_) {}
  try { db.prepare(`DELETE FROM incidents WHERE workspace_id = ?`).run(ws.id); } catch (_) {}
  try { db.prepare(`DELETE FROM engagement_intake WHERE workspace_id = ?`).run(ws.id); } catch (_) {}
  try { db.prepare(`DELETE FROM assessment_passes WHERE workspace_id = ?`).run(ws.id); } catch (_) {}
  db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(ws.id);
  console.log(`  cleared prior workspace #${ws.id} (${clientName})`);
}

// -------- workspace creation --------
function createWorkspace(meta) {
  const id = db.prepare(`INSERT INTO workspaces
    (firm_id, client_name, industry, scope, target_cert_date, stage,
     brand_display_name, brand_primary_color, sector, frameworks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(FIRM_ID, meta.client_name, meta.industry, meta.scope, meta.target_cert_date,
         meta.stage, meta.brand_display_name, meta.brand_primary_color, meta.sector,
         JSON.stringify(meta.frameworks || ['iso27001']))
    .lastInsertRowid;
  ensureWorkspaceMethodology(id);
  return id;
}

// -------- assets --------
function seedAssets(wsId, assets) {
  const ins = db.prepare(`INSERT INTO assets
    (workspace_id, name, type, classification, owner_name,
     cia_c, cia_i, cia_a, description,
     business_criticality, rto_hours, rpo_hours, bia_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const idByName = {};
  db.transaction(() => {
    for (const a of assets) {
      const id = ins.run(wsId, a.name, a.type, a.classification, a.owner_name,
        a.cia_c, a.cia_i, a.cia_a, a.description,
        a.business_criticality, a.rto_hours, a.rpo_hours, a.bia_notes).lastInsertRowid;
      idByName[a.name] = id;
    }
  })();
  return idByName;
}

// -------- risks --------
function seedRisks(wsId, risks, assetIdByName) {
  const ins = db.prepare(`INSERT INTO risks
    (workspace_id, title, description, asset_id, threat, vulnerability,
     likelihood, impact, treatment, owner_name, status,
     residual_likelihood, residual_impact)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const r of risks) {
      ins.run(wsId, r.title, r.description,
        r.asset ? assetIdByName[r.asset] || null : null,
        r.threat, r.vulnerability,
        r.likelihood, r.impact, r.treatment, r.owner_name, r.status,
        r.residual_likelihood || null, r.residual_impact || null);
    }
  })();
}

// -------- SoA decisions --------
// Build control_states rows from a per-category status profile. Each profile
// declares (applicability, status, fraction) so we can produce realistic mixes.
function seedSoA(wsId, profile) {
  const controls = db.prepare(`SELECT id, category FROM iso_items WHERE type='control' ORDER BY sort_order`).all();
  const ins = db.prepare(`INSERT OR REPLACE INTO control_states
    (workspace_id, iso_item_id, applicability, status,
     inclusion_justification, exclusion_justification, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
  db.transaction(() => {
    let i = 0;
    for (const c of controls) {
      const cat = c.category || 'org';
      const p = profile[cat] || profile._default;
      // Cycle through the slots so the mix is deterministic per category.
      const slot = p.slots[i % p.slots.length];
      i++;
      ins.run(
        wsId, c.id,
        slot.applicability,
        slot.status,
        slot.applicability === 'included' ? p.inclusionJust : null,
        slot.applicability === 'excluded' ? p.exclusionJust : null
      );
    }
  })();
}

// -------- documents --------
// Adopts the N mandatory templates. We use direct inserts (no HTTP round-trip)
// and replicate the auto-link behaviour from server.js#adoptTemplateForWorkspace.
function seedDocuments(wsId, workspace, tierFilter, namesIncluded) {
  let query = `SELECT * FROM doc_templates WHERE is_system=1`;
  const params = [];
  if (tierFilter) { query += ` AND tier=?`; params.push(tierFilter); }
  if (namesIncluded && namesIncluded.length) {
    query += ` AND name IN (${namesIncluded.map(() => '?').join(',')})`;
    namesIncluded.forEach(n => params.push(n));
  }
  const templates = db.prepare(query).all(...params);

  const insDoc = db.prepare(`INSERT INTO generated_docs
    (workspace_id, template_id, name, category, content, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insVer = db.prepare(`INSERT INTO doc_versions
    (document_id, workspace_id, version, name, status, content, content_hash, created_by, change_summary)
    VALUES (?, ?, 1, ?, 'approved', ?, ?, ?, 'Seeded from template')`);
  const insLink = db.prepare(`INSERT OR IGNORE INTO document_controls (document_id, iso_item_id) VALUES (?, ?)`);
  const isoExists = db.prepare(`SELECT 1 FROM iso_items WHERE id = ?`);
  let total = 0, linked = 0;

  db.transaction(() => {
    for (const t of templates) {
      const subbed = (t.content || '')
        .replace(/{{client_name}}/g, workspace.client_name)
        .replace(/{{scope}}/g, workspace.scope || (workspace.client_name + ' information assets'))
        .replace(/{{date}}/g, new Date().toISOString().slice(0, 10))
        .replace(/{{firm_name}}/g, 'My firm')
        .replace(/{{document_owner}}/g, 'CISO')
        .replace(/{{approval_authority}}/g, 'Top Management')
        .replace(/{{review_period}}/g, 'Annual')
        .replace(/{{industry}}/g, workspace.industry || '');
      const docId = insDoc.run(wsId, t.id, t.name, t.category, subbed, 'approved', USER_ID).lastInsertRowid;
      insVer.run(docId, wsId, t.name, subbed, randomSha(), USER_ID);
      // Auto-link controls + clauses from the template's seeded refs.
      const controlRefs = JSON.parse(t.controls || '[]');
      const clauseRefs = JSON.parse(t.clauses || '[]');
      for (const ref of [...controlRefs, ...clauseRefs]) {
        if (isoExists.get(ref)) {
          const r = insLink.run(docId, ref);
          if (r.changes) linked++;
        }
      }
      total++;
    }
  })();
  return { adopted: total, linked };
}

// -------- evidence (DB rows only, no real files) --------
function seedEvidence(wsId, evidence) {
  const ins = db.prepare(`INSERT INTO evidence
    (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes,
     uploaded_by, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const link = db.prepare(`INSERT OR IGNORE INTO evidence_controls (evidence_id, iso_item_id) VALUES (?, ?)`);
  db.transaction(() => {
    for (const e of evidence) {
      const id = ins.run(wsId, e.iso_item_id || null, e.filename,
        `seed/${e.filename}`, randomSha(), e.size_bytes, USER_ID, e.description).lastInsertRowid;
      if (e.iso_item_id) link.run(id, e.iso_item_id);
    }
  })();
}

// -------- internal audits + findings --------
function seedAudits(wsId, audits) {
  const insAudit = db.prepare(`INSERT INTO audits
    (workspace_id, title, scope, audit_date, auditor_name, status, summary, created_by, lifecycle_stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insFinding = db.prepare(`INSERT INTO audit_findings
    (audit_id, iso_item_id, finding_type, description, severity, status)
    VALUES (?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const a of audits) {
      const auditId = insAudit.run(wsId, a.title, a.scope, a.audit_date,
        a.auditor_name, a.status, a.summary, USER_ID, a.lifecycle_stage || a.status).lastInsertRowid;
      for (const f of (a.findings || [])) {
        insFinding.run(auditId, f.iso_item_id || null, f.finding_type, f.description, f.severity, f.status);
      }
    }
  })();
}

// -------- nonconformities --------
function seedNCs(wsId, ncs) {
  const ins = db.prepare(`INSERT INTO nonconformities
    (workspace_id, title, source, source_ref, description, severity, iso_item_id,
     root_cause, corrective_action, responsible, due_date, status, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const n of ncs) {
      ins.run(wsId, n.title, n.source, n.source_ref, n.description, n.severity,
        n.iso_item_id || null, n.root_cause, n.corrective_action, n.responsible,
        n.due_date, n.status, n.closed_at || null);
    }
  })();
}

// -------- MRMs --------
function seedMRMs(wsId, mrms) {
  const ins = db.prepare(`INSERT INTO mrms
    (workspace_id, meeting_date, attendees, status,
     prior_actions_status, context_changes, performance_review,
     feedback_interested_parties, risk_treatment_status, improvement_opportunities,
     decisions, action_items, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const m of mrms) {
      ins.run(wsId, m.meeting_date, m.attendees, m.status,
        m.prior_actions_status, m.context_changes, m.performance_review,
        m.feedback_interested_parties, m.risk_treatment_status, m.improvement_opportunities,
        m.decisions, m.action_items, USER_ID);
    }
  })();
}

// -------- improvements --------
function seedImprovements(wsId, items) {
  const ins = db.prepare(`INSERT INTO improvements
    (workspace_id, title, description, source, source_ref, owner_name, due_date,
     status, closed_at, impact_notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const i of items) {
      ins.run(wsId, i.title, i.description, i.source, i.source_ref, i.owner_name,
        i.due_date, i.status, i.closed_at || null, i.impact_notes, USER_ID);
    }
  })();
}

// -------- interested parties --------
function seedParties(wsId, parties) {
  const ins = db.prepare(`INSERT INTO interested_parties
    (workspace_id, party, party_type, needs, how_addressed, owner,
     review_cadence, last_reviewed, next_review, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const p of parties) {
      ins.run(wsId, p.party, p.party_type, p.needs, p.how_addressed, p.owner,
        p.review_cadence, p.last_reviewed, p.next_review, p.notes);
    }
  })();
}

// -------- security objectives --------
function seedObjectives(wsId, objs) {
  const ins = db.prepare(`INSERT INTO security_objectives
    (workspace_id, title, description, measurement, target_value, current_value,
     owner, due_date, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const o of objs) {
      ins.run(wsId, o.title, o.description, o.measurement, o.target_value,
        o.current_value, o.owner, o.due_date, o.status, o.notes);
    }
  })();
}

// -------- SoA snapshot --------
function captureSnapshot(wsId, label, reason) {
  const rows = db.prepare(`SELECT i.id, i.title, i.category,
        COALESCE(cs.applicability,'undecided') AS applicability,
        COALESCE(cs.status,'Not Assessed') AS status,
        cs.inclusion_justification, cs.exclusion_justification
      FROM iso_items i
      LEFT JOIN control_states cs ON cs.iso_item_id = i.id AND cs.workspace_id = ?
      WHERE i.type='control'
      ORDER BY i.sort_order`).all(wsId);
  const crypto = require('crypto');
  const payload = JSON.stringify(rows);
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const counts = {
    total: rows.length,
    included: rows.filter(r => r.applicability === 'included').length,
    excluded: rows.filter(r => r.applicability === 'excluded').length
  };
  db.prepare(`INSERT INTO soa_snapshots
    (workspace_id, label, reason, payload, payload_hash,
     control_count, included_count, excluded_count, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(wsId, label, reason, payload, hash,
         counts.total, counts.included, counts.excluded, USER_ID);
}

// ============================================================
// CLIENT A · Northwind Financial Services
// ============================================================
function seedNorthwind() {
  const NAME = 'Northwind Financial Services';
  console.log(`\n→ ${NAME}`);
  wipeClient(NAME);
  const wsId = createWorkspace({
    client_name: NAME,
    industry: 'Financial services',
    scope: 'UK and EU customer-facing fintech operations, including the consumer banking platform, payment processing, customer support, and the supporting AWS production environment. Excludes the standalone marketing website and the corporate intranet.',
    target_cert_date: offsetDate(180),
    stage: 'implementation',
    brand_display_name: 'Northwind FS',
    brand_primary_color: '#1B3A57',
    sector: 'financial',
    frameworks: ['iso27001']
  });
  console.log(`  workspace #${wsId} created`);

  const ws = db.prepare(`SELECT * FROM workspaces WHERE id=?`).get(wsId);

  // Assets
  const assets = [
    { name: 'Customer banking platform', type: 'information', classification: 'restricted', owner_name: 'CTO', cia_c: 3, cia_i: 3, cia_a: 3, description: 'Customer-facing fintech application: accounts, payments, statements.', business_criticality: 'critical', rto_hours: 2, rpo_hours: 1, bia_notes: 'Loss of service results in immediate regulatory + revenue impact.' },
    { name: 'Customer KYC database',     type: 'information', classification: 'restricted', owner_name: 'CISO', cia_c: 3, cia_i: 3, cia_a: 2, description: 'Identity verification records, encrypted at rest.', business_criticality: 'critical', rto_hours: 4, rpo_hours: 1, bia_notes: 'Required for AML compliance.' },
    { name: 'Payment processing service', type: 'service', classification: 'restricted', owner_name: 'Head of Payments', cia_c: 3, cia_i: 3, cia_a: 3, description: 'PSP integration handling card-not-present transactions.', business_criticality: 'critical', rto_hours: 1, rpo_hours: 0, bia_notes: 'PSD2 and PCI-DSS in scope.' },
    { name: 'AWS production environment', type: 'service', classification: 'confidential', owner_name: 'Head of Platform', cia_c: 3, cia_i: 3, cia_a: 3, description: 'Production VPCs, RDS, S3, EKS.', business_criticality: 'critical', rto_hours: 4, rpo_hours: 1, bia_notes: 'Single AWS region today; multi-region DR planned.' },
    { name: 'Office 365 tenant',          type: 'service', classification: 'confidential', owner_name: 'IT Manager', cia_c: 3, cia_i: 2, cia_a: 2, description: 'Email, Teams, OneDrive for ~120 staff.', business_criticality: 'high', rto_hours: 8, rpo_hours: 4, bia_notes: 'MFA enforced; conditional access policies in place.' },
    { name: 'Active Directory (Entra ID)', type: 'service', classification: 'confidential', owner_name: 'IT Manager', cia_c: 3, cia_i: 3, cia_a: 3, description: 'Identity backbone for all SaaS.', business_criticality: 'critical', rto_hours: 4, rpo_hours: 1, bia_notes: 'Privileged access workstations + JIT activation.' },
    { name: 'HR records (BambooHR)',      type: 'information', classification: 'confidential', owner_name: 'Head of HR', cia_c: 3, cia_i: 2, cia_a: 1, description: 'Employee personal data + contracts.', business_criticality: 'medium', rto_hours: 24, rpo_hours: 24, bia_notes: '' },
    { name: 'Customer support CRM',       type: 'information', classification: 'confidential', owner_name: 'Head of CX', cia_c: 2, cia_i: 2, cia_a: 2, description: 'Zendesk; ticket history holds customer PII.', business_criticality: 'high', rto_hours: 8, rpo_hours: 4, bia_notes: '' },
    { name: 'Source code repository (GitHub)', type: 'service', classification: 'confidential', owner_name: 'CTO', cia_c: 3, cia_i: 3, cia_a: 2, description: 'Organisation account with branch protection + signed commits.', business_criticality: 'high', rto_hours: 8, rpo_hours: 1, bia_notes: 'IP risk if leaked.' },
    { name: 'Backup storage (S3 + Glacier)', type: 'service', classification: 'confidential', owner_name: 'Head of Platform', cia_c: 3, cia_i: 3, cia_a: 2, description: 'Cross-region S3 with object lock; daily snapshots.', business_criticality: 'high', rto_hours: 12, rpo_hours: 1, bia_notes: '' },
    { name: 'VPN gateway',                type: 'service', classification: 'confidential', owner_name: 'IT Manager', cia_c: 2, cia_i: 3, cia_a: 2, description: 'Tailscale + identity-aware proxy for admin access.', business_criticality: 'medium', rto_hours: 4, rpo_hours: 0, bia_notes: '' },
    { name: 'Endpoint laptops',           type: 'hardware', classification: 'confidential', owner_name: 'IT Manager', cia_c: 2, cia_i: 2, cia_a: 1, description: 'MacBook + Windows fleet, FileVault/BitLocker enforced.', business_criticality: 'medium', rto_hours: 24, rpo_hours: 0, bia_notes: '' },
    { name: 'Mobile devices (BYOD)',      type: 'hardware', classification: 'internal',     owner_name: 'IT Manager', cia_c: 1, cia_i: 1, cia_a: 1, description: 'Personal phones with corporate mail container only.', business_criticality: 'low', rto_hours: 0, rpo_hours: 0, bia_notes: '' },
    { name: 'Office Wi-Fi',               type: 'service', classification: 'internal',     owner_name: 'IT Manager', cia_c: 1, cia_i: 1, cia_a: 1, description: 'Corporate + guest SSIDs; WPA3, certificate-based auth.', business_criticality: 'low', rto_hours: 8, rpo_hours: 0, bia_notes: '' },
    { name: 'Legal & contracts library',  type: 'information', classification: 'confidential', owner_name: 'Head of Legal', cia_c: 2, cia_i: 3, cia_a: 1, description: 'NDAs, supplier contracts, DPAs.', business_criticality: 'medium', rto_hours: 24, rpo_hours: 24, bia_notes: '' }
  ];
  const assetIdByName = seedAssets(wsId, assets);
  console.log(`  ${assets.length} assets`);

  // Risks
  const risks = [
    { title: 'Customer PII exfiltrated via stolen SSO credentials', description: 'Attacker obtains a valid Entra ID session and downloads customer KYC records.', asset: 'Customer KYC database', threat: 'Credential theft (phishing, infostealer malware)', vulnerability: 'No phishing-resistant MFA on customer-data admin paths', likelihood: 3, impact: 5, treatment: 'modify', owner_name: 'CISO', status: 'open', residual_likelihood: 2, residual_impact: 4 },
    { title: 'Ransomware encrypts production data',                description: 'Threat actor reaches production EKS via compromised CI runner.', asset: 'AWS production environment', threat: 'Ransomware-as-a-service group', vulnerability: 'Long-lived IAM roles + over-permissioned CI', likelihood: 2, impact: 5, treatment: 'modify', owner_name: 'Head of Platform', status: 'open', residual_likelihood: 1, residual_impact: 4 },
    { title: 'BEC fraud via spoofed CFO email',                    description: 'Finance approves a fraudulent wire on the basis of a spoofed instruction.', asset: 'Office 365 tenant', threat: 'Business email compromise', vulnerability: 'No out-of-band payment verification policy', likelihood: 4, impact: 4, treatment: 'modify', owner_name: 'CFO', status: 'treated', residual_likelihood: 2, residual_impact: 3 },
    { title: 'Cloud misconfiguration exposes S3 bucket',           description: 'Public-read on a backup bucket leaks customer statements.', asset: 'Backup storage (S3 + Glacier)', threat: 'Internet-facing data theft', vulnerability: 'Manual S3 policy with no AWS Config rule', likelihood: 3, impact: 4, treatment: 'modify', owner_name: 'Head of Platform', status: 'open', residual_likelihood: 2, residual_impact: 3 },
    { title: 'Insider threat: engineer exfiltrates source code',  description: 'Departing engineer downloads the monorepo before leaving.', asset: 'Source code repository (GitHub)', threat: 'Malicious insider', vulnerability: 'No DLP on git clone events', likelihood: 2, impact: 4, treatment: 'modify', owner_name: 'CTO', status: 'open', residual_likelihood: 2, residual_impact: 3 },
    { title: 'Supply-chain compromise via npm dependency',         description: 'Compromised package pushes credential-stealer into build.', asset: 'Source code repository (GitHub)', threat: 'Supply-chain attack', vulnerability: 'No deps lockfile review; auto-merging dependabot', likelihood: 3, impact: 4, treatment: 'modify', owner_name: 'CTO', status: 'open', residual_likelihood: 2, residual_impact: 3 },
    { title: 'DDoS knocks customer banking platform offline',      description: 'L7 flood against the API gateway saturates origin.', asset: 'Customer banking platform', threat: 'Hacktivist / extortion DDoS', vulnerability: 'CDN-side WAF without rate-limit profiles tuned for our endpoints', likelihood: 3, impact: 4, treatment: 'modify', owner_name: 'Head of Platform', status: 'treated', residual_likelihood: 2, residual_impact: 2 },
    { title: 'GDPR / FCA regulatory non-compliance',               description: 'Material breach triggers ICO investigation + FCA finding.', asset: 'Customer KYC database', threat: 'Regulatory action', vulnerability: 'No formal records-of-processing review since acquisition', likelihood: 3, impact: 5, treatment: 'modify', owner_name: 'Head of Legal', status: 'open', residual_likelihood: 2, residual_impact: 4 },
    { title: 'Lost / stolen laptop with cached customer data',     description: 'A field laptop is stolen at an airport with offline customer records.', asset: 'Endpoint laptops', threat: 'Opportunistic theft', vulnerability: 'No remote wipe SLA; some legacy devices unmanaged', likelihood: 3, impact: 3, treatment: 'modify', owner_name: 'IT Manager', status: 'treated', residual_likelihood: 2, residual_impact: 2 },
    { title: 'Unpatched CVE exposes a public-facing service',      description: 'High-severity CVE remains unpatched past SLA, exploited in the wild.', asset: 'AWS production environment', threat: 'Mass-scanning exploitation', vulnerability: 'Patch SLAs documented but not enforced', likelihood: 4, impact: 4, treatment: 'modify', owner_name: 'Head of Platform', status: 'open', residual_likelihood: 2, residual_impact: 3 },
    { title: 'AWS account takeover via root credential leak',      description: 'Root creds checked into a private repo, scraped.', asset: 'AWS production environment', threat: 'Root account compromise', vulnerability: 'No automated secret scanning on private repos', likelihood: 2, impact: 5, treatment: 'modify', owner_name: 'Head of Platform', status: 'closed', residual_likelihood: 1, residual_impact: 3 },
    { title: 'Vendor breach (PSP) exposes payment metadata',       description: 'Payment provider notifies us of an incident affecting transaction-data.', asset: 'Payment processing service', threat: 'Third-party data breach', vulnerability: 'Insufficient contractual breach-notification timelines', likelihood: 2, impact: 4, treatment: 'share', owner_name: 'Head of Payments', status: 'open', residual_likelihood: 2, residual_impact: 3 }
  ];
  seedRisks(wsId, risks, assetIdByName);
  console.log(`  ${risks.length} risks`);

  // SoA: mature workspace. Most included + implemented; a few in progress
  // + a small number of in-scope exclusions for the org categories that
  // touch development (no in-house custom hardware, for example).
  seedSoA(wsId, {
    org: {
      inclusionJust: 'In scope: applies to the ISMS as governance.',
      exclusionJust: '',
      slots: [
        { applicability: 'included', status: 'Implemented' },
        { applicability: 'included', status: 'Implemented' },
        { applicability: 'included', status: 'Partially Implemented' },
        { applicability: 'included', status: 'Implemented' },
      ]
    },
    people: {
      inclusionJust: 'All personnel are in scope of the ISMS.',
      exclusionJust: '',
      slots: [
        { applicability: 'included', status: 'Implemented' },
        { applicability: 'included', status: 'Partially Implemented' },
      ]
    },
    physical: {
      inclusionJust: 'Applies to the London HQ and the AWS regional facilities used via shared-responsibility.',
      exclusionJust: 'Northwind operates from a single leased office; landlord controls building perimeter.',
      slots: [
        { applicability: 'included', status: 'Implemented' },
        { applicability: 'included', status: 'Implemented' },
        { applicability: 'included', status: 'Partially Implemented' },
        { applicability: 'excluded', status: 'Not Applicable' },
      ]
    },
    tech: {
      inclusionJust: 'Production systems within the ISMS scope rely on these technical controls.',
      exclusionJust: 'No applicable services for this control in the current environment.',
      slots: [
        { applicability: 'included', status: 'Implemented' },
        { applicability: 'included', status: 'Implemented' },
        { applicability: 'included', status: 'Partially Implemented' },
        { applicability: 'included', status: 'Implemented' },
        { applicability: 'included', status: 'Partially Implemented' },
      ]
    },
    _default: {
      inclusionJust: 'In scope of the ISMS.',
      exclusionJust: '',
      slots: [{ applicability: 'included', status: 'Implemented' }]
    }
  });
  console.log(`  SoA decisions: 93 controls (most included)`);

  // Mandatory documents adopted
  const docs = seedDocuments(wsId, ws, 'mandatory');
  // Plus a few common expected
  const expectedNames = ['Access Control Policy', 'Acceptable Use Policy', 'Cryptography Policy', 'Information Backup Policy', 'Supplier Information Security Policy'];
  const extra = seedDocuments(wsId, ws, null, expectedNames);
  console.log(`  documents adopted: ${docs.adopted + extra.adopted}, controls auto-linked: ${docs.linked + extra.linked}`);

  // Evidence: DB rows referencing fake files (audit-pack PDF won't try to
  // download these; only the auditor portal would, and that's by-token).
  const evidence = [
    { iso_item_id: 'annex-a.5.1',  filename: 'ISMS-Policy-v2.1-signed.pdf',        size_bytes: 245678, description: 'Top-management-signed ISMS policy (Clause 5.2 deliverable).' },
    { iso_item_id: 'annex-a.5.15', filename: 'Access-control-policy-v1.3.pdf',     size_bytes: 187543, description: 'Approved access control policy + procedure.' },
    { iso_item_id: 'annex-a.5.18', filename: 'JML-process-quarterly-review.xlsx',  size_bytes: 56234,  description: 'Q1 2026 joiner/mover/leaver review evidence: 14 leavers, 100% access revoked within SLA.' },
    { iso_item_id: 'annex-a.5.24', filename: 'Incident-response-runbook-v2.docx',  size_bytes: 312890, description: 'Step-by-step IR runbook; last tabletop exercise 2026-03-15.' },
    { iso_item_id: 'annex-a.5.25', filename: 'Incident-log-2026-Q1.csv',            size_bytes: 8923,   description: 'All security events recorded in Q1: 3 minor incidents, all resolved within SLA.' },
    { iso_item_id: 'annex-a.6.3',  filename: 'Awareness-training-completions-Q1.pdf', size_bytes: 76432, description: '98% completion rate for mandatory security awareness module.' },
    { iso_item_id: 'annex-a.8.5',  filename: 'MFA-enrolment-evidence.png',          size_bytes: 145678, description: 'Entra ID conditional-access policy enforcing phishing-resistant MFA on admin paths.' },
    { iso_item_id: 'annex-a.8.13', filename: 'Backup-restore-test-2026-04-02.pdf',  size_bytes: 234567, description: 'Successful restore test of production RDS snapshot to staging; RTO met (3h12m).' },
    { iso_item_id: 'annex-a.8.15', filename: 'CloudTrail-retention-config.json',    size_bytes: 4567,   description: 'AWS CloudTrail with org-wide trail + 7-year retention on S3 with object lock.' },
    { iso_item_id: 'annex-a.8.23', filename: 'Web-filtering-evidence.pdf',          size_bytes: 98765,  description: 'Cisco Umbrella categories blocked + monthly review minutes.' },
    { iso_item_id: 'annex-a.5.19', filename: 'Supplier-register-2026-Q1.xlsx',      size_bytes: 132456, description: 'Active suppliers with tier classification, DPAs, and last review date.' },
    { iso_item_id: 'clause-9.2',   filename: 'Internal-audit-programme-2026.pdf',   size_bytes: 156789, description: '3-year internal audit programme approved by top management.' }
  ];
  seedEvidence(wsId, evidence);
  console.log(`  ${evidence.length} evidence entries`);

  // Internal audit + findings
  seedAudits(wsId, [
    {
      title: 'Internal audit: Q1 2026 (Pre-Stage-1)',
      scope: 'Full ISMS: all clauses + Annex A controls applicable per the SoA. Sample-based testing of access, change management, supplier, backup, and incident processes.',
      audit_date: offsetDate(-60),
      auditor_name: 'Sarah Mitchell, ISO 27001 LA (independent)',
      status: 'reported',
      lifecycle_stage: 'reported',
      summary: 'ISMS is broadly operating effectively. Five findings raised: one minor NC on supplier review cadence, two observations on patch SLA adherence, two opportunities for improvement on KPI dashboarding and tabletop frequency.',
      findings: [
        { iso_item_id: 'annex-a.5.19', finding_type: 'minor_nc', severity: 'minor', status: 'open', description: '3 of 8 tier-2 suppliers had no recorded annual review in the last 12 months. Procedure A.5.19 calls for annual review; sample showed inconsistent execution.' },
        { iso_item_id: 'annex-a.8.8',  finding_type: 'observation', severity: 'medium', status: 'open', description: 'Patch SLA of 14 days for High-severity CVEs documented but exceeded for 4 of 12 sampled patches in Q4 2025.' },
        { iso_item_id: 'annex-a.5.24', finding_type: 'opportunity', severity: 'medium', status: 'open', description: 'Incident-response tabletop exercises run annually; recommend quarterly with rotating scenarios to mature crisis comms.' },
        { iso_item_id: 'clause-9.1',   finding_type: 'opportunity', severity: 'medium', status: 'open', description: 'Monitoring metrics captured per system but not aggregated into an ISMS KPI dashboard for management review. Consider a single source-of-truth view.' },
        { iso_item_id: 'annex-a.8.16', finding_type: 'conformance', severity: 'low', status: 'closed', description: 'Monitoring controls observed operating as designed; sample of 5 alert investigations all had complete records.' }
      ]
    }
  ]);
  console.log(`  1 internal audit with 5 findings`);

  // NCs
  seedNCs(wsId, [
    { title: 'Supplier reviews overdue for 3 tier-2 suppliers', source: 'internal_audit', source_ref: 'IA-2026-Q1-F1', description: 'Annual supplier security reviews are documented in procedure A.5.19 but were not consistently executed.', severity: 'minor', iso_item_id: 'annex-a.5.19', root_cause: 'No automated reminder; reviews tracked manually in a spreadsheet that the supplier owner did not update.', corrective_action: 'Move supplier-review tracking into the workspace tasks module with auto-spawned annual review tasks. Owner: Head of Procurement. Pilot complete; full rollout by month-end.', responsible: 'Head of Procurement', due_date: offsetDate(30), status: 'open' },
    { title: 'Patch SLA exceeded for 4 of 12 sampled patches', source: 'internal_audit', source_ref: 'IA-2026-Q1-F2', description: 'High-severity patches must be applied within 14 days; sample showed 4 patches between 16 and 22 days.', severity: 'minor', iso_item_id: 'annex-a.8.8', root_cause: 'Patch window contention with deployment freezes during high-traffic periods.', corrective_action: 'Define patch-window exceptions in change management process. Hot-patch path for criticals.', responsible: 'Head of Platform', due_date: offsetDate(45), status: 'open' },
    { title: 'Encryption key rotation policy not formally documented', source: 'monitoring', source_ref: '', description: 'Key rotation happens in practice (90-day for KMS keys) but is not codified in a policy.', severity: 'minor', iso_item_id: 'annex-a.8.24', root_cause: 'Documentation lag; technical process was implemented before policy.', corrective_action: 'Cryptography Policy v1.4 drafted; under review. Target approval next CAB.', responsible: 'CISO', due_date: offsetDate(20), status: 'open' },
    { title: 'BYOD policy outdated', source: 'mrm', source_ref: 'MRM-2025-Q4', description: 'BYOD policy v1.0 dated 2023; no longer reflects the corporate-mail-container approach now in place.', severity: 'minor', iso_item_id: 'annex-a.6.7', root_cause: 'Policy review cadence skipped during 2024 leadership transition.', corrective_action: 'Updated BYOD Policy v2.0 issued and re-acknowledged by all staff.', responsible: 'CISO', due_date: offsetDate(-30), status: 'closed', closed_at: offsetDate(-15) },
    { title: 'Visitor sign-in records missing for 3 visits in Q1', source: 'internal_audit', source_ref: 'IA-2025-Q4-F3', description: 'Three visitor entries to the London office in March 2026 missing in the visitor log.', severity: 'minor', iso_item_id: 'annex-a.7.2', root_cause: 'Receptionist on annual leave; cover staff did not consistently use the log.', corrective_action: 'Digital sign-in tablet installed at reception with mandatory fields. All visits now captured automatically.', responsible: 'Office Manager', due_date: offsetDate(-45), status: 'closed', closed_at: offsetDate(-30) },
    { title: 'Asset inventory missing 2 MacBooks from the leavers process', source: 'monitoring', source_ref: '', description: 'Two MacBooks from October leavers not formally signed off in the asset register; physically recovered but record-keeping incomplete.', severity: 'minor', iso_item_id: 'annex-a.5.9',  root_cause: 'Manual asset-register update step missed during leaver handover.', corrective_action: 'Leaver workflow updated to require asset-register tick-off before final ticket close.', responsible: 'IT Manager', due_date: offsetDate(-15), status: 'closed', closed_at: offsetDate(-5) }
  ]);
  console.log(`  6 NCs (3 open, 3 closed)`);

  // MRMs
  seedMRMs(wsId, [
    {
      meeting_date: offsetDate(-90), attendees: 'CEO, CFO, CTO, CISO, COO, Head of Legal', status: 'complete',
      prior_actions_status: 'All prior MRM actions complete or on track.',
      context_changes: 'Q4 2025: closed Series B funding round, opened Berlin office, expanded into 3 new EU markets. Regulatory landscape: DORA in force 2025-01; PSD3 consultation ongoing.',
      performance_review: 'Internal audit programme: 2 audits run in last 12 months, 7 findings raised, 4 closed. Open NCs: 3, none major. Risk treatment: 8 actions open, 5 closed. Incidents: 3 minor, all resolved within SLA.',
      feedback_interested_parties: 'No customer-reported security concerns this period. FCA prudential review completed satisfactorily.',
      risk_treatment_status: 'Top risks: PII exfiltration, ransomware, BEC. All being treated. Residual risks tolerable within appetite. New supply-chain risk added this quarter.',
      improvement_opportunities: 'Consolidate evidence library, mature SOC analyst rotation, formalise crisis comms playbook.',
      decisions: '(1) Approve revised information security objectives for 2026. (2) Authorise additional headcount for SOC analyst. (3) Confirm Stage 1 audit booking with BSI for Q3 2026.',
      action_items: '(1) CISO: draft Crisis Comms Plan by end of next month. (2) Head of Platform: third-party SOC RFP shortlist by mid-quarter. (3) CFO: budget approval for SOC analyst by next finance committee.'
    },
    {
      meeting_date: offsetDate(-15), attendees: 'CEO, CTO, CISO, COO, Head of Legal', status: 'complete',
      prior_actions_status: 'Crisis Comms Plan v1.0 drafted; SOC analyst hired and onboarded; Stage 1 audit confirmed for 2026-09-15.',
      context_changes: 'Q1 2026: signed 2 enterprise customers requiring SOC 2 Type II in addition to ISO 27001. Initial scoping done; gap analysis in progress.',
      performance_review: 'Internal audit Q1 completed with 5 findings. Patch SLA breaches identified; corrective action in progress. NC closure rate trending positively.',
      feedback_interested_parties: 'Two enterprise customers requested DPAs with custom breach-notification timelines.',
      risk_treatment_status: 'New risk added this quarter: vendor breach exposing payment metadata (treated via stronger contractual clauses).',
      improvement_opportunities: 'Aggregate ISMS KPIs into a dashboard; raise tabletop frequency to quarterly.',
      decisions: '(1) Adopt the ISMS KPI dashboard recommendation from internal audit. (2) Move to quarterly tabletops starting Q2.',
      action_items: '(1) CISO: define KPI list + dashboard mock-up for review next MRM. (2) CTO: pick tabletop scenario for Q2: production ransomware. (3) Head of Legal: review breach-notification clauses across top-10 suppliers.'
    }
  ]);
  console.log(`  2 MRMs held`);

  // Improvements
  seedImprovements(wsId, [
    { title: 'Build ISMS KPI dashboard',                description: 'Aggregate monitoring KPIs into a single dashboard for management review.', source: 'internal_audit', source_ref: 'IA-2026-Q1-F4', owner_name: 'CISO', due_date: offsetDate(60), status: 'in_progress', impact_notes: 'Improves Clause 9.1 + 9.3 cadence.' },
    { title: 'Move to quarterly tabletop exercises',    description: 'Run quarterly IR tabletop with rotating scenarios: ransomware, BEC, data-leak, third-party.', source: 'internal_audit', source_ref: 'IA-2026-Q1-F3', owner_name: 'CTO', due_date: offsetDate(80), status: 'open', impact_notes: 'Matures crisis comms readiness.' },
    { title: 'Secret-scanning on all repos',            description: 'Enable GitHub Advanced Security secret scanning across all org repos + push-protection.', source: 'monitoring', source_ref: '', owner_name: 'Head of Platform', due_date: offsetDate(-30), status: 'done', closed_at: offsetDate(-10), impact_notes: 'Addresses recurring CVE-class risk.' },
    { title: 'Migrate evidence collection to workspace tool', description: 'Move from SharePoint to the ISO 27001 workspace as single source-of-truth for evidence.', source: 'mrm', source_ref: 'MRM-2025-Q4', owner_name: 'CISO', due_date: offsetDate(-60), status: 'done', closed_at: offsetDate(-30), impact_notes: 'Reduced audit-prep time by ~70%.' }
  ]);
  console.log(`  4 improvements (2 open, 2 done)`);

  // Interested parties
  seedParties(wsId, [
    { party: 'Customers (consumer banking)', party_type: 'customer',  needs: 'Confidentiality of account + KYC data, availability of the banking app.',          how_addressed: 'Encryption at rest + in transit; 99.95% availability SLO; transparent breach notification policy.', owner: 'Head of Legal', review_cadence: 'annual',     last_reviewed: offsetDate(-180), next_review: offsetDate(180), notes: '' },
    { party: 'FCA (regulator)',              party_type: 'regulator', needs: 'Compliance with operational resilience + GDPR + AML.',                              how_addressed: 'Quarterly compliance review with internal legal; annual prudential return.',                    owner: 'Head of Legal', review_cadence: 'quarterly',  last_reviewed: offsetDate(-30),  next_review: offsetDate(60),  notes: 'DORA compliance review ongoing.' },
    { party: 'ICO',                          party_type: 'regulator', needs: 'GDPR compliance + breach notification within 72h.',                                 how_addressed: 'Records-of-processing register; DPO appointed; documented breach process.',                      owner: 'DPO',           review_cadence: 'annual',     last_reviewed: offsetDate(-100), next_review: offsetDate(260), notes: '' },
    { party: 'Investors (Series B board)',   party_type: 'investor',  needs: 'Demonstrable cyber-risk management as part of due diligence.',                       how_addressed: 'Quarterly security update at board; annual SOC 2 readiness + ISO 27001 cert.',                  owner: 'CEO',           review_cadence: 'quarterly',  last_reviewed: offsetDate(-45),  next_review: offsetDate(45),  notes: '' },
    { party: 'Enterprise customers',         party_type: 'customer',  needs: 'SOC 2 Type II + ISO 27001 cert; custom DPAs; secure SDLC evidence.',                 how_addressed: 'Trust page + audit pack + signed DPA template; security questionnaire response within 5 business days.', owner: 'Head of CX',   review_cadence: 'biannual',   last_reviewed: offsetDate(-90),  next_review: offsetDate(90),  notes: '' },
    { party: 'Employees',                    party_type: 'internal',  needs: 'Privacy of HR + payroll data; clear acceptable-use guidance.',                        how_addressed: 'BambooHR with role-based access; AUP signed at onboarding + refresher annually.',                 owner: 'Head of HR',    review_cadence: 'annual',     last_reviewed: offsetDate(-150), next_review: offsetDate(210), notes: '' }
  ]);
  console.log(`  6 interested parties`);

  // Objectives
  seedObjectives(wsId, [
    { title: 'Reduce mean-time-to-patch high-severity CVEs',     description: 'High-severity CVEs patched within 14 days of public disclosure.', measurement: 'Median days from CVE publication to patch deployment', target_value: '14', current_value: '18', owner: 'Head of Platform', due_date: offsetDate(120), status: 'in_progress', notes: 'Q1 sample showed 18d median; tracking towards target.' },
    { title: 'Achieve 100% mandatory security training completion', description: 'All staff complete annual security awareness training.', measurement: '% of active staff with current training', target_value: '100', current_value: '98', owner: 'Head of HR', due_date: offsetDate(30), status: 'on_track', notes: 'Two outstanding employees on extended leave.' },
    { title: 'Achieve ISO 27001 certification',                  description: 'Successfully pass Stage 1 and Stage 2 audits to obtain certification.', measurement: 'Stage 2 audit outcome', target_value: 'Certified', current_value: 'Pre-Stage-1', owner: 'CISO', due_date: offsetDate(240), status: 'on_track', notes: 'Stage 1 booked for 2026-09-15.' },
    { title: 'Reduce open major NCs to 0',                       description: 'All major NCs closed within SLA.', measurement: 'Count of open major NCs', target_value: '0', current_value: '0', owner: 'CISO', due_date: offsetDate(60), status: 'on_track', notes: '' },
    { title: 'Move to quarterly IR tabletop cadence',            description: 'Run an IR tabletop exercise every quarter.', measurement: 'Tabletops per year', target_value: '4', current_value: '1', owner: 'CTO', due_date: offsetDate(180), status: 'in_progress', notes: 'Q1 tabletop scheduled.' }
  ]);
  console.log(`  5 security objectives`);

  // SoA snapshots: baseline + post-audit
  captureSnapshot(wsId, 'Baseline (initial gap)', 'Captured at the end of Pass 1 gap assessment.');
  captureSnapshot(wsId, 'Pre-internal-audit',    'Captured before Q1 internal audit for diff reference.');
  console.log(`  2 SoA snapshots`);

  return wsId;
}

// ============================================================
// CLIENT B · Helio Software Inc.
// ============================================================
function seedHelio() {
  const NAME = 'Helio Software Inc.';
  console.log(`\n→ ${NAME}`);
  wipeClient(NAME);
  const wsId = createWorkspace({
    client_name: NAME,
    industry: 'Software (SaaS)',
    scope: 'Helio production SaaS platform serving B2B customers, the AWS environment supporting it, and the corporate IT services used by Helio employees. Excludes the marketing website and external contractors not handling Helio customer data.',
    target_cert_date: offsetDate(300),
    stage: 'gap_assessment',
    brand_display_name: 'Helio',
    brand_primary_color: '#1F4D3F',
    sector: 'technology',
    frameworks: ['iso27001']
  });
  console.log(`  workspace #${wsId} created`);
  const ws = db.prepare(`SELECT * FROM workspaces WHERE id=?`).get(wsId);

  const assets = [
    { name: 'Helio production database',  type: 'information', classification: 'restricted', owner_name: 'CTO',         cia_c: 3, cia_i: 3, cia_a: 3, description: 'Multi-tenant Postgres holding customer documents + audit logs.', business_criticality: 'critical', rto_hours: 4, rpo_hours: 1,  bia_notes: '' },
    { name: 'AWS account (production)',   type: 'service',     classification: 'restricted', owner_name: 'CTO',         cia_c: 3, cia_i: 3, cia_a: 3, description: 'Single AWS account; multi-AZ but single-region.',                business_criticality: 'critical', rto_hours: 4, rpo_hours: 1,  bia_notes: '' },
    { name: 'GitHub organisation',        type: 'service',     classification: 'confidential', owner_name: 'CTO',       cia_c: 3, cia_i: 3, cia_a: 2, description: 'All source code; branch protection enabled on main.',          business_criticality: 'high',     rto_hours: 8, rpo_hours: 4,  bia_notes: '' },
    { name: 'Customer data (S3)',         type: 'information', classification: 'restricted', owner_name: 'CTO',         cia_c: 3, cia_i: 3, cia_a: 2, description: 'Customer-uploaded documents, encrypted with per-tenant keys.',  business_criticality: 'critical', rto_hours: 8, rpo_hours: 1,  bia_notes: '' },
    { name: 'Google Workspace',           type: 'service',     classification: 'confidential', owner_name: 'COO',       cia_c: 2, cia_i: 2, cia_a: 2, description: 'Gmail, Drive, Calendar, Meet for ~50 employees.',                business_criticality: 'high',     rto_hours: 8, rpo_hours: 4,  bia_notes: '' },
    { name: 'Slack workspace',            type: 'service',     classification: 'confidential', owner_name: 'COO',       cia_c: 2, cia_i: 1, cia_a: 1, description: 'Primary internal comms.',                                       business_criticality: 'medium',   rto_hours: 24, rpo_hours: 24, bia_notes: '' },
    { name: 'Customer support (Zendesk)', type: 'information', classification: 'confidential', owner_name: 'Head of CX', cia_c: 2, cia_i: 2, cia_a: 2, description: 'Tickets contain customer PII.',                                  business_criticality: 'medium',   rto_hours: 24, rpo_hours: 8,  bia_notes: '' },
    { name: 'CRM (HubSpot)',              type: 'information', classification: 'confidential', owner_name: 'Head of Sales', cia_c: 2, cia_i: 1, cia_a: 1, description: 'Marketing + sales pipeline; prospect data only.',              business_criticality: 'low',      rto_hours: 48, rpo_hours: 48, bia_notes: '' },
    { name: 'Employee laptops',           type: 'hardware',    classification: 'confidential', owner_name: 'COO',       cia_c: 2, cia_i: 2, cia_a: 1, description: 'MDM-enrolled; FileVault enforced.',                              business_criticality: 'medium',   rto_hours: 24, rpo_hours: 0,  bia_notes: '' },
    { name: 'Office Wi-Fi',               type: 'service',     classification: 'internal',     owner_name: 'COO',       cia_c: 1, cia_i: 1, cia_a: 1, description: 'Co-working space; managed network.',                             business_criticality: 'low',      rto_hours: 0, rpo_hours: 0,  bia_notes: '' }
  ];
  const assetIdByName = seedAssets(wsId, assets);
  console.log(`  ${assets.length} assets`);

  const risks = [
    { title: 'Customer data exfiltrated via SaaS application vulnerability', description: 'A bug in the multi-tenant authorization layer allows cross-tenant read.', asset: 'Helio production database', threat: 'Application-layer attacker', vulnerability: 'No formal application security testing programme yet', likelihood: 3, impact: 4, treatment: 'modify', owner_name: 'CTO', status: 'open' },
    { title: 'Account takeover via credential stuffing on customer accounts', description: 'Attacker uses leaked credentials to log into customer accounts.', asset: 'Helio production database', threat: 'Credential stuffing botnet', vulnerability: 'MFA optional for customer accounts',                          likelihood: 4, impact: 4, treatment: 'modify', owner_name: 'CTO', status: 'open' },
    { title: 'AWS misconfiguration exposes customer S3 bucket',              description: 'Public-read bucket policy leaks customer files.', asset: 'Customer data (S3)', threat: 'Misconfiguration', vulnerability: 'No AWS Config rules; no Macie',                                                                          likelihood: 3, impact: 4, treatment: 'modify', owner_name: 'Head of Platform', status: 'open' },
    { title: 'Phishing against engineering staff yields AWS credentials',    description: 'Spear-phish steals an engineer\'s SSO creds.', asset: 'AWS account (production)', threat: 'Targeted phishing', vulnerability: 'No phishing-resistant MFA on AWS console',                                                              likelihood: 3, impact: 4, treatment: 'modify', owner_name: 'CTO', status: 'open' },
    { title: 'Stolen laptop with cached customer data',                       description: 'A founding-team laptop is stolen abroad.', asset: 'Employee laptops', threat: 'Opportunistic theft', vulnerability: 'Some legacy laptops not yet MDM-enrolled',                                                                       likelihood: 3, impact: 3, treatment: 'modify', owner_name: 'COO', status: 'open' },
    { title: 'Third-party SaaS breach exposes Helio customer data',           description: 'A downstream SaaS that processes our data is breached.', asset: 'Customer support (Zendesk)', threat: 'Vendor compromise', vulnerability: 'No formal supplier security review programme',                                       likelihood: 2, impact: 3, treatment: 'share', owner_name: 'COO', status: 'open' },
    { title: 'Insider threat: engineer exfiltrates source code',             description: 'Departing engineer pulls the repo.', asset: 'GitHub organisation', threat: 'Malicious insider', vulnerability: 'No off-boarding revocation SLA',                                                                                  likelihood: 2, impact: 4, treatment: 'modify', owner_name: 'CTO', status: 'open' },
    { title: 'DDoS knocks the SaaS platform offline',                          description: 'Sustained L7 flood saturates customer-facing API.', asset: 'AWS account (production)', threat: 'DDoS', vulnerability: 'No WAF rules tuned for known attack patterns',                                                          likelihood: 3, impact: 3, treatment: 'modify', owner_name: 'CTO', status: 'open' }
  ];
  seedRisks(wsId, risks, assetIdByName);
  console.log(`  ${risks.length} risks`);

  // SoA: early stage. ~70 controls included, many still undecided/in-progress
  // because the gap-assessment hasn't completed every theme.
  seedSoA(wsId, {
    org: {
      inclusionJust: 'In scope of the ISMS.',
      exclusionJust: '',
      slots: [
        { applicability: 'included',  status: 'Partially Implemented' },
        { applicability: 'included',  status: 'Not Implemented' },
        { applicability: 'undecided', status: 'Not Assessed' },
        { applicability: 'included',  status: 'Partially Implemented' }
      ]
    },
    people: {
      inclusionJust: 'All personnel are in scope.',
      exclusionJust: '',
      slots: [
        { applicability: 'included',  status: 'Partially Implemented' },
        { applicability: 'undecided', status: 'Not Assessed' }
      ]
    },
    physical: {
      inclusionJust: 'Co-working space access controls and laptop-handling within scope.',
      exclusionJust: 'Helio is fully remote; landlord controls building perimeter and most physical controls do not apply.',
      slots: [
        { applicability: 'excluded',  status: 'Not Applicable' },
        { applicability: 'excluded',  status: 'Not Applicable' },
        { applicability: 'included',  status: 'Partially Implemented' },
        { applicability: 'undecided', status: 'Not Assessed' }
      ]
    },
    tech: {
      inclusionJust: 'Applies to the SaaS platform + supporting AWS environment.',
      exclusionJust: '',
      slots: [
        { applicability: 'included',  status: 'Partially Implemented' },
        { applicability: 'included',  status: 'Not Implemented' },
        { applicability: 'included',  status: 'Implemented' },
        { applicability: 'undecided', status: 'Not Assessed' }
      ]
    },
    _default: {
      inclusionJust: 'In scope of the ISMS.',
      exclusionJust: '',
      slots: [{ applicability: 'undecided', status: 'Not Assessed' }]
    }
  });
  console.log(`  SoA decisions: 93 controls (mixed maturity, many undecided)`);

  const docs = seedDocuments(wsId, ws, 'mandatory');
  console.log(`  documents adopted: ${docs.adopted}, controls auto-linked: ${docs.linked}`);

  // Minimal evidence
  const evidence = [
    { iso_item_id: 'annex-a.5.1', filename: 'ISMS-Policy-draft.docx',            size_bytes: 132456, description: 'Draft ISMS policy: pending top-management approval.' },
    { iso_item_id: 'annex-a.8.5', filename: 'MFA-policy-WIP.docx',                size_bytes: 89234,  description: 'MFA policy under review; enforcement is partial today.' },
    { iso_item_id: 'annex-a.6.3', filename: 'Awareness-training-tracker.xlsx',    size_bytes: 23456,  description: 'Onboarding awareness module: 22 of 50 staff complete.' }
  ];
  seedEvidence(wsId, evidence);
  console.log(`  ${evidence.length} evidence entries`);

  // 0 internal audits

  seedNCs(wsId, [
    { title: 'No formal records of processing under GDPR',         source: 'gap_assessment', source_ref: 'Pass 1', description: 'GDPR Art. 30 records of processing have not been established.', severity: 'major', iso_item_id: 'annex-a.5.34', root_cause: 'Privacy programme not yet established formally.', corrective_action: 'Build records-of-processing register; assign DPO. Target before Stage 1.', responsible: 'COO', due_date: offsetDate(60), status: 'open' },
    { title: 'MFA not enforced for customer accounts',             source: 'gap_assessment', source_ref: 'Pass 1', description: 'MFA is optional for end-user customer accounts on the SaaS platform.',  severity: 'minor', iso_item_id: 'annex-a.8.5',  root_cause: 'Product-side decision to keep MFA optional pending UX work.', corrective_action: 'Roadmap MFA-required toggle for enterprise tenants by Q3.', responsible: 'CTO', due_date: offsetDate(90), status: 'open' }
  ]);
  console.log(`  2 NCs (both open)`);

  // 0 MRMs

  seedImprovements(wsId, [
    { title: 'Adopt secret-scanning across all repos',           description: 'Enable GitHub Advanced Security secret scanning + push-protection.', source: 'gap_assessment', source_ref: 'Pass 1', owner_name: 'CTO',  due_date: offsetDate(45), status: 'open', impact_notes: 'Addresses A.8.4 + supports A.5.7.' },
    { title: 'Build vendor security review programme',          description: 'Tier and review third-party vendors per A.5.19–22 procedure.',       source: 'gap_assessment', source_ref: 'Pass 1', owner_name: 'COO',  due_date: offsetDate(90), status: 'open', impact_notes: 'Needed before Stage 1.' }
  ]);
  console.log(`  2 improvements (both open)`);

  seedParties(wsId, [
    { party: 'Enterprise customers',  party_type: 'customer',  needs: 'ISO 27001 + SOC 2 for procurement; secure SDLC evidence; DPA.', how_addressed: 'Engagement plan targets ISO 27001 by end of year + SOC 2 next year.', owner: 'Head of Sales', review_cadence: 'biannual',  last_reviewed: offsetDate(-60), next_review: offsetDate(120), notes: '' },
    { party: 'ICO',                   party_type: 'regulator', needs: 'GDPR compliance + 72h breach notification.',                     how_addressed: 'DPO to be appointed; records-of-processing register in progress.',     owner: 'COO',           review_cadence: 'annual',    last_reviewed: '',              next_review: offsetDate(60),  notes: 'Open NC tracks the gap.' },
    { party: 'Employees',             party_type: 'internal',  needs: 'Privacy of HR data; clear AUP.',                                  how_addressed: 'Google Workspace with role-based access; AUP in onboarding pack.',     owner: 'COO',           review_cadence: 'annual',    last_reviewed: offsetDate(-90), next_review: offsetDate(270), notes: '' },
    { party: 'Investors (Seed + Series A)', party_type: 'investor', needs: 'Demonstrable security posture as portfolio risk-mgmt.',     how_addressed: 'Quarterly security update at board.',                                 owner: 'CEO',           review_cadence: 'quarterly', last_reviewed: offsetDate(-30), next_review: offsetDate(60),  notes: '' }
  ]);
  console.log(`  4 interested parties`);

  seedObjectives(wsId, [
    { title: 'Achieve ISO 27001 certification by year-end',  description: 'Complete gap, remediate, internal audit, MRM, then Stage 1 + 2.', measurement: 'Stage 2 outcome', target_value: 'Certified', current_value: 'Pre-gap-assessment-complete', owner: 'COO', due_date: offsetDate(300), status: 'in_progress', notes: '' },
    { title: 'Enforce MFA for all enterprise customer tenants', description: 'MFA required on all tenants on the Enterprise plan.', measurement: '% of enterprise tenants with MFA-required toggle on', target_value: '100', current_value: '0', owner: 'CTO', due_date: offsetDate(90), status: 'on_track', notes: '' },
    { title: 'Reach 100% awareness training completion',     description: 'All staff complete the security awareness module.', measurement: '% of active staff with current training', target_value: '100', current_value: '44', owner: 'COO', due_date: offsetDate(45), status: 'in_progress', notes: '' }
  ]);
  console.log(`  3 security objectives`);

  // Single baseline snapshot
  captureSnapshot(wsId, 'Baseline (gap-assessment Pass 1)', 'Initial gap-assessment snapshot.');
  console.log(`  1 SoA snapshot`);

  return wsId;
}

// ============================================================
// MAIN
// ============================================================
console.log('Seeding two demo ISO 27001 client workspaces…');
const northwindId = seedNorthwind();
const helioId = seedHelio();
console.log('\n──────────────────────────────────────────────');
console.log('  Northwind Financial Services  →  /workspaces/' + northwindId);
console.log('  Helio Software Inc.           →  /workspaces/' + helioId);
console.log('──────────────────────────────────────────────');
console.log('Done.');
