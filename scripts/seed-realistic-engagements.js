// Seed two realistic ISO 27001 engagements with full user + consultant coverage.
// One client at 100% implementation, one at 60%. Idempotent - re-running
// wipes prior demo state for these two clients and re-seeds fresh.
//
//   node scripts/seed-realistic-engagements.js
//
// Creates 5 demo users covering manager / senior_consultant / consultant /
// client_owner roles, with cross-engagement assignments so each user wears
// more than one role.
//
// Login as any seeded user with password: demo1234

'use strict';

const { db, ensureWorkspaceMethodology } = require('../db');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const FIRM_ID = 1;
const PASSWORD = '12345678';
const BCRYPT_COST = 4;

// ---------- helpers ----------
function offsetDate(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}
function randomSha() {
  return crypto.randomBytes(32).toString('hex');
}

function ensureFirm() {
  const f = db.prepare(`SELECT id FROM firms WHERE id=?`).get(FIRM_ID);
  if (!f) db.prepare(`INSERT INTO firms (id, name) VALUES (?, ?)`).run(FIRM_ID, 'My firm');
}

function ensureUser({ email, name, user_type, firm_role }) {
  const existing = db.prepare(`SELECT id FROM users WHERE email=?`).get(email);
  const hash = bcrypt.hashSync(PASSWORD, BCRYPT_COST);
  const firmId = user_type === 'firm' ? FIRM_ID : null;
  if (existing) {
    db.prepare(`UPDATE users SET name=?, user_type=?, firm_id=?, firm_role=?, active=1, password_hash=? WHERE id=?`)
      .run(name, user_type, firmId, firm_role || null, hash, existing.id);
    return existing.id;
  }
  return db.prepare(`INSERT INTO users (email, password_hash, name, user_type, firm_id, firm_role) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(email, hash, name, user_type, firmId, firm_role || null).lastInsertRowid;
}

function wipeClient(clientName) {
  const ws = db.prepare(`SELECT id FROM workspaces WHERE client_name=? AND firm_id=?`).get(clientName, FIRM_ID);
  if (!ws) return;
  const id = ws.id;
  // Manually clear what doesn't cascade
  const safe = sql => { try { db.prepare(sql).run(id); } catch (_) {} };
  safe(`DELETE FROM audit_findings WHERE audit_id IN (SELECT id FROM audits WHERE workspace_id=?)`);
  safe(`DELETE FROM audit_observations WHERE audit_id IN (SELECT id FROM audits WHERE workspace_id=?)`);
  safe(`DELETE FROM document_controls WHERE document_id IN (SELECT id FROM generated_docs WHERE workspace_id=?)`);
  safe(`DELETE FROM doc_versions WHERE document_id IN (SELECT id FROM generated_docs WHERE workspace_id=?)`);
  safe(`DELETE FROM evidence_requirement_links WHERE evidence_id IN (SELECT id FROM evidence WHERE workspace_id=?)`);
  safe(`DELETE FROM risk_treatment_actions WHERE workspace_id=?`);
  safe(`DELETE FROM tasks WHERE workspace_id=?`);
  safe(`DELETE FROM suppliers WHERE workspace_id=?`);
  safe(`DELETE FROM incidents WHERE workspace_id=?`);
  safe(`DELETE FROM training_records WHERE workspace_id=?`);
  safe(`DELETE FROM training_courses WHERE workspace_id=?`);
  safe(`DELETE FROM competence_records WHERE workspace_id=?`);
  safe(`DELETE FROM competence_roles WHERE workspace_id=?`);
  safe(`DELETE FROM communication_plan WHERE workspace_id=?`);
  safe(`DELETE FROM workspace_members WHERE workspace_id=?`);
  safe(`DELETE FROM audit_log WHERE workspace_id=?`);
  db.prepare(`DELETE FROM workspaces WHERE id=?`).run(id);
  console.log(`  cleared prior workspace #${id} (${clientName})`);
}

function createWorkspace(meta) {
  const id = db.prepare(`INSERT INTO workspaces
    (firm_id, client_name, industry, scope, target_cert_date, stage,
     brand_display_name, brand_primary_color, sector, frameworks, lead_consultant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(FIRM_ID, meta.client_name, meta.industry, meta.scope, meta.target_cert_date,
         meta.stage, meta.brand_display_name, meta.brand_primary_color, meta.sector,
         JSON.stringify(meta.frameworks || ['iso27001']), meta.lead_consultant_id || null)
    .lastInsertRowid;
  ensureWorkspaceMethodology(id);
  return id;
}

function addMember(wsId, userId, role) {
  db.prepare(`INSERT OR REPLACE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`)
    .run(wsId, userId, role);
}

function seedAssets(wsId, assets) {
  const ins = db.prepare(`INSERT INTO assets
    (workspace_id, name, type, classification, owner_name, cia_c, cia_i, cia_a, description,
     business_criticality, rto_hours, rpo_hours, bia_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const idByName = {};
  db.transaction(() => {
    for (const a of assets) {
      const id = ins.run(wsId, a.name, a.type, a.classification, a.owner_name,
        a.cia_c, a.cia_i, a.cia_a, a.description,
        a.business_criticality, a.rto_hours, a.rpo_hours, a.bia_notes || '').lastInsertRowid;
      idByName[a.name] = id;
    }
  })();
  return idByName;
}

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

// Stamp every applicable control_state for the workspace.
// `mode` controls the mix:
//   'full'   - all controls included + Implemented (100%)
//   'sixty'  - mix landing at ~60% Implemented across included controls
function seedSoA(wsId, mode) {
  const controls = db.prepare(`SELECT id, category FROM iso_items WHERE type='control' ORDER BY sort_order`).all();
  const ins = db.prepare(`INSERT OR REPLACE INTO control_states
    (workspace_id, iso_item_id, applicability, status, maturity,
     inclusion_justification, exclusion_justification, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);

  const incJust = 'In scope of the ISMS; treats risks identified in the risk register.';
  const excJust = 'Not applicable - no in-house custom hardware or related operations in scope.';

  db.transaction(() => {
    let included = 0, implemented = 0;
    controls.forEach((c, i) => {
      let applicability, status, maturity;
      if (mode === 'full') {
        // 100% client: optimized. Maturity 4-5 (mostly 4, every 3rd a 5)
        // so the average clears the Stage 2 floor (75%) with no 0/1.
        applicability = 'included';
        status = 'Implemented';
        maturity = (i % 3 === 0) ? 5 : 4;
        included++; implemented++;
      } else {
        // 60% client: mixed. Implemented -> 3, Partial -> 2, Not Impl -> 1.
        // Averages around 50-55% (below the 60% Stage 1 floor) with some
        // controls still at 1 so the Stage 2 no-0/1 rule also bites.
        applicability = 'included';
        included++;
        const cycle = i % 10;
        if (cycle < 6) { status = 'Implemented'; maturity = 3; implemented++; }
        else if (cycle < 9) { status = 'Partially Implemented'; maturity = 2; }
        else { status = 'Not Implemented'; maturity = 1; }
      }
      ins.run(wsId, c.id, applicability, status, maturity,
        applicability === 'included' ? incJust : null,
        applicability === 'excluded' ? excJust : null);
    });
    // Also stamp clauses as Implemented for completeness on the dashboard.
    const clauses = db.prepare(`SELECT id FROM iso_items WHERE type='clause'`).all();
    clauses.forEach(cl => {
      const status = mode === 'full' ? 'Implemented' : (Math.random() < 0.7 ? 'Implemented' : 'Partially Implemented');
      const maturity = mode === 'full' ? 4 : 3;
      ins.run(wsId, cl.id, 'included', status, maturity, 'Mandatory clause - applies to every certified ISMS.', null);
    });
    console.log(`  control_states: ${included} included, ${implemented} Implemented (mode=${mode})`);
  })();
}

function seedDocuments(wsId, workspace, tier) {
  const templates = db.prepare(`SELECT * FROM doc_templates WHERE is_system=1${tier ? ' AND tier=?' : ''}`)
    .all(...(tier ? [tier] : []));
  const insDoc = db.prepare(`INSERT INTO generated_docs
    (workspace_id, template_id, name, category, content, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insVer = db.prepare(`INSERT INTO doc_versions
    (document_id, workspace_id, version, name, status, content, content_hash, created_by, change_summary)
    VALUES (?, ?, 1, ?, 'approved', ?, ?, ?, 'Seeded from template')`);
  const insLink = db.prepare(`INSERT OR IGNORE INTO document_controls (document_id, iso_item_id) VALUES (?, ?)`);
  const isoExists = db.prepare(`SELECT 1 FROM iso_items WHERE id=?`);
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
      const docId = insDoc.run(wsId, t.id, t.name, t.category, subbed, 'approved', 1).lastInsertRowid;
      insVer.run(docId, wsId, t.name, subbed, randomSha(), 1);
      const refs = [...JSON.parse(t.controls || '[]'), ...JSON.parse(t.clauses || '[]')];
      for (const ref of refs) {
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

// Attach one evidence row to every included control. For 'sixty' mode only
// the Implemented controls get evidence so the coverage matrix reflects the
// implementation gap.
function seedEvidenceOnEveryControl(wsId, mode) {
  const where = mode === 'full'
    ? `cs.applicability='included'`
    : `cs.applicability='included' AND cs.status='Implemented'`;
  const controls = db.prepare(`
    SELECT i.id, i.title FROM iso_items i
    INNER JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
    WHERE i.type='control' AND ${where}`).all(wsId);
  const insEv = db.prepare(`INSERT INTO evidence
    (workspace_id, iso_item_id, filename, stored_path, sha256, size_bytes, uploaded_by, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const evWrites = require('../lib/evidence-writes');
  db.transaction(() => {
    controls.forEach(c => {
      const cleanTitle = c.title.replace(/^A\.[0-9.]+ /, '').replace(/[^\w]+/g, '-').toLowerCase();
      const fname = `${c.id.replace('annex-', '').replace('clause-', '').toUpperCase()}-${cleanTitle}-evidence.pdf`;
      const id = insEv.run(wsId, c.id, fname, `seed/${fname}`, randomSha(), 100000 + Math.floor(Math.random() * 500000),
        1, `Evidence demonstrating ${c.title} - approved on ${offsetDate(-Math.floor(Math.random() * 90))}.`).lastInsertRowid;
      evWrites.attachIsoControl(db, id, c.id);
    });
  })();
  console.log(`  ${controls.length} evidence entries linked one-per-control`);
}

function seedAudits(wsId, audits) {
  const insA = db.prepare(`INSERT INTO audits
    (workspace_id, title, scope, audit_date, auditor_name, status, summary, created_by, lifecycle_stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insF = db.prepare(`INSERT INTO audit_findings
    (audit_id, iso_item_id, finding_type, description, severity, status)
    VALUES (?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const a of audits) {
      const auditId = insA.run(wsId, a.title, a.scope, a.audit_date,
        a.auditor_name, a.status, a.summary, 1, a.lifecycle_stage || a.status).lastInsertRowid;
      for (const f of (a.findings || [])) {
        insF.run(auditId, f.iso_item_id || null, f.finding_type, f.description, f.severity, f.status);
      }
    }
  })();
}

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
        m.decisions, m.action_items, 1);
    }
  })();
}

function seedImprovements(wsId, items) {
  const ins = db.prepare(`INSERT INTO improvements
    (workspace_id, title, description, source, source_ref, owner_name, due_date,
     status, closed_at, impact_notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const i of items) {
      ins.run(wsId, i.title, i.description, i.source, i.source_ref, i.owner_name,
        i.due_date, i.status, i.closed_at || null, i.impact_notes, 1);
    }
  })();
}

function seedParties(wsId, parties) {
  const ins = db.prepare(`INSERT INTO interested_parties
    (workspace_id, party, party_type, needs, how_addressed, owner,
     review_cadence, last_reviewed, next_review, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const p of parties) {
      ins.run(wsId, p.party, p.party_type, p.needs, p.how_addressed, p.owner,
        p.review_cadence, p.last_reviewed, p.next_review, p.notes || '');
    }
  })();
}

function seedObjectives(wsId, objs) {
  const ins = db.prepare(`INSERT INTO security_objectives
    (workspace_id, title, description, measurement, target_value, current_value,
     owner, due_date, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const o of objs) {
      ins.run(wsId, o.title, o.description, o.measurement, o.target_value,
        o.current_value, o.owner, o.due_date, o.status, o.notes || '');
    }
  })();
}

function captureSnapshot(wsId, label, reason) {
  const rows = db.prepare(`SELECT i.id, i.title, i.category,
        COALESCE(cs.applicability,'undecided') AS applicability,
        COALESCE(cs.status,'Not Assessed') AS status,
        cs.inclusion_justification, cs.exclusion_justification
      FROM iso_items i
      LEFT JOIN control_states cs ON cs.iso_item_id=i.id AND cs.workspace_id=?
      WHERE i.type='control' ORDER BY i.sort_order`).all(wsId);
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
         counts.total, counts.included, counts.excluded, 1);
}

function seedSuppliers(wsId, suppliers) {
  const ins = db.prepare(`INSERT INTO suppliers
    (workspace_id, name, service_provided, tier, data_access,
     contract_start, contract_end, next_review_date, attestations, contact, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const s of suppliers) {
      ins.run(wsId, s.name, s.service, s.tier, s.data_access,
        s.contract_start, s.contract_end, s.next_review_date,
        s.attestations || '', s.contact || '', s.notes || '');
    }
  })();
}

function seedIncidents(wsId, incidents) {
  const ins = db.prepare(`INSERT INTO incidents
    (workspace_id, title, category, severity, detected_at, reported_by,
     status, description, affected_assets, containment_actions, eradication_actions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const i of incidents) {
      ins.run(wsId, i.title, i.category, i.severity, i.detected_at, i.reported_by,
        i.status, i.description, i.affected_assets || '', i.containment_actions || '', i.eradication_actions || '');
    }
  })();
}

function seedTraining(wsId, courses, records) {
  const insC = db.prepare(`INSERT INTO training_courses
    (workspace_id, name, description, duration_minutes, validity_months, required_for_roles, has_quiz, passing_score, iso_control_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insR = db.prepare(`INSERT INTO training_records
    (workspace_id, user_name, user_role, training_name, assigned_date, due_date, completed_date, score, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const c of courses) {
      insC.run(wsId, c.name, c.description, c.duration, c.validity || 12,
        c.required_for || null, c.has_quiz ? 1 : 0, c.passing || null, c.iso_ref || null);
    }
    for (const r of records) {
      insR.run(wsId, r.user, r.role, r.training, r.assigned, r.due, r.completed || null, r.score || null, r.status, r.notes || '');
    }
  })();
}

function seedCompetence(wsId, roles, records) {
  const insRole = db.prepare(`INSERT INTO competence_roles (workspace_id, name, description, required_competences) VALUES (?, ?, ?, ?)`);
  const insRec = db.prepare(`INSERT INTO competence_records
    (workspace_id, role_id, person_name, person_email, competence, evidence_type, evidence_ref, recorded_at, expires_on, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const roleIdByName = {};
  db.transaction(() => {
    for (const r of roles) {
      const id = insRole.run(wsId, r.name, r.description, JSON.stringify(r.required || [])).lastInsertRowid;
      roleIdByName[r.name] = id;
    }
    for (const rec of records) {
      const rid = roleIdByName[rec.role];
      if (!rid) continue;
      insRec.run(wsId, rid, rec.person, rec.email || '', rec.competence,
        rec.evidence_type, rec.evidence_ref, rec.recorded_at, rec.expires_on || null, rec.notes || '');
    }
  })();
}

function seedCommunication(wsId, items) {
  const ins = db.prepare(`INSERT INTO communication_plan
    (workspace_id, what, audience, channel, frequency, owner_name, internal_external, last_sent_date, next_due_date, trigger_event, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const c of items) {
      ins.run(wsId, c.what, c.audience, c.channel, c.frequency, c.owner,
        c.scope || 'internal', c.last_sent || null, c.next_due || null, c.trigger || '', c.notes || '');
    }
  })();
}

function seedTasks(wsId, tasks) {
  const ins = db.prepare(`INSERT INTO tasks
    (workspace_id, title, description, iso_item_id, due_date, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const t of tasks) {
      ins.run(wsId, t.title, t.description, t.iso_item_id || null, t.due_date, t.status, 1);
    }
  })();
}

// ============================================================
// APEX MANUFACTURING - 100% IMPLEMENTATION
// ============================================================
function seedApex(users) {
  const NAME = 'Apex Manufacturing Ltd.';
  console.log(`\n--> ${NAME} (target: 100% implementation)`);
  wipeClient(NAME);
  const wsId = createWorkspace({
    client_name: NAME,
    industry: 'Manufacturing',
    scope: 'Apex production manufacturing facility in Sheffield UK, the connected IT/OT network, the corporate office in Leeds, and the cloud-hosted ERP and MES platforms. Includes all employees, contractors, and IT supply chain involved in production planning, execution, quality, and shipment.',
    target_cert_date: offsetDate(45),
    stage: 'audit_ready',
    brand_display_name: 'Apex Mfg',
    brand_primary_color: '#0B5394',
    sector: 'manufacturing',
    frameworks: ['iso27001'],
    lead_consultant_id: users.priya
  });
  console.log(`  workspace #${wsId} created (lead: Priya Sharma)`);
  const ws = db.prepare(`SELECT * FROM workspaces WHERE id=?`).get(wsId);

  // Consultants assigned
  addMember(wsId, users.priya, 'senior_consultant');
  addMember(wsId, users.daniel, 'consultant');
  addMember(wsId, users.jamie, 'consultant');
  addMember(wsId, users.sam, 'client_owner');
  console.log(`  4 team members assigned`);

  // Assets
  const assets = [
    { name: 'ERP system (SAP S/4HANA)',  type: 'service', classification: 'confidential', owner_name: 'CFO',          cia_c: 3, cia_i: 3, cia_a: 3, description: 'Cloud-hosted ERP for finance, procurement, production planning.',     business_criticality: 'critical', rto_hours: 4, rpo_hours: 1 },
    { name: 'MES (Manufacturing Execution)', type: 'service', classification: 'confidential', owner_name: 'Operations Director', cia_c: 2, cia_i: 3, cia_a: 3, description: 'On-prem MES connecting shop-floor PLCs to ERP.',            business_criticality: 'critical', rto_hours: 2, rpo_hours: 1 },
    { name: 'Production PLCs (OT network)', type: 'hardware', classification: 'restricted', owner_name: 'Operations Director', cia_c: 2, cia_i: 3, cia_a: 3, description: 'Air-gapped where possible; controlled IT/OT bridge.',          business_criticality: 'critical', rto_hours: 1, rpo_hours: 0 },
    { name: 'Customer order database',    type: 'information', classification: 'restricted', owner_name: 'Head of Sales', cia_c: 3, cia_i: 3, cia_a: 2, description: 'Order history + customer commercial terms.',                       business_criticality: 'high',     rto_hours: 4, rpo_hours: 1 },
    { name: 'Microsoft 365 tenant',       type: 'service', classification: 'confidential', owner_name: 'IT Manager',     cia_c: 3, cia_i: 2, cia_a: 2, description: 'Mail, Teams, SharePoint for ~340 staff.',                            business_criticality: 'high',     rto_hours: 8, rpo_hours: 4 },
    { name: 'Active Directory (Entra ID)', type: 'service', classification: 'confidential', owner_name: 'IT Manager',    cia_c: 3, cia_i: 3, cia_a: 3, description: 'Identity provider; conditional access with phishing-resistant MFA.', business_criticality: 'critical', rto_hours: 4, rpo_hours: 1 },
    { name: 'CAD/PLM (Siemens Teamcenter)', type: 'service', classification: 'restricted', owner_name: 'Engineering Director', cia_c: 3, cia_i: 3, cia_a: 2, description: 'Design IP including jigs, tooling, parts lists.',           business_criticality: 'high',     rto_hours: 8, rpo_hours: 4 },
    { name: 'HR & payroll (Workday)',     type: 'service', classification: 'confidential', owner_name: 'Head of HR',      cia_c: 3, cia_i: 2, cia_a: 1, description: 'Employee personal data, payroll, performance.',                   business_criticality: 'medium',   rto_hours: 24, rpo_hours: 24 },
    { name: 'Backup vault (immutable)',   type: 'service', classification: 'confidential', owner_name: 'IT Manager',      cia_c: 3, cia_i: 3, cia_a: 2, description: 'S3 object-lock with 35-day immutable retention.',                  business_criticality: 'high',     rto_hours: 12, rpo_hours: 1 },
    { name: 'Sheffield production site',  type: 'facility', classification: 'restricted', owner_name: 'Operations Director', cia_c: 2, cia_i: 3, cia_a: 3, description: 'Main manufacturing facility; biometric + badge entry.',     business_criticality: 'critical', rto_hours: 48, rpo_hours: 0 },
    { name: 'Leeds corporate office',     type: 'facility', classification: 'confidential', owner_name: 'Office Manager',  cia_c: 1, cia_i: 1, cia_a: 1, description: 'Corporate HQ + finance + design teams.',                          business_criticality: 'medium',   rto_hours: 72, rpo_hours: 0 }
  ];
  const assetIdByName = seedAssets(wsId, assets);
  console.log(`  ${assets.length} assets`);

  // Risks - all treated and closed at 100%
  const risks = [
    { title: 'Ransomware encrypts production servers', description: 'Threat actor reaches production via compromised IT/OT bridge.', asset: 'MES (Manufacturing Execution)', threat: 'Ransomware', vulnerability: 'Historical lack of network segmentation between IT and OT', likelihood: 2, impact: 5, treatment: 'modify', owner_name: 'CIO', status: 'closed', residual_likelihood: 1, residual_impact: 2 },
    { title: 'Customer IP theft via CAD/PLM compromise', description: 'Design files exfiltrated.', asset: 'CAD/PLM (Siemens Teamcenter)', threat: 'Targeted intrusion', vulnerability: 'Engineer accounts without MFA-strength', likelihood: 2, impact: 4, treatment: 'modify', owner_name: 'Engineering Director', status: 'closed', residual_likelihood: 1, residual_impact: 2 },
    { title: 'Supplier compromise propagates to Apex', description: 'A managed-service provider is breached.', asset: 'ERP system (SAP S/4HANA)', threat: 'Third-party breach', vulnerability: 'Outdated supplier contracts without breach-notification clauses', likelihood: 2, impact: 3, treatment: 'share', owner_name: 'Head of Procurement', status: 'treated', residual_likelihood: 1, residual_impact: 2 },
    { title: 'Insider exfiltrates production drawings', description: 'Engineer copies drawings before resignation.', asset: 'CAD/PLM (Siemens Teamcenter)', threat: 'Malicious insider', vulnerability: 'No DLP on engineering endpoints', likelihood: 2, impact: 4, treatment: 'modify', owner_name: 'CISO', status: 'closed', residual_likelihood: 1, residual_impact: 2 },
    { title: 'Phishing yields M365 admin creds', description: 'Spear-phish compromises an IT admin.', asset: 'Microsoft 365 tenant', threat: 'Targeted phishing', vulnerability: 'Weak admin MFA factor', likelihood: 2, impact: 4, treatment: 'modify', owner_name: 'IT Manager', status: 'closed', residual_likelihood: 1, residual_impact: 1 },
    { title: 'Backup integrity compromised', description: 'Attacker tampers with backup before encrypting prod.', asset: 'Backup vault (immutable)', threat: 'Backup-aware ransomware', vulnerability: 'Backups online and mutable', likelihood: 1, impact: 5, treatment: 'modify', owner_name: 'IT Manager', status: 'closed', residual_likelihood: 1, residual_impact: 1 },
    { title: 'Loss of Sheffield site (fire/flood)', description: 'Catastrophic facility loss.', asset: 'Sheffield production site', threat: 'Major environmental event', vulnerability: 'Single-site production', likelihood: 1, impact: 5, treatment: 'modify', owner_name: 'COO', status: 'treated', residual_likelihood: 1, residual_impact: 3 },
    { title: 'Stolen laptop with cached customer data', description: 'A field laptop is lost.', asset: 'Customer order database', threat: 'Opportunistic theft', vulnerability: 'No remote wipe', likelihood: 2, impact: 3, treatment: 'modify', owner_name: 'IT Manager', status: 'closed', residual_likelihood: 1, residual_impact: 1 }
  ];
  seedRisks(wsId, risks, assetIdByName);
  console.log(`  ${risks.length} risks (all closed or treated)`);

  // SoA - everything Implemented
  seedSoA(wsId, 'full');

  // Documents - all mandatory plus a broad set
  const docs = seedDocuments(wsId, ws);
  console.log(`  documents adopted: ${docs.adopted}, controls auto-linked: ${docs.linked}`);

  // Evidence on every included control
  seedEvidenceOnEveryControl(wsId, 'full');

  // Internal audit - clean, all findings closed
  seedAudits(wsId, [
    {
      title: 'Internal audit 2026-Q1 - full ISMS',
      scope: 'Full scope across all clauses and Annex A controls. Sample tested access, change, incident, supplier, backup, BCP.',
      audit_date: offsetDate(-75),
      auditor_name: 'Helena Wright, ISO 27001 LA (independent)',
      status: 'closed',
      lifecycle_stage: 'closed',
      summary: 'Three minor observations raised, all addressed and closed within 30 days. Audit confirms the ISMS is operating effectively and ready for Stage 2.',
      findings: [
        { iso_item_id: 'annex-a.5.19', finding_type: 'observation', severity: 'low', status: 'closed', description: 'Two tier-3 supplier reviews due within 30 days at time of audit; both completed during audit window.' },
        { iso_item_id: 'annex-a.8.16', finding_type: 'observation', severity: 'low', status: 'closed', description: 'Alert triage SLA defined at 30 minutes; sampled triages averaged 12 minutes. Consider tightening the documented SLA.' },
        { iso_item_id: 'clause-9.1',   finding_type: 'opportunity', severity: 'low', status: 'closed', description: 'KPI dashboard recommended in prior audit now live; consider extending to per-service drill-downs.' }
      ]
    },
    {
      title: 'Internal audit 2025-Q3 - pre-Stage-1',
      scope: 'Comprehensive across clauses + Annex A. Targeted sampling of new SDLC controls.',
      audit_date: offsetDate(-260),
      auditor_name: 'Helena Wright, ISO 27001 LA (independent)',
      status: 'closed',
      lifecycle_stage: 'closed',
      summary: 'Five findings raised; all closed before Stage 1. Audit programme then transitioned to surveillance cycle.',
      findings: [
        { iso_item_id: 'annex-a.8.28', finding_type: 'minor_nc', severity: 'medium', status: 'closed', description: 'Secure-coding training not yet covering all dev staff. Closed via role-tailored module rollout.' },
        { iso_item_id: 'annex-a.8.9',  finding_type: 'minor_nc', severity: 'medium', status: 'closed', description: 'CIS baseline drift detected on 4 of 38 production servers. Closed via Ansible enforcement.' },
        { iso_item_id: 'annex-a.5.7',  finding_type: 'opportunity', severity: 'low',    status: 'closed', description: 'Threat-intel feeds aggregated but no documented relevance filter. Filter now documented.' },
        { iso_item_id: 'annex-a.8.13', finding_type: 'observation', severity: 'low',     status: 'closed', description: 'Restore tests every 6 months; recommend quarterly. Closed via quarterly cadence.' },
        { iso_item_id: 'annex-a.6.3',  finding_type: 'conformance', severity: 'low',     status: 'closed', description: 'Awareness training delivery and completion rates exemplary. Continue.' }
      ]
    }
  ]);
  console.log(`  2 internal audits (all findings closed)`);

  // NCs - all closed
  seedNCs(wsId, [
    { title: 'Network segmentation between IT and OT incomplete', source: 'internal_audit', source_ref: 'IA-2025-Q3-F2', description: 'Initial audit found a flat VLAN connecting IT and OT subnets on the Sheffield floor.', severity: 'major', iso_item_id: 'annex-a.8.22', root_cause: 'Pre-existing network design from 2018 acquisition not re-architected after ISMS scope expanded.', corrective_action: 'Designed and implemented L3 firewall between IT and OT with explicit allow-rules. Validated by independent assessor.', responsible: 'IT Manager', due_date: offsetDate(-180), status: 'closed', closed_at: offsetDate(-150) },
    { title: 'Privileged-access review cadence missing', source: 'gap_assessment', source_ref: 'Gap-Pass-1', description: 'Privileged accounts not reviewed on a documented cadence.', severity: 'minor', iso_item_id: 'annex-a.8.2', root_cause: 'Procedure existed for standard accounts but not separately for privileged.', corrective_action: 'Quarterly privileged-access review introduced; first three cycles complete.', responsible: 'CISO', due_date: offsetDate(-200), status: 'closed', closed_at: offsetDate(-180) },
    { title: 'Supplier contracts missing breach-notification clauses', source: 'internal_audit', source_ref: 'IA-2025-Q3-F0', description: '6 of 12 top-tier supplier contracts had no explicit breach-notification timeline.', severity: 'minor', iso_item_id: 'annex-a.5.20', root_cause: 'Pre-2023 contract template lacked the clause; not re-papered on renewal.', corrective_action: 'All in-scope supplier contracts re-papered with 24h notification clause and audit-rights addendum.', responsible: 'Head of Procurement', due_date: offsetDate(-120), status: 'closed', closed_at: offsetDate(-90) },
    { title: 'Asset inventory missed 3 mobile devices', source: 'monitoring', source_ref: 'Monthly check', description: 'Three iPhones from new hires absent from asset register.', severity: 'minor', iso_item_id: 'annex-a.5.9', root_cause: 'Manual asset-add step missed during onboarding.', corrective_action: 'Onboarding workflow updated to require asset-register tick-off before IT ticket close.', responsible: 'IT Manager', due_date: offsetDate(-60), status: 'closed', closed_at: offsetDate(-45) }
  ]);
  console.log(`  4 NCs (all closed)`);

  // MRMs - clean record, decisions all complete
  seedMRMs(wsId, [
    {
      meeting_date: offsetDate(-15), attendees: 'CEO, COO, CFO, CIO, CISO, Head of Legal, Head of Procurement, Operations Director', status: 'closed',
      prior_actions_status: 'All actions from prior MRMs closed; KPI dashboard now reviewed monthly.',
      context_changes: 'Stage 2 audit scheduled for next month. No material change to scope; new EU CRA exposure being tracked.',
      performance_review: 'Implementation: 100% (93/93 included controls Implemented). Open NCs: 0. Open major risks: 0. Audit findings: 3 minor observations, all closed.',
      feedback_interested_parties: 'Two largest customers signed multi-year contracts citing ISO 27001 progress; insurer reduced cyber premium by 12%.',
      risk_treatment_status: 'All identified risks treated or closed; residual risk profile within board appetite.',
      improvement_opportunities: 'Tighten alert SLA from 30 min to 15 min; quarterly tabletops cycled to BEC and supplier-breach scenarios; expand red-team programme.',
      decisions: '(1) Approve scope and methodology for Stage 2. (2) Increase cyber-insurance limit. (3) Re-approve information security policy v3.1.',
      action_items: '(1) CISO: confirm Stage 2 readiness checklist by week-end. (2) COO: send all-staff comms re Stage 2 timing.'
    },
    {
      meeting_date: offsetDate(-105), attendees: 'CEO, COO, CFO, CIO, CISO, Head of Legal, Operations Director', status: 'closed',
      prior_actions_status: 'All actions complete; supplier-contracts re-papered ahead of schedule.',
      context_changes: 'Two new customer audits in Q4; both passed cleanly. Acquired small subcontractor in Manchester - to be integrated into ISMS scope in next cycle.',
      performance_review: 'Implementation tracking at 92%. KPI trends green. Patch SLA at 11.4 days (target 14).',
      feedback_interested_parties: 'Customer audit feedback positive; insurer requested updated risk register copy.',
      risk_treatment_status: 'Treatment plan on track. Manchester acquisition added as a context input.',
      improvement_opportunities: 'Bring Manchester subcontractor into the ISMS by next surveillance.',
      decisions: '(1) Approve integration plan for Manchester subcontractor. (2) Maintain quarterly MRM cadence.',
      action_items: '(1) COO: integration plan for Manchester. (2) CISO: update risk register for insurer.'
    }
  ]);
  console.log(`  2 MRMs (all decisions actioned)`);

  // Improvements - all done
  seedImprovements(wsId, [
    { title: 'ISMS KPI dashboard', description: 'Single source-of-truth dashboard for management review.', source: 'internal_audit', source_ref: 'IA-2025-Q3-F4', owner_name: 'CISO', due_date: offsetDate(-150), status: 'done', closed_at: offsetDate(-140), impact_notes: 'MRM cadence faster + better evidence.' },
    { title: 'Quarterly tabletop programme', description: 'Quarterly IR tabletop rotating through ransomware/BEC/supplier-breach/insider scenarios.', source: 'mrm', source_ref: 'MRM-2025-Q4', owner_name: 'CTO', due_date: offsetDate(-90), status: 'done', closed_at: offsetDate(-80), impact_notes: 'Crisis-comms confidence demonstrably improved.' },
    { title: 'Backup immutability', description: 'Move all backups to S3 object-lock + 35-day immutability.', source: 'risk_assessment', source_ref: 'R-06', owner_name: 'IT Manager', due_date: offsetDate(-200), status: 'done', closed_at: offsetDate(-185), impact_notes: 'Ransomware residual risk reduced.' },
    { title: 'IT/OT segmentation', description: 'L3 firewall between IT and OT VLANs.', source: 'internal_audit', source_ref: 'IA-2025-Q3-F2', owner_name: 'IT Manager', due_date: offsetDate(-150), status: 'done', closed_at: offsetDate(-145), impact_notes: 'OT compromise blast radius reduced.' },
    { title: 'Secret-scanning across repos', description: 'GitHub Advanced Security secret scanning + push protection.', source: 'monitoring', source_ref: '', owner_name: 'Engineering Director', due_date: offsetDate(-60), status: 'done', closed_at: offsetDate(-50), impact_notes: 'Two leaked test keys caught pre-merge.' }
  ]);
  console.log(`  5 improvements (all done)`);

  // Interested parties
  seedParties(wsId, [
    { party: 'Customers (automotive OEMs)', party_type: 'customer',  needs: 'Confidentiality of design data, on-time delivery, ISO 27001 evidence.', how_addressed: 'Encryption at rest + in transit; trust pack with current SoA available.', owner: 'Head of Sales',    review_cadence: 'biannual',  last_reviewed: offsetDate(-60),  next_review: offsetDate(120) },
    { party: 'HSE (regulator)',             party_type: 'regulator', needs: 'Operational health & safety; safety-system integrity.',                 how_addressed: 'OT segmentation; annual third-party assessment.',                  owner: 'Operations Director', review_cadence: 'annual',    last_reviewed: offsetDate(-90),  next_review: offsetDate(270) },
    { party: 'ICO',                         party_type: 'regulator', needs: 'GDPR compliance; breach notification within 72h.',                      how_addressed: 'Records-of-processing register; appointed DPO.',                  owner: 'Head of Legal',    review_cadence: 'annual',    last_reviewed: offsetDate(-120), next_review: offsetDate(240) },
    { party: 'Employees',                   party_type: 'internal',  needs: 'Privacy of HR + payroll data; clear acceptable-use guidance.',          how_addressed: 'Workday with RBAC; AUP signed at onboarding + annual refresh.',  owner: 'Head of HR',       review_cadence: 'annual',    last_reviewed: offsetDate(-150), next_review: offsetDate(210) },
    { party: 'Tier-1 suppliers',            party_type: 'supplier',  needs: 'Predictable demand forecasts; secure data exchange.',                   how_addressed: 'Supplier portal with role-based access; annual security review.', owner: 'Head of Procurement', review_cadence: 'annual',    last_reviewed: offsetDate(-60),  next_review: offsetDate(300) },
    { party: 'Insurer (cyber + property)',  party_type: 'other',     needs: 'Demonstrable risk-management posture.',                                 how_addressed: 'Annual self-assessment + ISO 27001 evidence pack.',                owner: 'CFO',              review_cadence: 'annual',    last_reviewed: offsetDate(-30),  next_review: offsetDate(335) }
  ]);
  console.log(`  6 interested parties`);

  // Objectives - all met
  seedObjectives(wsId, [
    { title: 'Achieve ISO 27001 certification',          description: 'Pass Stage 1 + Stage 2 cleanly.',                           measurement: 'Stage 2 audit outcome',                    target_value: 'Certified',    current_value: 'Stage 1 passed; Stage 2 booked', owner: 'CISO',            due_date: offsetDate(45),  status: 'on_track', notes: '' },
    { title: 'Patch SLA for high-severity CVEs',          description: 'High-severity CVEs patched within 14 days.',                measurement: 'Median days to patch',                    target_value: '14',           current_value: '11',                            owner: 'IT Manager',      due_date: offsetDate(60),  status: 'met',      notes: 'Sustained for 12 months.' },
    { title: '100% mandatory security training completion', description: 'Annual awareness training complete for all staff.',         measurement: '% with current training',                 target_value: '100',          current_value: '100',                           owner: 'Head of HR',      due_date: offsetDate(30),  status: 'met',      notes: '' },
    { title: 'Zero open major NCs',                       description: 'No outstanding major nonconformities.',                       measurement: 'Open major NC count',                     target_value: '0',            current_value: '0',                             owner: 'CISO',            due_date: offsetDate(60),  status: 'met',      notes: '' },
    { title: 'Quarterly IR tabletop programme',           description: 'Run an IR tabletop every quarter.',                            measurement: 'Tabletops per year',                     target_value: '4',            current_value: '4',                             owner: 'CTO',             due_date: offsetDate(60),  status: 'met',      notes: '' },
    { title: 'Supplier review cadence',                   description: 'All in-scope suppliers reviewed within last 12 months.',       measurement: '% on time',                              target_value: '100',          current_value: '100',                           owner: 'Head of Procurement', due_date: offsetDate(90), status: 'met',     notes: '' }
  ]);
  console.log(`  6 objectives (all on track or met)`);

  // Suppliers
  seedSuppliers(wsId, [
    { name: 'Microsoft (M365 + Azure)',  service: 'Productivity + cloud platform', tier: 'tier_1', data_access: 'high', contract_start: offsetDate(-365), contract_end: offsetDate(720), next_review_date: offsetDate(180), attestations: 'ISO 27001, SOC 2, ISO 27018', contact: 'enterprise@microsoft.com' },
    { name: 'SAP (S/4HANA Cloud)',       service: 'ERP', tier: 'tier_1', data_access: 'high', contract_start: offsetDate(-180), contract_end: offsetDate(820), next_review_date: offsetDate(120), attestations: 'ISO 27001, SOC 2', contact: 'csm@sap.com' },
    { name: 'Siemens (Teamcenter)',      service: 'PLM/CAD', tier: 'tier_1', data_access: 'high', contract_start: offsetDate(-300), contract_end: offsetDate(700), next_review_date: offsetDate(60), attestations: 'ISO 27001', contact: 'support@siemens.com' },
    { name: 'Workday',                   service: 'HR + payroll', tier: 'tier_2', data_access: 'medium', contract_start: offsetDate(-700), contract_end: offsetDate(400), next_review_date: offsetDate(160), attestations: 'ISO 27001, SOC 2 Type II', contact: 'csm@workday.com' },
    { name: 'AWS (backup vault)',        service: 'Backup storage', tier: 'tier_2', data_access: 'medium', contract_start: offsetDate(-200), contract_end: offsetDate(900), next_review_date: offsetDate(190), attestations: 'ISO 27001, SOC 2', contact: 'account@aws.amazon.com' },
    { name: 'CrowdStrike',               service: 'EDR', tier: 'tier_2', data_access: 'medium', contract_start: offsetDate(-150), contract_end: offsetDate(580), next_review_date: offsetDate(220), attestations: 'ISO 27001, SOC 2', contact: 'csm@crowdstrike.com' },
    { name: 'Cisco (Umbrella + Meraki)', service: 'Network + DNS filtering', tier: 'tier_3', data_access: 'low', contract_start: offsetDate(-450), contract_end: offsetDate(280), next_review_date: offsetDate(260), attestations: 'ISO 27001, SOC 2', contact: 'partner@cisco.com' }
  ]);
  console.log(`  7 suppliers (all on review cadence)`);

  // Incidents - all closed
  seedIncidents(wsId, [
    { title: 'Phishing reported by Finance staff', category: 'phishing', severity: 'low', detected_at: offsetDate(-45) + ' 09:14:00', reported_by: 'Lisa Chen (Finance)', status: 'closed', description: 'Spoofed PSP login page. Reported via the phish-button. No clicks confirmed.', affected_assets: 'Microsoft 365 tenant', containment_actions: 'URL blocked at proxy + DNS within 12 minutes; bulletin sent to all staff.', eradication_actions: 'Threat indicators added to detection rules. Post-incident debrief held.' },
    { title: 'Suspected USB lost on production floor', category: 'data_loss', severity: 'low', detected_at: offsetDate(-90) + ' 16:30:00', reported_by: 'Production Supervisor', status: 'closed', description: 'A USB drive was misplaced; recovered the next day.', affected_assets: 'Production PLCs (OT network)', containment_actions: 'USB ports disabled on floor terminals.', eradication_actions: 'New policy issued banning removable media on OT.' },
    { title: 'False-positive ransomware alert', category: 'malware', severity: 'medium', detected_at: offsetDate(-20) + ' 22:45:00', reported_by: 'SOC', status: 'closed', description: 'EDR triggered a ransomware behavioural rule on a backup test job.', affected_assets: 'Backup vault (immutable)', containment_actions: 'Host isolated for investigation.', eradication_actions: 'Detection rule refined; backup-test process documented as exception.' }
  ]);
  console.log(`  3 incidents (all closed)`);

  // Training - 100% complete
  const apexStaff = [
    { user: 'Sam Foster',       role: 'CISO' },
    { user: 'Olivia Bennett',   role: 'COO' },
    { user: 'Marcus Reed',      role: 'Operations Director' },
    { user: 'Priya Sharma',     role: 'External consultant (lead)' },
    { user: 'Daniel Kim',       role: 'External consultant' },
    { user: 'Helena Wright',    role: 'Internal auditor' },
    { user: 'Lisa Chen',        role: 'Finance' },
    { user: 'Aaron Patel',      role: 'Engineering' },
    { user: 'Maya Okafor',      role: 'IT' },
    { user: 'Production Team A', role: 'Floor staff' }
  ];
  seedTraining(wsId,
    [
      { name: 'ISO 27001 Awareness - All Staff', description: 'Mandatory annual awareness module.', duration: 30, has_quiz: true, passing: 80, iso_ref: 'annex-a.6.3' },
      { name: 'Phishing Resistance', description: 'How to spot and report phishing.', duration: 15, has_quiz: true, passing: 80, iso_ref: 'annex-a.6.3' },
      { name: 'Secure Coding (Engineering)', description: 'OWASP top 10 + Apex coding standards.', duration: 90, has_quiz: true, passing: 80, iso_ref: 'annex-a.8.28', required_for: 'Engineering' },
      { name: 'Privileged-Access Procedures (IT)', description: 'JIT + audit + least-privilege.', duration: 45, has_quiz: true, passing: 80, iso_ref: 'annex-a.8.2', required_for: 'IT' },
      { name: 'Incident Response Tabletop', description: 'Quarterly tabletop with rotating scenarios.', duration: 120, iso_ref: 'annex-a.5.24' }
    ],
    apexStaff.flatMap(s => [
      { user: s.user, role: s.role, training: 'ISO 27001 Awareness - All Staff', assigned: offsetDate(-120), due: offsetDate(-90), completed: offsetDate(-95), score: '92', status: 'complete' },
      { user: s.user, role: s.role, training: 'Phishing Resistance',              assigned: offsetDate(-80), due: offsetDate(-60), completed: offsetDate(-65), score: '88', status: 'complete' }
    ])
  );
  console.log(`  5 training courses + ${apexStaff.length * 2} training records (100% complete)`);

  // Competence
  seedCompetence(wsId,
    [
      { name: 'ISMS Manager (Lead)', description: 'Overall accountability for the ISMS.', required: ['ISO 27001 Lead Implementer', 'Risk management', 'Audit management'] },
      { name: 'Internal Auditor',    description: 'Conducts internal audits per clause 9.2.', required: ['ISO 27001 Lead Auditor or equivalent', 'Independence from audited area'] },
      { name: 'Privileged-Access Administrator', description: 'Manages privileged access in the IDP.', required: ['Privileged-access procedure trained', 'JML procedure trained'] },
      { name: 'Incident Responder',  description: 'Leads incident response.', required: ['IR runbook trained', 'Forensic-evidence handling trained'] }
    ],
    [
      { role: 'ISMS Manager (Lead)',          person: 'Sam Foster',     email: 'sam.foster@apex.demo',  competence: 'ISO 27001 Lead Implementer (PECB)', evidence_type: 'certificate', evidence_ref: 'PECB-LI-2024-99812', recorded_at: offsetDate(-240), expires_on: offsetDate(820), notes: 'Re-certified within last 12 months.' },
      { role: 'ISMS Manager (Lead)',          person: 'Sam Foster',     email: 'sam.foster@apex.demo',  competence: 'Risk management',                    evidence_type: 'experience',  evidence_ref: '15 years GRC/CISO',     recorded_at: offsetDate(-365), expires_on: null,            notes: '' },
      { role: 'Internal Auditor',             person: 'Helena Wright',  email: 'helena@independent.demo', competence: 'ISO 27001 Lead Auditor (IRCA)',  evidence_type: 'certificate', evidence_ref: 'IRCA-LA-2025-44782',    recorded_at: offsetDate(-120), expires_on: offsetDate(700), notes: 'Independent of audited area.' },
      { role: 'Privileged-Access Administrator', person: 'Maya Okafor', email: 'maya.okafor@apex.demo', competence: 'Privileged-access procedure trained', evidence_type: 'training_record', evidence_ref: 'Course-PA-2026', recorded_at: offsetDate(-30), expires_on: offsetDate(335), notes: '' },
      { role: 'Incident Responder',           person: 'Aaron Patel',    email: 'aaron.patel@apex.demo', competence: 'IR runbook trained',                 evidence_type: 'training_record', evidence_ref: 'IR-Tabletop-Q1', recorded_at: offsetDate(-40), expires_on: offsetDate(325), notes: '' }
    ]
  );
  console.log(`  4 competence roles + 5 competence records (all met)`);

  // Communication plan
  seedCommunication(wsId, [
    { what: 'Monthly ISMS update',                audience: 'All staff',          channel: 'Intranet + Teams', frequency: 'monthly',    owner: 'CISO',     scope: 'internal', last_sent: offsetDate(-15), next_due: offsetDate(15) },
    { what: 'Quarterly board security update',    audience: 'Board of directors', channel: 'Board meeting',    frequency: 'quarterly',  owner: 'CEO',      scope: 'internal', last_sent: offsetDate(-30), next_due: offsetDate(60) },
    { what: 'Regulatory breach notification',     audience: 'ICO + customers',    channel: 'Email + portal',   frequency: 'on incident', owner: 'Head of Legal', scope: 'external', trigger: 'Any incident meeting notification threshold' },
    { what: 'Customer security newsletter',       audience: 'Customers',          channel: 'Trust page',       frequency: 'biannual',   owner: 'Head of Sales', scope: 'external', last_sent: offsetDate(-60), next_due: offsetDate(120) },
    { what: 'Annual ISMS scope notice',           audience: 'Workforce',          channel: 'All-hands',        frequency: 'annual',     owner: 'CISO',     scope: 'internal', last_sent: offsetDate(-200), next_due: offsetDate(165) }
  ]);
  console.log(`  5 communication-plan entries`);

  // Tasks - all done
  seedTasks(wsId, [
    { title: 'Pre-Stage-2 evidence pack assembly', description: 'Compile evidence pack and SoA snapshot for auditor.', iso_item_id: 'clause-9.3', due_date: offsetDate(-7), status: 'done' },
    { title: 'Tabletop Q1 - ransomware scenario',  description: 'Run quarterly IR tabletop.', iso_item_id: 'annex-a.5.24', due_date: offsetDate(-30), status: 'done' },
    { title: 'Top-management policy re-approval',  description: 'Annual review of ISMS policy.', iso_item_id: 'clause-5.2', due_date: offsetDate(-50), status: 'done' },
    { title: 'Supplier review - Microsoft',        description: 'Annual supplier review for Microsoft.', iso_item_id: 'annex-a.5.22', due_date: offsetDate(-20), status: 'done' }
  ]);
  console.log(`  4 tasks (all done)`);

  captureSnapshot(wsId, 'Pre-Stage-1 baseline', 'Captured before Stage 1 audit.');
  captureSnapshot(wsId, 'Pre-Stage-2 snapshot', 'Captured for Stage 2 audit pack.');
  console.log(`  2 SoA snapshots`);

  return wsId;
}

// ============================================================
// STELLAR LOGISTICS - 60% IMPLEMENTATION
// ============================================================
function seedStellar(users) {
  const NAME = 'Stellar Logistics PLC';
  console.log(`\n--> ${NAME} (target: ~60% implementation)`);
  wipeClient(NAME);
  const wsId = createWorkspace({
    client_name: NAME,
    industry: 'Logistics & supply chain',
    scope: 'Stellar UK and Ireland logistics operations: depot network, fleet telematics platform, customer order portal, warehouse management system, and corporate IT. Excludes the standalone employee benefits portal and the legacy archive system pending decommission.',
    target_cert_date: offsetDate(180),
    stage: 'implementation',
    brand_display_name: 'Stellar',
    brand_primary_color: '#9B2C2C',
    sector: 'transportation',
    frameworks: ['iso27001'],
    lead_consultant_id: users.daniel
  });
  console.log(`  workspace #${wsId} created (lead: Daniel Kim)`);
  const ws = db.prepare(`SELECT * FROM workspaces WHERE id=?`).get(wsId);

  // Cross-engagement consultants
  addMember(wsId, users.daniel, 'senior_consultant');
  addMember(wsId, users.priya, 'senior_consultant');
  addMember(wsId, users.jamie, 'consultant');
  addMember(wsId, users.sam, 'contributor');
  console.log(`  4 team members assigned (Sam Foster also a fractional contributor)`);

  // Assets
  const assets = [
    { name: 'Fleet telematics platform',   type: 'service', classification: 'confidential', owner_name: 'Head of Operations', cia_c: 2, cia_i: 3, cia_a: 3, description: 'Cloud-hosted vehicle tracking + driver hours.',          business_criticality: 'critical', rto_hours: 4, rpo_hours: 1 },
    { name: 'Customer order portal',       type: 'service', classification: 'restricted', owner_name: 'Head of Customer Ops', cia_c: 3, cia_i: 3, cia_a: 3, description: 'B2B portal where customers book + track shipments.',     business_criticality: 'critical', rto_hours: 4, rpo_hours: 1 },
    { name: 'Warehouse management system', type: 'service', classification: 'confidential', owner_name: 'Head of Warehousing', cia_c: 2, cia_i: 3, cia_a: 3, description: 'WMS used at 14 depots.',                                  business_criticality: 'high',     rto_hours: 8, rpo_hours: 2 },
    { name: 'Driver mobile devices',       type: 'hardware', classification: 'confidential', owner_name: 'Head of Operations', cia_c: 2, cia_i: 2, cia_a: 2, description: '~600 Android devices via Knox/MDM.',                       business_criticality: 'medium',   rto_hours: 12, rpo_hours: 4 },
    { name: 'Microsoft 365 tenant',        type: 'service', classification: 'confidential', owner_name: 'IT Manager',          cia_c: 3, cia_i: 2, cia_a: 2, description: 'Mail + Teams + SharePoint for ~1,400 staff.',              business_criticality: 'high',     rto_hours: 8, rpo_hours: 4 },
    { name: 'Active Directory (Entra ID)', type: 'service', classification: 'confidential', owner_name: 'IT Manager',          cia_c: 3, cia_i: 3, cia_a: 3, description: 'Identity backbone.',                                       business_criticality: 'critical', rto_hours: 4, rpo_hours: 1 },
    { name: 'Customer PII database',       type: 'information', classification: 'restricted', owner_name: 'DPO',              cia_c: 3, cia_i: 3, cia_a: 2, description: 'Address book + delivery preferences.',                     business_criticality: 'high',     rto_hours: 8, rpo_hours: 1 },
    { name: 'Backup storage (Azure)',      type: 'service', classification: 'confidential', owner_name: 'IT Manager',          cia_c: 3, cia_i: 3, cia_a: 2, description: 'GRS storage; immutability planned not yet enforced.',       business_criticality: 'high',     rto_hours: 12, rpo_hours: 1 },
    { name: 'Depot CCTV (14 sites)',       type: 'hardware', classification: 'internal', owner_name: 'Head of Security',       cia_c: 1, cia_i: 1, cia_a: 2, description: 'Recorded locally; 14-day retention.',                       business_criticality: 'low',      rto_hours: 24, rpo_hours: 24 }
  ];
  const assetIdByName = seedAssets(wsId, assets);
  console.log(`  ${assets.length} assets`);

  // Risks - mix of open + treated
  const risks = [
    { title: 'Customer PII leak via portal vulnerability', description: 'IDOR or similar bug exposes other customers\' delivery addresses.', asset: 'Customer order portal', threat: 'Application-layer attacker', vulnerability: 'No formal app-sec testing programme yet', likelihood: 3, impact: 4, treatment: 'modify', owner_name: 'CTO', status: 'open' },
    { title: 'Ransomware encrypts WMS', description: 'Threat actor reaches WMS via compromised admin laptop.', asset: 'Warehouse management system', threat: 'Ransomware', vulnerability: 'No EDR on warehouse desktop fleet', likelihood: 3, impact: 5, treatment: 'modify', owner_name: 'IT Manager', status: 'open' },
    { title: 'Driver-device theft exposes route data', description: 'Lost or stolen tablet contains cached customer delivery info.', asset: 'Driver mobile devices', threat: 'Opportunistic theft', vulnerability: 'MDM enrolment incomplete on legacy fleet', likelihood: 4, impact: 3, treatment: 'modify', owner_name: 'Head of Operations', status: 'open' },
    { title: 'Backup tampering preceding ransomware', description: 'Attacker corrupts backups before encrypting prod.', asset: 'Backup storage (Azure)', threat: 'Backup-aware ransomware', vulnerability: 'Backup immutability not yet enforced', likelihood: 2, impact: 5, treatment: 'modify', owner_name: 'IT Manager', status: 'open' },
    { title: 'Supplier breach exposes Stellar customer data', description: 'A logistics-tech vendor is breached.', asset: 'Fleet telematics platform', threat: 'Third-party breach', vulnerability: 'No formal supplier security review programme', likelihood: 3, impact: 3, treatment: 'share', owner_name: 'Head of Procurement', status: 'open' },
    { title: 'Phishing yields M365 admin creds', description: 'Spear-phish compromises an IT admin.', asset: 'Microsoft 365 tenant', threat: 'Targeted phishing', vulnerability: 'Conditional access policies not yet fully tuned', likelihood: 3, impact: 4, treatment: 'modify', owner_name: 'IT Manager', status: 'open' },
    { title: 'Insider exfiltrates customer list', description: 'A leaving sales rep exports customer data.', asset: 'Customer PII database', threat: 'Malicious insider', vulnerability: 'No DLP on outbound email', likelihood: 2, impact: 3, treatment: 'modify', owner_name: 'CISO', status: 'open' },
    { title: 'GDPR breach - notification missed', description: 'A breach exceeds 72h notification window.', asset: 'Customer PII database', threat: 'Regulatory action', vulnerability: 'IR runbook does not yet codify ICO notification triggers', likelihood: 2, impact: 5, treatment: 'modify', owner_name: 'DPO', status: 'treated', residual_likelihood: 1, residual_impact: 3 },
    { title: 'CCTV recordings tampered with', description: 'Insider clears CCTV after an incident.', asset: 'Depot CCTV (14 sites)', threat: 'Evidence tampering', vulnerability: 'CCTV management interface uses shared depot account', likelihood: 2, impact: 2, treatment: 'modify', owner_name: 'Head of Security', status: 'open' }
  ];
  seedRisks(wsId, risks, assetIdByName);
  console.log(`  ${risks.length} risks (mostly open, treatment in progress)`);

  // SoA - 60% Implemented
  seedSoA(wsId, 'sixty');

  // Documents - mandatory only
  const docs = seedDocuments(wsId, ws, 'mandatory');
  console.log(`  documents adopted: ${docs.adopted}, controls auto-linked: ${docs.linked}`);

  // Evidence - only on Implemented controls (60% of total)
  seedEvidenceOnEveryControl(wsId, 'sixty');

  // Internal audit - in progress
  seedAudits(wsId, [
    {
      title: 'Internal audit 2026-Q1 - mid-implementation review',
      scope: 'Phase 1 of multi-cycle plan: clauses 4-7 + Annex A.5 controls. Phase 2 (A.6-A.8) booked for next quarter.',
      audit_date: offsetDate(-30),
      auditor_name: 'External auditor on rotation - Carter Wilson, ISO 27001 LA',
      status: 'reported',
      lifecycle_stage: 'reported',
      summary: '7 findings raised: 2 minor NCs, 3 observations, 2 OFIs. Corrective actions in progress; closure targeted before Phase 2.',
      findings: [
        { iso_item_id: 'annex-a.5.19', finding_type: 'minor_nc', severity: 'medium', status: 'open',   description: 'Supplier security policy v1.0 dated; not refreshed since 2023. Programme not yet operational across all tier-1 suppliers.' },
        { iso_item_id: 'annex-a.8.5',  finding_type: 'minor_nc', severity: 'medium', status: 'open',   description: 'MFA enforced on admin paths but not yet rolled out for all standard user remote-access scenarios.' },
        { iso_item_id: 'annex-a.5.24', finding_type: 'observation', severity: 'medium', status: 'open', description: 'Incident-response plan exists but no tabletop exercise has been run yet.' },
        { iso_item_id: 'annex-a.8.16', finding_type: 'observation', severity: 'medium', status: 'open', description: 'Centralised logging in place for cloud; on-prem depot infrastructure not yet feeding the SIEM.' },
        { iso_item_id: 'clause-9.1',   finding_type: 'observation', severity: 'low',    status: 'open', description: 'Monitoring data captured per system; no aggregated KPI dashboard yet.' },
        { iso_item_id: 'annex-a.6.3',  finding_type: 'opportunity', severity: 'low',    status: 'open', description: 'Awareness training rolled out to corporate staff; depot staff coverage at 62%.' },
        { iso_item_id: 'annex-a.8.13', finding_type: 'opportunity', severity: 'low',    status: 'closed', description: 'Restore-test cadence formalised at quarterly. First test passed.' }
      ]
    }
  ]);
  console.log(`  1 internal audit (in progress; findings mostly open)`);

  // NCs - mix
  seedNCs(wsId, [
    { title: 'Supplier security programme not yet operational', source: 'internal_audit', source_ref: 'IA-2026-Q1-F1', description: 'Supplier policy exists but is not consistently applied across tier-1 suppliers.', severity: 'minor', iso_item_id: 'annex-a.5.19', root_cause: 'No single accountable owner; reviews tracked manually.', corrective_action: 'Appointed Head of Procurement as owner; tracking moved into workspace tasks; quarterly review cadence agreed.', responsible: 'Head of Procurement', due_date: offsetDate(60), status: 'open' },
    { title: 'MFA not enforced for all remote-access scenarios', source: 'internal_audit', source_ref: 'IA-2026-Q1-F2', description: 'Standard-user remote access still allows password-only login from corporate IP ranges.', severity: 'minor', iso_item_id: 'annex-a.8.5', root_cause: 'Pre-2025 conditional-access policy left an exclusion that has not been removed.', corrective_action: 'Conditional-access policy updated; phased rollout (corporate Q2, depots Q3).', responsible: 'IT Manager', due_date: offsetDate(75), status: 'open' },
    { title: 'No IR tabletop exercise in last 12 months', source: 'internal_audit', source_ref: 'IA-2026-Q1-F3', description: 'IR plan exists but no exercise has tested it.', severity: 'minor', iso_item_id: 'annex-a.5.24', root_cause: 'Plan was finalised within the last 6 months; first tabletop not yet scheduled.', corrective_action: 'Tabletop scheduled for next month with rotating quarterly scenarios.', responsible: 'CISO', due_date: offsetDate(30), status: 'open' },
    { title: 'Driver-device MDM enrolment gap', source: 'gap_assessment', source_ref: 'Gap-Pass-2', description: '~14% of legacy driver devices not yet MDM-enrolled.', severity: 'minor', iso_item_id: 'annex-a.7.9', root_cause: 'Hardware refresh paused; legacy devices remain in field.', corrective_action: 'Refresh resumed; 8% remaining as of last review.', responsible: 'Head of Operations', due_date: offsetDate(90), status: 'open' },
    { title: 'Asset inventory missed 6 warehouse PCs', source: 'monitoring', source_ref: '', description: 'Six PCs from a depot refresh absent from the register.', severity: 'minor', iso_item_id: 'annex-a.5.9', root_cause: 'Manual asset-add step missed during depot rollout.', corrective_action: 'Asset register updated; rollout checklist amended.', responsible: 'IT Manager', due_date: offsetDate(-30), status: 'closed', closed_at: offsetDate(-20) }
  ]);
  console.log(`  5 NCs (4 open, 1 closed)`);

  // MRMs - one held
  seedMRMs(wsId, [
    {
      meeting_date: offsetDate(-45), attendees: 'CEO, COO, CISO, IT Manager, DPO, Head of Procurement', status: 'closed',
      prior_actions_status: 'Risk register refreshed; ISMS scope approved; gap-assessment Pass 2 complete.',
      context_changes: 'Two new enterprise customer contracts pending ISO 27001 by year-end. Q2 audit Phase 1 booked.',
      performance_review: 'Implementation tracking at ~55-60% across Annex A. Major gaps: A.5.19 supplier programme, A.5.24 IR tabletop, A.8.5 MFA universality.',
      feedback_interested_parties: 'Enterprise customers pushing on certification deadline; insurer requested cyber-risk update.',
      risk_treatment_status: 'Treatment plan with 9 items; 2 done, 7 in progress.',
      improvement_opportunities: 'Backup immutability, EDR on warehouse fleet, KPI dashboard, depot SIEM integration.',
      decisions: '(1) Allocate additional budget for warehouse EDR rollout. (2) Schedule first IR tabletop. (3) Sponsor cross-functional KPI dashboard project.',
      action_items: '(1) CISO: tabletop scheduled by month-end. (2) IT Manager: EDR procurement business case by next finance committee. (3) DPO: refresh customer breach-notification clauses.'
    }
  ]);
  console.log(`  1 MRM held`);

  // Improvements - mix
  seedImprovements(wsId, [
    { title: 'EDR on warehouse PCs',          description: 'Deploy CrowdStrike Falcon to all warehouse Windows desktops.', source: 'internal_audit', source_ref: 'IA-2026-Q1', owner_name: 'IT Manager',     due_date: offsetDate(90),  status: 'in_progress', impact_notes: 'Reduces ransomware risk.' },
    { title: 'Backup immutability',           description: 'Enable Azure backup soft-delete + immutable retention.',     source: 'mrm',           source_ref: 'MRM-2025-Q4', owner_name: 'IT Manager',     due_date: offsetDate(60),  status: 'in_progress', impact_notes: 'Reduces backup-aware ransomware risk.' },
    { title: 'KPI dashboard',                 description: 'Single dashboard for management review.',                     source: 'internal_audit', source_ref: 'IA-2026-Q1-F5', owner_name: 'CISO',         due_date: offsetDate(75),  status: 'open',        impact_notes: '' },
    { title: 'Depot SIEM integration',        description: 'Feed depot infrastructure logs into the SIEM.',                source: 'internal_audit', source_ref: 'IA-2026-Q1-F4', owner_name: 'IT Manager',   due_date: offsetDate(110), status: 'open',        impact_notes: '' },
    { title: 'Awareness training - depot staff', description: 'Extend awareness training to depot staff (62 -> 100%).',     source: 'internal_audit', source_ref: 'IA-2026-Q1-F6', owner_name: 'Head of HR', due_date: offsetDate(45),  status: 'in_progress', impact_notes: '' },
    { title: 'Restore-test cadence quarterly', description: 'Move backup restore tests from biannual to quarterly.',         source: 'internal_audit', source_ref: 'IA-2026-Q1-F7', owner_name: 'IT Manager',  due_date: offsetDate(-30), status: 'done', closed_at: offsetDate(-15), impact_notes: 'First quarterly test passed.' }
  ]);
  console.log(`  6 improvements (4 in progress, 1 open, 1 done)`);

  // Interested parties
  seedParties(wsId, [
    { party: 'Customers (enterprise B2B)',   party_type: 'customer',  needs: 'On-time delivery; security of order + delivery data; ISO 27001 evidence.', how_addressed: 'SLA-driven service; trust page in development; cert programme in progress.', owner: 'Head of Customer Ops', review_cadence: 'biannual', last_reviewed: offsetDate(-60), next_review: offsetDate(120) },
    { party: 'Department for Transport (regulator)', party_type: 'regulator', needs: 'Driver-hours compliance; operational resilience.',           how_addressed: 'Telematics-driven compliance reporting.',                                       owner: 'Head of Operations',   review_cadence: 'annual',   last_reviewed: offsetDate(-90), next_review: offsetDate(270) },
    { party: 'ICO',                           party_type: 'regulator', needs: 'GDPR compliance; 72h breach notification.',                            how_addressed: 'DPO appointed; runbook updated; records-of-processing register WIP.',          owner: 'DPO',                  review_cadence: 'annual',   last_reviewed: offsetDate(-100), next_review: offsetDate(260) },
    { party: 'Employees + drivers',           party_type: 'internal',  needs: 'Privacy of HR + payroll data; clear AUP; driver-hours fairness.',     how_addressed: 'Workday with RBAC; AUP signed at onboarding.',                                  owner: 'Head of HR',            review_cadence: 'annual',   last_reviewed: offsetDate(-180), next_review: offsetDate(180) },
    { party: 'Tier-1 suppliers',              party_type: 'supplier',  needs: 'Predictable order forecasts; secure data exchange.',                  how_addressed: 'Supplier portal in progress; security review programme being built.',           owner: 'Head of Procurement',   review_cadence: 'annual',   last_reviewed: offsetDate(-200), next_review: offsetDate(160) }
  ]);
  console.log(`  5 interested parties`);

  // Objectives - mid-flight
  seedObjectives(wsId, [
    { title: 'Achieve ISO 27001 certification',          description: 'Pass Stage 1 + Stage 2.',                          measurement: 'Stage 2 audit outcome',     target_value: 'Certified', current_value: 'Implementation in progress', owner: 'CISO',     due_date: offsetDate(180), status: 'in_progress', notes: '' },
    { title: 'Reach 100% implementation across SoA',     description: 'Every included Annex A control Implemented.',       measurement: '% of included controls Implemented', target_value: '100', current_value: '60', owner: 'CISO', due_date: offsetDate(120), status: 'in_progress', notes: 'Tracking 60% as of last review.' },
    { title: 'Awareness training 100% completion',       description: 'All staff complete the awareness module.',          measurement: '% with current training',    target_value: '100',       current_value: '78',    owner: 'Head of HR', due_date: offsetDate(45),  status: 'in_progress', notes: 'Depot rollout pending.' },
    { title: 'Patch SLA for high-severity CVEs',         description: 'Patch high-severity CVEs within 14 days.',          measurement: 'Median days to patch',       target_value: '14',        current_value: '22',    owner: 'IT Manager', due_date: offsetDate(90), status: 'in_progress', notes: 'Process being formalised.' },
    { title: 'Supplier review cadence',                  description: 'All tier-1 suppliers reviewed in last 12 months.',  measurement: '% on time',                  target_value: '100',       current_value: '40',    owner: 'Head of Procurement', due_date: offsetDate(120), status: 'in_progress', notes: '' }
  ]);
  console.log(`  5 objectives (all in progress)`);

  // Suppliers
  seedSuppliers(wsId, [
    { name: 'Microsoft (M365)',           service: 'Productivity + email',    tier: 'tier_1', data_access: 'high',   contract_start: offsetDate(-200), contract_end: offsetDate(530), next_review_date: offsetDate(-30), attestations: 'ISO 27001, SOC 2', contact: 'enterprise@microsoft.com', notes: 'Review overdue.' },
    { name: 'Verizon Connect',            service: 'Fleet telematics',         tier: 'tier_1', data_access: 'high',   contract_start: offsetDate(-300), contract_end: offsetDate(420), next_review_date: offsetDate(-60), attestations: 'ISO 27001', contact: 'csm@verizonconnect.com',     notes: 'Review overdue.' },
    { name: 'Manhattan Associates (WMS)', service: 'Warehouse management',     tier: 'tier_2', data_access: 'medium', contract_start: offsetDate(-500), contract_end: offsetDate(230), next_review_date: offsetDate(60),  attestations: 'SOC 2', contact: 'support@manhattan.com',           notes: '' },
    { name: 'Azure (backup + WMS host)',  service: 'Cloud platform',           tier: 'tier_1', data_access: 'high',   contract_start: offsetDate(-150), contract_end: offsetDate(550), next_review_date: offsetDate(120), attestations: 'ISO 27001, SOC 2',                          contact: 'account@microsoft.com', notes: '' },
    { name: 'CrowdStrike',                service: 'EDR (corporate fleet)',    tier: 'tier_2', data_access: 'medium', contract_start: offsetDate(-90),  contract_end: offsetDate(640), next_review_date: offsetDate(180),  attestations: 'ISO 27001, SOC 2', contact: 'csm@crowdstrike.com',     notes: 'Warehouse rollout pending.' },
    { name: 'Workday',                    service: 'HR + payroll',             tier: 'tier_2', data_access: 'medium', contract_start: offsetDate(-700), contract_end: offsetDate(400), next_review_date: offsetDate(100), attestations: 'ISO 27001, SOC 2', contact: 'csm@workday.com',          notes: '' }
  ]);
  console.log(`  6 suppliers (2 overdue for review)`);

  // Incidents - one open
  seedIncidents(wsId, [
    { title: 'Phishing reported - HR payroll lure',  category: 'phishing',  severity: 'medium', detected_at: offsetDate(-12) + ' 11:00:00', reported_by: 'Three staff via phish-button', status: 'closed', description: 'Generic payroll lure; URL blocked; no compromise.', affected_assets: 'Microsoft 365 tenant', containment_actions: 'URL blocked at proxy + DNS; all-staff bulletin.', eradication_actions: 'Detection rule added.' },
    { title: 'Lost driver tablet',                   category: 'data_loss', severity: 'low',    detected_at: offsetDate(-25) + ' 18:30:00', reported_by: 'Depot Manager', status: 'closed', description: 'A driver tablet was lost in the field; remote-wiped.', affected_assets: 'Driver mobile devices', containment_actions: 'Remote wipe within 4 hours.', eradication_actions: 'Re-issued.' },
    { title: 'Suspected portal IDOR - investigating', category: 'web_app',   severity: 'medium', detected_at: offsetDate(-5)  + ' 14:20:00', reported_by: 'Bug-bounty researcher', status: 'open',   description: 'External researcher reports possible IDOR on order-detail endpoint.', affected_assets: 'Customer order portal', containment_actions: 'Endpoint rate-limited; manual review in progress.', eradication_actions: 'Patch expected this week.' }
  ]);
  console.log(`  3 incidents (1 open under investigation)`);

  // Training - 60% complete
  const stellarStaff = [
    { user: 'Rachel Green',     role: 'CEO' },
    { user: 'James Patel',      role: 'COO' },
    { user: 'Yusuf Hassan',     role: 'CISO' },
    { user: 'Daniel Kim',       role: 'External consultant (lead)' },
    { user: 'Jamie Chen',       role: 'External consultant' },
    { user: 'Depot Manager A',  role: 'Operations' },
    { user: 'Depot Manager B',  role: 'Operations' },
    { user: 'Depot Manager C',  role: 'Operations' },
    { user: 'Driver Cohort 1',  role: 'Driver' },
    { user: 'Driver Cohort 2',  role: 'Driver' }
  ];
  seedTraining(wsId,
    [
      { name: 'ISO 27001 Awareness - All Staff', description: 'Mandatory annual awareness module.', duration: 30, has_quiz: true, passing: 80, iso_ref: 'annex-a.6.3' },
      { name: 'Phishing Resistance', description: 'How to spot and report phishing.', duration: 15, has_quiz: true, passing: 80, iso_ref: 'annex-a.6.3' },
      { name: 'Driver Data Handling', description: 'Driver-specific data handling.', duration: 20, iso_ref: 'annex-a.5.10', required_for: 'Driver' }
    ],
    stellarStaff.map((s, i) => i < 6
      ? { user: s.user, role: s.role, training: 'ISO 27001 Awareness - All Staff', assigned: offsetDate(-90), due: offsetDate(-30), completed: offsetDate(-35), score: '88', status: 'complete' }
      : { user: s.user, role: s.role, training: 'ISO 27001 Awareness - All Staff', assigned: offsetDate(-90), due: offsetDate(-30), completed: null, score: null, status: 'overdue', notes: 'Depot cohort rollout in progress.' }
    )
  );
  console.log(`  3 training courses + ${stellarStaff.length} records (~60% complete, depots overdue)`);

  // Competence
  seedCompetence(wsId,
    [
      { name: 'ISMS Manager',     description: 'Overall ISMS accountability.', required: ['ISO 27001 Lead Implementer', 'Risk management'] },
      { name: 'Internal Auditor', description: 'Conducts internal audits.',     required: ['ISO 27001 Lead Auditor or equivalent', 'Independence from audited area'] }
    ],
    [
      { role: 'ISMS Manager',     person: 'Yusuf Hassan',  email: 'yusuf.hassan@stellar.demo', competence: 'ISO 27001 Lead Implementer',  evidence_type: 'certificate', evidence_ref: 'PECB-LI-2025-71140', recorded_at: offsetDate(-180), expires_on: offsetDate(900),  notes: '' },
      { role: 'Internal Auditor', person: 'Carter Wilson', email: 'carter@independent.demo',   competence: 'ISO 27001 Lead Auditor',      evidence_type: 'certificate', evidence_ref: 'IRCA-LA-2024-32918', recorded_at: offsetDate(-220), expires_on: offsetDate(580), notes: 'External rotation.' }
    ]
  );
  console.log(`  2 competence roles + 2 competence records`);

  // Communication plan
  seedCommunication(wsId, [
    { what: 'Monthly ISMS update',                audience: 'All staff',          channel: 'Intranet',         frequency: 'monthly',    owner: 'CISO',                 scope: 'internal', last_sent: offsetDate(-20), next_due: offsetDate(10) },
    { what: 'Quarterly board security update',    audience: 'Board',              channel: 'Board meeting',    frequency: 'quarterly',  owner: 'CEO',                  scope: 'internal', last_sent: offsetDate(-45), next_due: offsetDate(45) },
    { what: 'Regulatory breach notification',     audience: 'ICO + customers',    channel: 'Email + portal',   frequency: 'on incident', owner: 'DPO',                 scope: 'external', trigger: 'Any incident meeting notification threshold' },
    { what: 'Annual scope notice',                audience: 'Workforce',          channel: 'All-hands',        frequency: 'annual',     owner: 'CISO',                 scope: 'internal', last_sent: null, next_due: offsetDate(60), notes: 'First annual notice pending.' }
  ]);
  console.log(`  4 communication-plan entries`);

  // Tasks - mix
  seedTasks(wsId, [
    { title: 'Schedule first IR tabletop',          description: 'Pick a date and run the tabletop with rotating scenarios.', iso_item_id: 'annex-a.5.24', due_date: offsetDate(30),  status: 'todo' },
    { title: 'Complete supplier register refresh',  description: 'Refresh tier classification + DPA references for all tier-1 suppliers.', iso_item_id: 'annex-a.5.19', due_date: offsetDate(60), status: 'in_progress' },
    { title: 'Roll out EDR to warehouse PCs',       description: 'CrowdStrike deployment.',                                                                             iso_item_id: 'annex-a.8.7',  due_date: offsetDate(90),  status: 'in_progress' },
    { title: 'Enable backup immutability',          description: 'Azure backup soft-delete + immutable retention.',                                                     iso_item_id: 'annex-a.8.13', due_date: offsetDate(60),  status: 'in_progress' },
    { title: 'Depot staff awareness training',      description: 'Extend awareness module to all depot staff.',                                                          iso_item_id: 'annex-a.6.3',  due_date: offsetDate(45),  status: 'in_progress' },
    { title: 'Aggregate KPI dashboard',             description: 'Single source-of-truth dashboard for ISMS KPIs.',                                                       iso_item_id: 'clause-9.1',   due_date: offsetDate(75),  status: 'todo' },
    { title: 'Driver-device MDM refresh - phase 2', description: 'Bring remaining 8% of legacy driver devices onto MDM.',                                                 iso_item_id: 'annex-a.7.9',  due_date: offsetDate(90),  status: 'in_progress' }
  ]);
  console.log(`  7 tasks (mix open/in-progress)`);

  captureSnapshot(wsId, 'Baseline gap-assessment', 'Captured at end of gap-assessment Pass 2.');
  console.log(`  1 SoA snapshot`);

  return wsId;
}

// ============================================================
// MAIN
// ============================================================
console.log('Seeding 5 demo users + 2 client engagements (Apex 100%, Stellar 60%)...');
ensureFirm();
const users = {
  alex:    ensureUser({ email: 'alex.morgan@demo.firm',    name: 'Alex Morgan',    user_type: 'firm',  firm_role: 'manager' }),
  priya:   ensureUser({ email: 'priya.sharma@demo.firm',   name: 'Priya Sharma',   user_type: 'firm',  firm_role: 'senior_consultant' }),
  daniel:  ensureUser({ email: 'daniel.kim@demo.firm',     name: 'Daniel Kim',     user_type: 'firm',  firm_role: 'senior_consultant' }),
  jamie:   ensureUser({ email: 'jamie.chen@demo.firm',     name: 'Jamie Chen',     user_type: 'firm',  firm_role: 'consultant' }),
  sam:     ensureUser({ email: 'sam.foster@apex.demo',     name: 'Sam Foster',     user_type: 'client', firm_role: null })
};
console.log(`\nUsers seeded (password for all: ${PASSWORD}):`);
console.log(`  Alex Morgan    - manager (firm-wide)`);
console.log(`  Priya Sharma   - senior_consultant   (Apex lead, Stellar member)`);
console.log(`  Daniel Kim     - senior_consultant   (Stellar lead, Apex member)`);
console.log(`  Jamie Chen     - consultant          (member on both)`);
console.log(`  Sam Foster     - client_owner Apex   + contributor on Stellar`);

const apexId    = seedApex(users);
const stellarId = seedStellar(users);

console.log('\n--------------------------------------------------------------');
console.log(`  Apex Manufacturing Ltd.   ->  /workspaces/${apexId}    (100%)`);
console.log(`  Stellar Logistics PLC     ->  /workspaces/${stellarId}    (~60%)`);
console.log('--------------------------------------------------------------');
console.log('Done.');
