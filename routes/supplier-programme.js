'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const email = require('../lib/email');
const supplierRisk = require('../lib/supplier-risk');
const supplierMethodologies = require('../lib/supplier-methodologies');
const uploadSecurity = require('../lib/upload-security');
const { todayFor } = require('../lib/dates');
const { withToast, redirectBack, auditCtx } = require('../lib/http-helpers');

function register(app, deps) {
  const {
    db, requireAuth, requireWorkspace, requirePermission, logAction, qUploadAny,
    resolveUploadPath, questionnaireFileExtensions
  } = deps;

  const supplier = (wsId, supplierId) => db.prepare('SELECT * FROM suppliers WHERE id=? AND workspace_id=? AND archived_at IS NULL').get(supplierId, wsId);
  const currentInherent = supplierId => db.prepare(`SELECT * FROM supplier_inherent_assessments WHERE supplier_id=? AND status!='superseded' ORDER BY id DESC LIMIT 1`).get(supplierId);
  const currentDdq = supplierId => db.prepare(`SELECT * FROM supplier_ddq_assessments WHERE supplier_id=? AND status!='superseded' ORDER BY id DESC LIMIT 1`).get(supplierId);
  const currentContract = supplierId => db.prepare(`SELECT * FROM supplier_contract_reviews WHERE supplier_id=? AND status!='superseded' ORDER BY id DESC LIMIT 1`).get(supplierId);

  function parseModules(json) {
    try {
      return JSON.parse(json || '[]').map(module => ({ ...module, name: supplierRisk.canonicalModuleName(module.name) }));
    } catch (_) { return []; }
  }

  function moduleMap(rows) {
    return Object.fromEntries(rows.map(row => [row.name, row.applicability]));
  }

  function cleanFindingId(value, workspaceId, supplierId) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return null;
    const finding = db.prepare(`SELECT f.id,l.supplier_id FROM findings f LEFT JOIN supplier_finding_links l ON l.finding_id=f.id
      WHERE f.id=? AND f.workspace_id=? AND (l.supplier_id IS NULL OR l.supplier_id=?)`).get(id, workspaceId, supplierId);
    return finding ? finding.id : null;
  }

  function supplierFindings(workspaceId, supplierId) {
    return db.prepare(`SELECT f.id,f.title,f.severity,f.status FROM findings f INNER JOIN supplier_finding_links l ON l.finding_id=f.id
      WHERE f.workspace_id=? AND l.supplier_id=? AND f.status NOT IN ('closed','verified')
      ORDER BY CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,f.id DESC`).all(workspaceId, supplierId);
  }

  function linkFinding(findingId, supplierId, domain) {
    if (!findingId) return;
    const linked = db.prepare('SELECT supplier_id FROM supplier_finding_links WHERE finding_id=?').get(findingId);
    if (linked && linked.supplier_id !== supplierId) return;
    db.prepare(`INSERT INTO supplier_finding_links (finding_id,supplier_id,domain)
      VALUES (?,?,?) ON CONFLICT(finding_id) DO UPDATE SET supplier_id=excluded.supplier_id,domain=COALESCE(excluded.domain,supplier_finding_links.domain)`)
      .run(findingId, supplierId, domain || null);
  }

  function cleanupFiles(files) {
    (files || []).forEach(file => { try { fs.unlinkSync(file.path); } catch (_) {} });
  }

  function evidenceUploadMessage(error) {
    if (!error) return null;
    if (error.code === 'LIMIT_FILE_SIZE') return 'A file exceeds the 25 MB limit.';
    if (error.code === 'LIMIT_FILE_COUNT') return 'Upload no more than 40 files for one question at a time.';
    return 'The attachment could not be processed. Check the file and try again.';
  }

  function wantsJson(req) {
    return String(req.get('accept') || '').includes('application/json');
  }

  function validDueDate(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const parsed = new Date(`${text}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
  }

  function formArray(value) {
    return (Array.isArray(value) ? value : value == null ? [] : [value]).map(item => String(item));
  }

  function editableMethodology(req, res) {
    const row = supplierMethodologies.draft(db, req.workspace.id);
    if (!row) {
      redirectBack(req, res, 'Create an editable version before changing the methodology.', 'info');
      return null;
    }
    return row;
  }

  function saveMethodologyDraft(req, res, row, definition, message) {
    supplierMethodologies.saveDraft(db, row, definition);
    logAction(req.user.id, req.workspace.id, 'update_supplier_methodology_draft', 'supplier_risk_methodology', row.id,
      { version: row.version, section: req.body.section || null }, auditCtx(req));
    return res.redirect(withToast(`/workspaces/${req.workspace.id}/supplier-methodology?section=${encodeURIComponent(req.body.section || 'methodology')}`, message, 'success'));
  }

  function futureDueDate(value, workspace) {
    const dueDate = validDueDate(value);
    return dueDate && dueDate >= todayFor(workspace) ? dueDate : null;
  }

  function finishEvidenceUpload(req, res, status, payload, questionId) {
    if (wantsJson(req)) return res.status(status).json(payload);
    const query = new URLSearchParams();
    query.set(payload.ok ? 'evidence_uploaded' : 'evidence_error', payload.message);
    return res.redirect(303, `/supplier-ddq/${req.params.token}?${query}#question-${encodeURIComponent(questionId)}`);
  }

  function inherentResponseMap(assessmentId) {
    return Object.fromEntries(db.prepare('SELECT * FROM supplier_inherent_responses WHERE assessment_id=?').all(assessmentId).map(row => [row.question_id, row]));
  }

  function ddqBundle(assessment, clientName) {
    if (!assessment) return null;
    const methodologyRecord = supplierMethodologies.forAssessment(db, assessment, assessment.workspace_id);
    const methodology = methodologyRecord.definition;
    const modules = parseModules(assessment.modules_json);
    const questions = supplierRisk.questionsForAssessment(assessment.tier, moduleMap(modules), clientName, methodology);
    const responses = db.prepare('SELECT * FROM supplier_ddq_responses WHERE assessment_id=?').all(assessment.id);
    const evidence = db.prepare('SELECT * FROM supplier_ddq_evidence WHERE assessment_id=? ORDER BY uploaded_at,id').all(assessment.id);
    const evidenceMap = {};
    evidence.forEach(row => { (evidenceMap[row.question_id] = evidenceMap[row.question_id] || []).push(row); });
    const responseMap = Object.fromEntries(responses.map(row => [row.question_id, {
      ...row,
      evidence_reference: row.evidence_reference || (evidenceMap[row.question_id]?.length ? 'Uploaded evidence' : null)
    }]));
    const vendorAnswered = questions.filter(question => String(responseMap[question.id]?.response || '').trim()).length;
    const readyForReview = questions.filter(question => {
      const status = supplierRisk.evaluateDdqResponse(question, responseMap[question.id] || {});
      return !['Unanswered', 'Evidence Missing', 'N/A justification required', 'Validation Required'].includes(status);
    }).length;
    return { assessment, methodology, methodologyRecord, modules, questions, responses, responseMap, evidence, evidenceMap,
      vendorAnswered, readyForReview, progress: supplierRisk.ddqProgress(questions, responseMap) };
  }

  function resolveExternalDdq(req, res, next) {
    const hash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const assessment = db.prepare(`SELECT a.*,s.name AS supplier_name,w.client_name,w.brand_display_name,w.firm_id
      FROM supplier_ddq_assessments a JOIN suppliers s ON s.id=a.supplier_id JOIN workspaces w ON w.id=a.workspace_id
      WHERE a.token_hash=?`).get(hash);
    if (!assessment) return res.render('external_supplier_ddq', { state: 'invalid' });
    req._supplierDdq = assessment;
    req.workspace = { id: assessment.workspace_id, firm_id: assessment.firm_id, client_name: assessment.client_name };
    next();
  }

  function contractBundle(review) {
    if (!review) return null;
    const methodologyRecord = supplierMethodologies.forAssessment(db, review, review.workspace_id);
    const methodology = methodologyRecord.definition;
    const items = db.prepare('SELECT * FROM supplier_contract_review_items WHERE review_id=?').all(review.id);
    const itemMap = Object.fromEntries(items.map(row => [row.clause_id, row]));
    return { review, methodology, methodologyRecord, items, itemMap, progress: supplierRisk.contractProgress(methodology.contractClauses, itemMap) };
  }

  app.get('/workspaces/:wsId/supplier-methodology', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const activeMethodology = supplierMethodologies.active(db, req.workspace.id, req.user.id);
    const draftMethodology = supplierMethodologies.draft(db, req.workspace.id);
    const history = db.prepare(`SELECT id,version,name,status,is_active,created_at,published_at,content_hash
      FROM supplier_risk_methodologies WHERE workspace_id=? ORDER BY version DESC`).all(req.workspace.id);
    res.render('supplier_methodology', {
      user: req.user, ws: req.workspace, activeMethodology, draftMethodology, history,
      section: ['methodology','questionnaire','versions'].includes(req.query.section) ? req.query.section : 'methodology',
      validation: draftMethodology ? supplierMethodologies.validateDefinition(draftMethodology.definition) : null
    });
  });

  app.post('/workspaces/:wsId/supplier-methodology/draft', requireAuth, requireWorkspace, requirePermission('supplier.approve'), (req, res) => {
    const row = supplierMethodologies.createDraft(db, req.workspace.id, req.user.id);
    logAction(req.user.id, req.workspace.id, 'create_supplier_methodology_draft', 'supplier_risk_methodology', row.id, { version: row.version }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/supplier-methodology`, `Editable version ${row.version} created. Published assessments are unchanged.`, 'success'));
  });

  app.post('/workspaces/:wsId/supplier-methodology/general', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const row = editableMethodology(req, res); if (!row) return;
    const definition = supplierMethodologies.clone(row.definition);
    definition.title = String(req.body.title || '').trim();
    ['tier_1','tier_2','tier_3','tier_4'].forEach(tierId => {
      const tier = definition.tiers[tierId];
      tier.label = String(req.body[`label_${tierId}`] || tier.label).trim();
      tier.minimumScore = Number(req.body[`minimum_${tierId}`]);
      tier.reviewCadenceMonths = Math.max(1, Number(req.body[`cadence_${tierId}`]) || tier.reviewCadenceMonths || 12);
    });
    definition.scoring.factors.forEach((factor, index) => {
      factor.name = String(req.body[`factor_name_${index}`] || factor.name).trim();
      factor.weight = Number(req.body[`factor_weight_${index}`]) / 100;
    });
    return saveMethodologyDraft(req, res, row, definition, 'Methodology settings saved to the draft.');
  });

  app.post('/workspaces/:wsId/supplier-methodology/inherent/:questionId', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const row = editableMethodology(req, res); if (!row) return;
    const definition = supplierMethodologies.clone(row.definition);
    const question = definition.scoring.questions.find(item => item.id === req.params.questionId);
    if (!question) return redirectBack(req, res, 'Inherent-risk question not found.', 'error');
    question.question = String(req.body.question || '').trim();
    question.guidance = String(req.body.guidance || '').trim();
    question.owner = String(req.body.owner || '').trim();
    question.options.forEach((option, index) => { option.label = String(req.body[`option_${index}`] || '').trim(); });
    return saveMethodologyDraft(req, res, row, definition, `${question.id} updated in the draft.`);
  });

  app.post('/workspaces/:wsId/supplier-methodology/ddq/:questionId', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const row = editableMethodology(req, res); if (!row) return;
    const definition = supplierMethodologies.clone(row.definition);
    let question = definition.ddqQuestions.find(item => item.id === req.params.questionId);
    let isModule = false;
    if (!question) {
      for (const module of definition.modules) {
        question = (module.questions || []).find(item => item.id === req.params.questionId);
        if (question) { isModule = true; break; }
      }
    }
    if (!question) return redirectBack(req, res, 'Due-diligence question not found.', 'error');
    question.enabled = req.body.enabled === '1';
    question.question = String(req.body.question || '').trim();
    question.guidance = String(req.body.guidance || '').trim();
    question.evidenceRequired = String(req.body.evidence_required || '').trim();
    question.evidenceMandatory = req.body.evidence_mandatory === '1';
    if (!isModule) {
      question.domain = String(req.body.domain || '').trim();
      question.theme = String(req.body.theme || '').trim();
      question.tiers = formArray(req.body.tiers).filter(tier => ['tier_1','tier_2','tier_3','tier_4'].includes(tier));
    } else {
      question.theme = String(req.body.theme || question.theme || '').trim();
    }
    return saveMethodologyDraft(req, res, row, definition, `${question.id} updated in the draft.`);
  });

  app.post('/workspaces/:wsId/supplier-methodology/ddq', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const row = editableMethodology(req, res); if (!row) return;
    const definition = supplierMethodologies.clone(row.definition);
    const id = String(req.body.question_id || '').trim().toUpperCase().replace(/[^A-Z0-9._-]/g, '-');
    const all = [...definition.ddqQuestions, ...definition.modules.flatMap(module => module.questions || [])];
    if (!id || all.some(question => question.id === id)) return redirectBack(req, res, 'Enter a unique question ID.', 'error');
    const moduleName = String(req.body.module_name || '');
    const module = definition.modules.find(item => item.name === moduleName);
    const question = {
      id, order: all.length + 1, enabled: true, theme: String(req.body.theme || 'New question').trim(),
      question: String(req.body.question || '').trim(), guidance: String(req.body.guidance || '').trim(),
      evidenceRequired: String(req.body.evidence_required || '').trim(), evidenceMandatory: false
    };
    if (module) module.questions.push(question);
    else {
      question.domain = String(req.body.domain || 'General').trim();
      question.tiers = formArray(req.body.tiers).filter(tier => ['tier_1','tier_2','tier_3','tier_4'].includes(tier));
      if (!question.tiers.length) question.tiers = ['tier_1'];
      definition.ddqQuestions.push(question);
    }
    return saveMethodologyDraft(req, res, row, definition, `${id} added to the draft questionnaire.`);
  });

  app.post('/workspaces/:wsId/supplier-methodology/module/:moduleIndex', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const row = editableMethodology(req, res); if (!row) return;
    const definition = supplierMethodologies.clone(row.definition);
    const module = definition.modules[Number(req.params.moduleIndex)];
    if (!module) return redirectBack(req, res, 'Conditional module not found.', 'error');
    module.name = String(req.body.name || module.name).trim();
    if (module.rule.source === 'owner_validation') module.rule.guidance = String(req.body.guidance || '').trim();
    return saveMethodologyDraft(req, res, row, definition, 'Conditional module updated in the draft.');
  });

  app.post('/workspaces/:wsId/supplier-methodology/publish', requireAuth, requireWorkspace, requirePermission('supplier.approve'), (req, res) => {
    const row = supplierMethodologies.draft(db, req.workspace.id);
    const result = supplierMethodologies.publishDraft(db, row, req.user.id);
    if (!result.ok) return res.redirect(withToast(`/workspaces/${req.workspace.id}/supplier-methodology`, result.errors.join(' '), 'error'));
    logAction(req.user.id, req.workspace.id, 'publish_supplier_methodology', 'supplier_risk_methodology', result.record.id,
      { version: result.record.version, contentHash: result.record.content_hash }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/supplier-methodology?section=versions`, `Version ${result.record.version} published and activated for new assessments.`, 'success'));
  });

  app.get('/workspaces/:wsId/vendors/:id/inherent-risk', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const v = supplier(req.workspace.id, req.params.id);
    if (!v) return res.status(404).send('Supplier not found');
    const assessment = currentInherent(v.id);
    const methodologyRecord = supplierMethodologies.forAssessment(db, assessment, req.workspace.id, req.user.id);
    const methodology = methodologyRecord.definition;
    const responseMap = assessment ? inherentResponseMap(assessment.id) : {};
    const result = assessment ? supplierRisk.scoreInherent(Object.fromEntries(Object.entries(responseMap).map(([id, row]) => [id, row.response_label === 'Unknown / Validation Required' ? 'unknown' : row.score])), methodology) : null;
    res.render('supplier_inherent_assessment', { user: req.user, ws: req.workspace, v, assessment, responseMap, result, methodology, methodologyRecord, clientText: supplierRisk.clientText, tierLabel: (tier) => supplierRisk.tierLabel(tier, methodology) });
  });

  app.post('/workspaces/:wsId/vendors/:id/inherent-risk/start', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const v = supplier(req.workspace.id, req.params.id);
    if (!v) return res.status(404).send('Supplier not found');
    const current = currentInherent(v.id);
    if (current && ['draft', 'submitted'].includes(current.status)) return res.redirect(`/workspaces/${req.workspace.id}/vendors/${v.id}/inherent-risk`);
    const methodologyRecord = supplierMethodologies.active(db, req.workspace.id, req.user.id);
    const methodSnapshot = supplierMethodologies.snapshot(methodologyRecord);
    const assessmentType = supplierRisk.allowedChoice(req.body.assessment_type, ['onboarding', 'periodic', 'triggered'], 'onboarding');
    const id = db.transaction(() => {
      db.prepare(`UPDATE supplier_inherent_assessments SET status='superseded',updated_at=datetime('now') WHERE supplier_id=? AND status!='superseded'`).run(v.id);
      db.prepare(`UPDATE supplier_ddq_assessments SET status='superseded',token_hash=NULL,updated_at=datetime('now') WHERE supplier_id=? AND status!='superseded'`).run(v.id);
      db.prepare(`UPDATE supplier_contract_reviews SET status='superseded',updated_at=datetime('now') WHERE supplier_id=? AND status!='superseded'`).run(v.id);
      return db.prepare(`INSERT INTO supplier_inherent_assessments
        (workspace_id,supplier_id,methodology_version,methodology_id,methodology_snapshot_json,methodology_hash,assessment_type,status,due_date,created_by)
        VALUES (?,?,?,?,?,? ,?,'draft',?,?)`).run(req.workspace.id, v.id, methodSnapshot.methodologyVersion, methodSnapshot.methodologyId, methodSnapshot.methodologyJson, methodSnapshot.methodologyHash, assessmentType, req.body.due_date || null, req.user.id).lastInsertRowid;
    })();
    logAction(req.user.id, req.workspace.id, 'start_supplier_inherent_assessment', 'supplier_inherent_assessment', id, { supplierId: v.id }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/vendors/${v.id}/inherent-risk`);
  });

  app.post('/workspaces/:wsId/vendors/:id/inherent-risk', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const v = supplier(req.workspace.id, req.params.id);
    const assessment = v && currentInherent(v.id);
    if (!v || !assessment || assessment.status !== 'draft') return redirectBack(req, res, 'This assessment is locked while awaiting approval or after approval.', 'warn');
    const methodology = supplierMethodologies.forAssessment(db, assessment, req.workspace.id).definition;
    const upsert = db.prepare(`INSERT INTO supplier_inherent_responses
      (assessment_id,question_id,score,response_label,comment,updated_by)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(assessment_id,question_id) DO UPDATE SET score=excluded.score,response_label=excluded.response_label,comment=excluded.comment,updated_by=excluded.updated_by,updated_at=datetime('now'),row_version=row_version+1`);
    const answers = {};
    db.transaction(() => {
      for (const question of methodology.scoring.questions) {
        const raw = req.body[`score_${question.id}`];
        if (raw === undefined || raw === '') continue;
        const unknown = raw === 'unknown';
        const score = unknown ? null : Number(raw);
        const option = question.options.find(item => item.score === score);
        if (!unknown && (!Number.isInteger(score) || score < 0 || score > 5 || !option)) continue;
        const label = unknown ? question.unknownLabel : (option ? option.label : null);
        upsert.run(assessment.id, question.id, score, label, req.body[`comment_${question.id}`] || null, req.user.id);
        answers[question.id] = unknown ? 'unknown' : score;
      }
    })();
    const stored = inherentResponseMap(assessment.id);
    const fullAnswers = Object.fromEntries(Object.entries(stored).map(([id, row]) => [id, row.response_label === 'Unknown / Validation Required' ? 'unknown' : row.score]));
    const result = supplierRisk.scoreInherent(fullAnswers, methodology);
    const physical = supplierRisk.allowedChoice(req.body.physical_data_centre_applicability, ['yes', 'no', 'unknown'], assessment.physical_data_centre_applicability || 'unknown');
    const modules = supplierRisk.routeModules(result.answers, physical, methodology);
    const scopeResolved = physical !== 'unknown';
    const status = req.body.action === 'submit' && result.finalisable && scopeResolved ? 'submitted' : 'draft';
    db.prepare(`UPDATE supplier_inherent_assessments SET status=?,physical_data_centre_applicability=?,weighted_score=?,assigned_tier=?,mandatory_floors_json=?,module_applicability_json=?,unknown_count=?,submitted_at=CASE WHEN ?='submitted' THEN datetime('now') ELSE submitted_at END,updated_at=datetime('now') WHERE id=?`)
      .run(status, physical, result.weightedScore, result.assignedTier, JSON.stringify(result.triggeredFloors), JSON.stringify(modules), result.unknownQuestionIds.length + result.unansweredQuestionIds.length + (scopeResolved ? 0 : 1), status, assessment.id);
    logAction(req.user.id, req.workspace.id, 'update_supplier_inherent_assessment', 'supplier_inherent_assessment', assessment.id, { score: result.weightedScore, tier: result.assignedTier, finalisable: result.finalisable }, auditCtx(req));
    const message = req.body.action === 'submit' && (!result.finalisable || !scopeResolved)
      ? `Assessment saved, but ${result.unknownQuestionIds.length + result.unansweredQuestionIds.length + (scopeResolved ? 0 : 1)} input(s) must be resolved before submission.`
      : status === 'submitted' ? 'Inherent-risk assessment submitted for approval.' : 'Inherent-risk assessment saved.';
    res.redirect(withToast(`/workspaces/${req.workspace.id}/vendors/${v.id}/inherent-risk`, message));
  });

  app.post('/workspaces/:wsId/vendors/:id/inherent-risk/approve', requireAuth, requireWorkspace, requirePermission('supplier.approve'), (req, res) => {
    const v = supplier(req.workspace.id, req.params.id);
    const assessment = v && currentInherent(v.id);
    if (!v || !assessment || assessment.status !== 'submitted') return redirectBack(req, res, 'Submit a complete assessment before approval.', 'warn');
    const methodology = supplierMethodologies.forAssessment(db, assessment, req.workspace.id).definition;
    const rationale = String(req.body.approval_rationale || '').trim();
    if (!rationale) return redirectBack(req, res, 'Approval or return rationale is required.', 'warn');
    if (req.body.action === 'return') {
      db.prepare(`UPDATE supplier_inherent_assessments SET status='draft',submitted_at=NULL,updated_at=datetime('now') WHERE id=?`).run(assessment.id);
      logAction(req.user.id, req.workspace.id, 'return_supplier_inherent_assessment', 'supplier_inherent_assessment', assessment.id, { rationale }, auditCtx(req));
      return res.redirect(withToast(`/workspaces/${req.workspace.id}/vendors/${v.id}/inherent-risk`, 'Assessment returned for changes.'));
    }
    const responses = inherentResponseMap(assessment.id);
    const result = supplierRisk.scoreInherent(Object.fromEntries(Object.entries(responses).map(([id, row]) => [id, row.response_label === 'Unknown / Validation Required' ? 'unknown' : row.score])), methodology);
    if (!result.finalisable || assessment.physical_data_centre_applicability === 'unknown') return redirectBack(req, res, 'Unknown or unanswered inputs prevent approval.', 'warn');
    db.transaction(() => {
      db.prepare(`UPDATE supplier_inherent_assessments SET status='approved',weighted_score=?,assigned_tier=?,mandatory_floors_json=?,approved_at=datetime('now'),approved_by=?,approval_rationale=?,updated_at=datetime('now') WHERE id=?`)
        .run(result.weightedScore, result.assignedTier, JSON.stringify(result.triggeredFloors), req.user.id, rationale, assessment.id);
      db.prepare(`UPDATE suppliers SET inherent_risk_score=?,tier=?,last_assessed=date('now') WHERE id=? AND workspace_id=?`).run(result.weightedScore, result.assignedTier, v.id, req.workspace.id);
    })();
    logAction(req.user.id, req.workspace.id, 'approve_supplier_inherent_assessment', 'supplier_inherent_assessment', assessment.id, { score: result.weightedScore, tier: result.assignedTier, floors: result.triggeredFloors.map(floor => floor.id) }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/vendors/${v.id}`, `${supplierRisk.tierLabel(result.assignedTier, methodology)} approved. The required due-diligence scope is ready.`));
  });

  app.post('/workspaces/:wsId/vendors/:id/due-diligence/start', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const v = supplier(req.workspace.id, req.params.id);
    const inherent = v && currentInherent(v.id);
    if (!v || !inherent || inherent.status !== 'approved') return redirectBack(req, res, 'Approve inherent risk before issuing due diligence.', 'warn');
    const modules = parseModules(inherent.module_applicability_json);
    if (modules.some(module => module.applicability === 'Unknown / Validation Required')) return redirectBack(req, res, 'Resolve all conditional module applicability first.', 'warn');
    const dueDate = futureDueDate(req.body.due_date, req.workspace);
    if (!dueDate) return redirectBack(req, res, 'Set a due date of today or later before creating the vendor questionnaire.', 'warn');
    const existing = currentDdq(v.id);
    if (existing && !['complete', 'superseded'].includes(existing.status)) return res.redirect(`/workspaces/${req.workspace.id}/vendors/${v.id}/due-diligence`);
    if (existing) db.prepare(`UPDATE supplier_ddq_assessments SET status='superseded',updated_at=datetime('now') WHERE id=?`).run(existing.id);
    const methodologyRecord = supplierMethodologies.forAssessment(db, inherent, req.workspace.id, req.user.id);
    const methodSnapshot = supplierMethodologies.snapshot(methodologyRecord);
    const id = db.prepare(`INSERT INTO supplier_ddq_assessments
      (workspace_id,supplier_id,inherent_assessment_id,methodology_version,methodology_id,methodology_snapshot_json,methodology_hash,tier,assessment_type,status,modules_json,vendor_contact_name,vendor_contact_email,due_date,created_by)
      VALUES (?,?,?,?,?,?,?, ?,?,'draft',?,?,?,?,?)`).run(req.workspace.id, v.id, inherent.id, methodSnapshot.methodologyVersion, methodSnapshot.methodologyId, methodSnapshot.methodologyJson, methodSnapshot.methodologyHash, inherent.assigned_tier, inherent.assessment_type, inherent.module_applicability_json, req.body.vendor_contact_name || null, req.body.vendor_contact_email || v.contact || null, dueDate, req.user.id).lastInsertRowid;
    logAction(req.user.id, req.workspace.id, 'start_supplier_due_diligence', 'supplier_ddq_assessment', id, { supplierId: v.id, tier: inherent.assigned_tier }, auditCtx(req));
    res.redirect(`/workspaces/${req.workspace.id}/vendors/${v.id}/due-diligence`);
  });

  app.get('/workspaces/:wsId/vendors/:id/due-diligence', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const v = supplier(req.workspace.id, req.params.id);
    if (!v) return res.status(404).send('Supplier not found');
    const inherent = currentInherent(v.id);
    const assessment = currentDdq(v.id);
    const bundle = ddqBundle(assessment, req.workspace.client_name);
    const inviteLink = req.session && req.session.supplierDdqInvite && req.session.supplierDdqInvite.assessmentId === (assessment && assessment.id) ? req.session.supplierDdqInvite.url : null;
    if (inviteLink && req.session) delete req.session.supplierDdqInvite;
    const methodologyRecord = bundle ? bundle.methodologyRecord : supplierMethodologies.forAssessment(db, inherent, req.workspace.id, req.user.id);
    const methodology = methodologyRecord.definition;
    res.render('supplier_due_diligence', { user: req.user, ws: req.workspace, v, inherent, inherentModules: inherent ? parseModules(inherent.module_applicability_json) : [], bundle, methodology, methodologyRecord, inviteLink, tierLabel: (tier) => supplierRisk.tierLabel(tier, methodology), findings: supplierFindings(req.workspace.id, v.id) });
  });

  app.post('/workspaces/:wsId/vendors/:id/due-diligence/share', requireAuth, requireWorkspace, requirePermission('supplier.manage'), async (req, res) => {
    const v = supplier(req.workspace.id, req.params.id);
    const assessment = v && currentDdq(v.id);
    if (!v || !assessment) return redirectBack(req, res);
    if (['submitted', 'under_review', 'complete'].includes(assessment.status)) return redirectBack(req, res, 'This questionnaire is already submitted and cannot be reissued.', 'warn');
    const toEmail = String(req.body.vendor_contact_email || assessment.vendor_contact_email || '').trim();
    if (!toEmail) return redirectBack(req, res, 'Vendor email is required.', 'warn');
    const dueDate = futureDueDate(req.body.due_date || assessment.due_date, req.workspace);
    if (!dueDate) return redirectBack(req, res, 'Set a due date of today or later before issuing the secure questionnaire.', 'warn');
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiry = new Date(Date.now() + 30 * 86400000).toISOString();
    const bundle = ddqBundle(assessment, req.workspace.client_name);
    const questions = bundle.questions;
    const path = `/supplier-ddq/${token}`;
    const baseUrl = String(process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const url = `${baseUrl}${path}`;
    let delivery;
    try {
      delivery = await email.sendSupplierQuestionnaireEmail({
        toEmail, toName: req.body.vendor_contact_name || assessment.vendor_contact_name, supplierName: v.name,
        templateName: `${supplierRisk.tierLabel(assessment.tier, bundle.methodology)} due diligence`,
        templateDescription: `${questions.length} scoped questions, including conditional modules.`, questionCount: questions.length,
        workspaceName: req.workspace.client_name, workspaceId: req.workspace.id, firmId: req.workspace.firm_id,
        token, expiresAt: expiry, questionnaireId: assessment.id, startUrlOverride: url, dueDate,
      });
    } catch (error) {
      delivery = { ok: false, provider: null, id: null, error: error && error.message ? error.message : 'Email delivery failed.' };
      console.error('[supplier ddq email]', delivery.error);
    }
    const delivered = Boolean(delivery.ok && delivery.provider !== 'devnull');
    const previewOnly = Boolean(delivery.ok && delivery.provider === 'devnull');
    db.prepare(`UPDATE supplier_ddq_assessments SET status=?,vendor_contact_name=?,vendor_contact_email=?,due_date=?,
      token_hash=?,token_expires_at=?,issued_at=CASE WHEN ?='issued' THEN datetime('now') ELSE issued_at END,
      delivery_status=?,delivery_provider=?,delivery_error=?,email_outbox_id=?,last_delivery_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
      .run(delivered ? 'issued' : 'draft', req.body.vendor_contact_name || assessment.vendor_contact_name || null, toEmail, dueDate,
        delivered || previewOnly ? tokenHash : null, delivered || previewOnly ? expiry : null, delivered ? 'issued' : 'draft',
        delivered ? 'sent' : previewOnly ? 'preview' : 'failed', delivery.provider || null, delivery.error || null, delivery.id || null, assessment.id);
    if (req.session && (delivered || previewOnly)) req.session.supplierDdqInvite = { assessmentId: assessment.id, url };
    logAction(req.user.id, req.workspace.id, delivered ? 'issue_supplier_due_diligence' : 'attempt_supplier_due_diligence_delivery', 'supplier_ddq_assessment', assessment.id,
      { email: toEmail, dueDate, questions: questions.length, delivered, provider: delivery.provider || null, error: delivery.error || null }, auditCtx(req));
    const destination = `/workspaces/${req.workspace.id}/vendors/${v.id}/due-diligence`;
    if (delivered) return res.redirect(withToast(destination, `Questionnaire emailed to ${toEmail}.`, 'success'));
    if (previewOnly) return res.redirect(withToast(destination, 'No email provider is configured. A local preview link was created, but no email was delivered.', 'info'));
    return res.redirect(withToast(destination, `Email was not delivered${delivery.error ? `: ${delivery.error}` : '.'}`, 'error'));
  });

  app.post('/workspaces/:wsId/vendors/:id/due-diligence/review', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const v = supplier(req.workspace.id, req.params.id);
    const assessment = v && currentDdq(v.id);
    if (!v || !assessment) return redirectBack(req, res);
    if (!['submitted', 'under_review'].includes(assessment.status)) return redirectBack(req, res, 'Vendor submission is required before internal review.', 'warn');
    const bundle = ddqBundle(assessment, req.workspace.client_name);
    const existing = bundle.responseMap;
    const upsert = db.prepare(`INSERT INTO supplier_ddq_responses
      (assessment_id,question_id,response,detail,evidence_reference,evidence_date,evidence_owner,status,reviewer_conclusion,finding_id,reviewer_comments,reviewer_updated_at,reviewer_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)
      ON CONFLICT(assessment_id,question_id) DO UPDATE SET reviewer_conclusion=excluded.reviewer_conclusion,finding_id=excluded.finding_id,reviewer_comments=excluded.reviewer_comments,status=excluded.status,reviewer_updated_at=datetime('now'),reviewer_id=excluded.reviewer_id,row_version=row_version+1`);
    db.transaction(() => {
      for (const question of bundle.questions) {
        const row = existing[question.id] || {};
        const reviewer = supplierRisk.allowedChoice(req.body[`reviewer_${question.id}`], bundle.methodology.responses.reviewer, row.reviewer_conclusion || 'Not Reviewed');
        const findingId = cleanFindingId(req.body[`finding_${question.id}`] || row.finding_id, req.workspace.id, v.id);
        const comments = req.body[`reviewer_comments_${question.id}`] || row.reviewer_comments || null;
        const next = { ...row, reviewer_conclusion: reviewer, finding_id: findingId };
        const status = supplierRisk.evaluateDdqResponse(question, next);
        upsert.run(assessment.id, question.id, row.response || null, row.detail || null, row.evidence_reference || null, row.evidence_date || null, row.evidence_owner || null, status, reviewer, findingId, comments, req.user.id);
        linkFinding(findingId, v.id, question.domain || question.module || null);
      }
    })();
    const refreshed = ddqBundle(assessment, req.workspace.client_name);
    const canComplete = refreshed.progress.open === 0;
    const status = req.body.action === 'complete' && canComplete ? 'complete' : 'under_review';
    db.prepare(`UPDATE supplier_ddq_assessments SET status=?,completed_at=CASE WHEN ?='complete' THEN datetime('now') ELSE completed_at END,completed_by=CASE WHEN ?='complete' THEN ? ELSE completed_by END,updated_at=datetime('now') WHERE id=?`)
      .run(status, status, status, req.user.id, assessment.id);
    logAction(req.user.id, req.workspace.id, 'review_supplier_due_diligence', 'supplier_ddq_assessment', assessment.id, { status, open: refreshed.progress.open }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/vendors/${v.id}/due-diligence`, req.body.action === 'complete' && !canComplete ? `${refreshed.progress.open} item(s) still block completion.` : 'Due-diligence review saved.'));
  });

  app.get('/workspaces/:wsId/vendors/:id/due-diligence/evidence/:evidenceId', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const row = db.prepare(`SELECT e.* FROM supplier_ddq_evidence e JOIN supplier_ddq_assessments a ON a.id=e.assessment_id WHERE e.id=? AND a.supplier_id=? AND e.workspace_id=?`).get(req.params.evidenceId, req.params.id, req.workspace.id);
    if (!row) return res.status(404).send('Evidence not found');
    const filePath = resolveUploadPath(row.stored_path, req.workspace.firm_id);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Evidence file is unavailable');
    res.download(filePath, row.filename);
  });

  app.post('/workspaces/:wsId/vendors/:id/contract-review/start', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const v = supplier(req.workspace.id, req.params.id);
    if (!v) return res.status(404).send('Supplier not found');
    const inherent = currentInherent(v.id);
    if (!inherent || inherent.status !== 'approved') return redirectBack(req, res, 'Approve inherent risk before starting the contract review.', 'warn');
    const modules = moduleMap(parseModules(inherent.module_applicability_json));
    let review = currentContract(v.id);
    if (!review || review.status === 'complete') {
      if (review) db.prepare(`UPDATE supplier_contract_reviews SET status='superseded',updated_at=datetime('now') WHERE id=?`).run(review.id);
      db.prepare(`UPDATE supplier_contract_reviews SET status='superseded',updated_at=datetime('now') WHERE supplier_id=? AND status!='superseded'`).run(v.id);
      const methodologyRecord = supplierMethodologies.forAssessment(db, inherent, req.workspace.id, req.user.id);
      const methodSnapshot = supplierMethodologies.snapshot(methodologyRecord);
      const methodology = methodologyRecord.definition;
      const id = db.prepare(`INSERT INTO supplier_contract_reviews (workspace_id,supplier_id,inherent_assessment_id,methodology_version,methodology_id,methodology_snapshot_json,methodology_hash,agreement_reference,agreement_date,reviewer_id) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(req.workspace.id, v.id, inherent.id, methodSnapshot.methodologyVersion, methodSnapshot.methodologyId, methodSnapshot.methodologyJson, methodSnapshot.methodologyHash, req.body.agreement_reference || null, req.body.agreement_date || null, req.user.id).lastInsertRowid;
      const insert = db.prepare(`INSERT INTO supplier_contract_review_items (review_id,clause_id,required,status) VALUES (?,?,?,?)`);
      db.transaction(() => methodology.contractClauses.forEach(clause => {
        const required = supplierRisk.contractClauseRequired(clause, modules);
        insert.run(id, clause.id, required ? 1 : 0, required ? 'Not Reviewed' : 'Not Required');
      }))();
      review = db.prepare('SELECT * FROM supplier_contract_reviews WHERE id=?').get(id);
    }
    res.redirect(`/workspaces/${req.workspace.id}/vendors/${v.id}/contract-review`);
  });

  app.get('/workspaces/:wsId/vendors/:id/contract-review', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const v = supplier(req.workspace.id, req.params.id);
    if (!v) return res.status(404).send('Supplier not found');
    const review = currentContract(v.id);
    const bundle = contractBundle(review);
    res.render('supplier_contract_review', { user: req.user, ws: req.workspace, v, bundle, methodology: bundle ? bundle.methodology : supplierMethodologies.active(db, req.workspace.id, req.user.id).definition, findings: supplierFindings(req.workspace.id, v.id) });
  });

  app.post('/workspaces/:wsId/vendors/:id/contract-review', requireAuth, requireWorkspace, requirePermission('supplier.manage'), (req, res) => {
    const v = supplier(req.workspace.id, req.params.id);
    const review = v && currentContract(v.id);
    if (!v || !review || review.status === 'complete') return redirectBack(req, res);
    const bundle = contractBundle(review);
    const methodology = bundle.methodology;
    const upsert = db.prepare(`INSERT INTO supplier_contract_review_items (review_id,clause_id,required,status,contract_reference,reviewer_comments,finding_id,reviewed_at)
      VALUES (?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(review_id,clause_id) DO UPDATE SET required=excluded.required,status=excluded.status,contract_reference=excluded.contract_reference,reviewer_comments=excluded.reviewer_comments,finding_id=excluded.finding_id,reviewed_at=datetime('now'),row_version=row_version+1`);
    db.transaction(() => {
      for (const clause of methodology.contractClauses) {
        const required = req.body[`required_${clause.id}`] === '0' ? 0 : 1;
        const status = supplierRisk.allowedChoice(req.body[`status_${clause.id}`], methodology.responses.contract, required ? 'Not Reviewed' : 'Not Required');
        const findingId = cleanFindingId(req.body[`finding_${clause.id}`], req.workspace.id, v.id);
        upsert.run(review.id, clause.id, required, status, req.body[`reference_${clause.id}`] || null, req.body[`comments_${clause.id}`] || null, findingId);
        linkFinding(findingId, v.id, clause.category);
      }
    })();
    const refreshed = contractBundle(review);
    const status = req.body.action === 'complete' && refreshed.progress.open === 0 ? 'complete' : 'in_progress';
    db.prepare(`UPDATE supplier_contract_reviews SET status=?,completed_at=CASE WHEN ?='complete' THEN datetime('now') ELSE completed_at END,reviewer_id=?,updated_at=datetime('now') WHERE id=?`).run(status, status, req.user.id, review.id);
    logAction(req.user.id, req.workspace.id, 'update_supplier_contract_review', 'supplier_contract_review', review.id, { status, open: refreshed.progress.open }, auditCtx(req));
    res.redirect(withToast(`/workspaces/${req.workspace.id}/vendors/${v.id}/contract-review`, req.body.action === 'complete' && refreshed.progress.open ? `${refreshed.progress.open} clause(s) still block completion.` : 'Contract review saved.'));
  });

  app.get('/supplier-ddq/:token', (req, res) => {
    const hash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const assessment = db.prepare(`SELECT a.*,s.name AS supplier_name,w.client_name,w.brand_display_name
      FROM supplier_ddq_assessments a JOIN suppliers s ON s.id=a.supplier_id JOIN workspaces w ON w.id=a.workspace_id
      WHERE a.token_hash=?`).get(hash);
    if (!assessment || ['submitted', 'under_review', 'complete'].includes(assessment.status)) return res.render('external_supplier_ddq', { state: assessment ? (assessment.status === 'submitted' ? 'submitted' : 'done') : 'invalid' });
    if (!assessment.token_expires_at || new Date(assessment.token_expires_at) <= new Date()) return res.render('external_supplier_ddq', { state: 'expired' });
    db.prepare(`UPDATE supplier_ddq_assessments SET opened_at=COALESCE(opened_at,datetime('now')),status=CASE WHEN status='issued' THEN 'in_progress' ELSE status END WHERE id=?`).run(assessment.id);
    const bundle = ddqBundle(assessment, assessment.client_name);
    res.render('external_supplier_ddq', { state: 'open', assessment, bundle, methodology: bundle.methodology, query: req.query, token: req.params.token });
  });

  app.post('/supplier-ddq/:token/evidence/:questionId', resolveExternalDdq, qUploadAny, (req, res) => {
    const assessment = req._supplierDdq;
    const questionId = String(req.params.questionId || '');
    if (!assessment || ['submitted', 'under_review', 'complete'].includes(assessment.status)) {
      cleanupFiles(req.files);
      return finishEvidenceUpload(req, res, 409, { ok: false, message: 'This questionnaire is locked and no longer accepts evidence.' }, questionId);
    }
    if (!assessment.token_expires_at || new Date(assessment.token_expires_at) <= new Date()) {
      cleanupFiles(req.files);
      return finishEvidenceUpload(req, res, 410, { ok: false, message: 'This secure link has expired. Ask your assessment contact for a new link.' }, questionId);
    }

    const bundle = ddqBundle(assessment, assessment.client_name);
    const question = bundle.questions.find(item => item.id === questionId);
    if (!question) {
      cleanupFiles(req.files);
      return finishEvidenceUpload(req, res, 404, { ok: false, message: 'This question is not part of the issued assessment.' }, questionId);
    }
    if (req._uploadError) {
      cleanupFiles(req.files);
      return finishEvidenceUpload(req, res, 413, { ok: false, message: evidenceUploadMessage(req._uploadError) }, questionId);
    }

    const files = req.files || [];
    const rejected = [...(req._rejectedUploads || [])];
    const accepted = [];
    for (const file of files) {
      const inspection = uploadSecurity.validateUpload(file, questionnaireFileExtensions);
      if (!inspection.ok) {
        rejected.push(`${file.originalname}: ${inspection.message}`);
        cleanupFiles([file]);
      } else {
        accepted.push(file);
      }
    }
    if (!accepted.length) {
      const message = rejected.length
        ? `No files were accepted. ${rejected[0]}`
        : 'Choose at least one file before uploading.';
      return finishEvidenceUpload(req, res, 400, { ok: false, message, rejected }, questionId);
    }

    const insertEvidence = db.prepare(`INSERT INTO supplier_ddq_evidence
      (workspace_id,assessment_id,question_id,filename,stored_path,sha256,size_bytes,mime_type,source)
      VALUES (?,?,?,?,?,?,?,?, 'vendor')`);
    try {
      db.transaction(() => {
        for (const file of accepted) {
          const content = fs.readFileSync(file.path);
          insertEvidence.run(
            assessment.workspace_id, assessment.id, questionId, file.originalname,
            path.basename(file.path), crypto.createHash('sha256').update(content).digest('hex'),
            file.size, file.mimetype || null
          );
        }

        const filenames = db.prepare(`SELECT filename FROM supplier_ddq_evidence
          WHERE assessment_id=? AND question_id=? ORDER BY uploaded_at,id`).all(assessment.id, questionId).map(row => row.filename);
        const prior = bundle.responseMap[questionId] || {};
        const next = { ...prior, evidence_reference: [...new Set(filenames)].join(', ') || null };
        const status = supplierRisk.evaluateDdqResponse(question, next);
        db.prepare(`INSERT INTO supplier_ddq_responses
          (assessment_id,question_id,evidence_reference,status,reviewer_conclusion,vendor_updated_at)
          VALUES (?,?,?,?,'Not Reviewed',datetime('now'))
          ON CONFLICT(assessment_id,question_id) DO UPDATE SET
            evidence_reference=excluded.evidence_reference,status=excluded.status,
            vendor_updated_at=datetime('now'),row_version=row_version+1`)
          .run(assessment.id, questionId, next.evidence_reference, status);
        db.prepare(`UPDATE supplier_ddq_assessments SET status=CASE WHEN status='issued' THEN 'in_progress' ELSE status END,updated_at=datetime('now') WHERE id=?`).run(assessment.id);
      })();
    } catch (error) {
      cleanupFiles(accepted);
      console.error('[supplier ddq evidence]', error && error.message);
      return finishEvidenceUpload(req, res, 500, { ok: false, message: 'Evidence could not be retained. Your answers are unchanged; try again.' }, questionId);
    }

    const allFiles = db.prepare(`SELECT filename FROM supplier_ddq_evidence
      WHERE assessment_id=? AND question_id=? ORDER BY uploaded_at,id`).all(assessment.id, questionId).map(row => row.filename);
    logAction(0, assessment.workspace_id, 'external_supplier_ddq_evidence_upload', 'supplier_ddq_assessment', assessment.id,
      { supplierId: assessment.supplier_id, questionId, uploaded: accepted.map(file => file.originalname), rejected },
      { ip: req.ip || '', userAgent: req.get('user-agent') || '', requestId: req.id || null });
    const message = `${accepted.length} evidence file${accepted.length === 1 ? '' : 's'} uploaded${rejected.length ? `; ${rejected.length} file${rejected.length === 1 ? '' : 's'} rejected` : ''}.`;
    return finishEvidenceUpload(req, res, 200, { ok: true, message, files: allFiles, rejected }, questionId);
  });

  app.post('/supplier-ddq/:token', resolveExternalDdq, qUploadAny, (req, res) => {
    const assessment = req._supplierDdq;
    if (!assessment || ['submitted', 'under_review', 'complete'].includes(assessment.status)) {
      cleanupFiles(req.files);
      return res.render('external_supplier_ddq', { state: assessment ? (assessment.status === 'submitted' ? 'submitted' : 'done') : 'invalid' });
    }
    if (!assessment.token_expires_at || new Date(assessment.token_expires_at) <= new Date()) return res.render('external_supplier_ddq', { state: 'expired' });
    if (req._uploadError) {
      cleanupFiles(req.files);
      return res.status(413).render('external_supplier_ddq', { state: 'uploaderror', assessment, message: req._uploadError.code === 'LIMIT_FILE_SIZE' ? 'A file exceeded the 25 MB limit. No answers were saved.' : 'An attachment could not be processed. No answers were saved.' });
    }
    const bundle = ddqBundle(assessment, assessment.client_name);
    const existing = bundle.responseMap;
    const uploadedByQuestion = {};
    const insertEvidence = db.prepare(`INSERT INTO supplier_ddq_evidence (workspace_id,assessment_id,question_id,filename,stored_path,sha256,size_bytes,mime_type,source) VALUES (?,?,?,?,?,?,?,?, 'vendor')`);
    db.transaction(() => {
      for (const file of (req.files || [])) {
        const questionId = String(file.fieldname || '').replace(/^file_/, '');
        if (!bundle.questions.some(question => question.id === questionId)) { try { fs.unlinkSync(file.path); } catch (_) {} continue; }
        const content = fs.readFileSync(file.path);
        insertEvidence.run(assessment.workspace_id, assessment.id, questionId, file.originalname, path.basename(file.path), crypto.createHash('sha256').update(content).digest('hex'), file.size, file.mimetype || null);
        (uploadedByQuestion[questionId] = uploadedByQuestion[questionId] || []).push(file.originalname);
      }
    })();
    const upsert = db.prepare(`INSERT INTO supplier_ddq_responses
      (assessment_id,question_id,response,detail,evidence_reference,evidence_date,evidence_owner,status,reviewer_conclusion,vendor_updated_at)
      VALUES (?,?,?,?,?,?,?,?,'Not Reviewed',datetime('now'))
      ON CONFLICT(assessment_id,question_id) DO UPDATE SET response=excluded.response,detail=excluded.detail,evidence_reference=excluded.evidence_reference,evidence_date=excluded.evidence_date,evidence_owner=excluded.evidence_owner,status=excluded.status,vendor_updated_at=datetime('now'),row_version=row_version+1`);
    db.transaction(() => {
      for (const question of bundle.questions) {
        const prior = existing[question.id] || {};
        const attachedFiles = [...(bundle.evidenceMap[question.id] || []).map(file => file.filename), ...(uploadedByQuestion[question.id] || [])];
        const next = {
          ...prior,
          response: supplierRisk.allowedChoice(req.body[`response_${question.id}`], bundle.methodology.responses.vendor, prior.response || null),
          detail: req.body[`detail_${question.id}`] || prior.detail || null,
          // Evidence references are server-derived from retained uploads. Do not
          // trust a hidden/form value that could claim evidence which was never
          // uploaded and inspected.
          evidence_reference: [...new Set(attachedFiles)].join(', ') || prior.evidence_reference || null,
          // Retain any historic date, but vendors no longer enter or need one.
          evidence_date: prior.evidence_date || null,
          // Retain any historic owner, but vendors no longer enter or need one.
          evidence_owner: prior.evidence_owner || null,
        };
        const status = supplierRisk.evaluateDdqResponse(question, next);
        upsert.run(assessment.id, question.id, next.response, next.detail, next.evidence_reference, next.evidence_date, next.evidence_owner, status);
      }
    })();
    const refreshed = ddqBundle(assessment, assessment.client_name);
    const vendorOpenStatuses = ['Unanswered', 'Validation Required', 'N/A justification required', 'Evidence Missing'];
    const vendorBlockers = vendorOpenStatuses.reduce((count, status) => count + (refreshed.progress.counts[status] || 0), 0);
    const rejectedUploads = (req._rejectedUploads || []).length;
    if (req.body.action === 'submit' && vendorBlockers === 0 && rejectedUploads === 0) {
      db.prepare(`UPDATE supplier_ddq_assessments SET status='submitted',submitted_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(assessment.id);
      logAction(0, assessment.workspace_id, 'external_supplier_ddq_submit', 'supplier_ddq_assessment', assessment.id,
        { supplierId: assessment.supplier_id, responseRows: refreshed.questions.length, attachments: (req.files || []).length },
        { ip: req.ip || '', userAgent: req.get('user-agent') || '', requestId: req.id || null });
      return res.render('external_supplier_ddq', { state: 'submitted', assessment });
    }
    db.prepare(`UPDATE supplier_ddq_assessments SET status='in_progress',updated_at=datetime('now') WHERE id=?`).run(assessment.id);
    logAction(0, assessment.workspace_id, 'external_supplier_ddq_save', 'supplier_ddq_assessment', assessment.id,
      { supplierId: assessment.supplier_id, responseRows: refreshed.questions.length, attachments: (req.files || []).length, rejectedUploads },
      { ip: req.ip || '', userAgent: req.get('user-agent') || '', requestId: req.id || null });
    const query = new URLSearchParams();
    if (req.body.action === 'submit' && vendorBlockers) query.set('blocked', String(vendorBlockers));
    else query.set('saved', '1');
    if (rejectedUploads) query.set('rejected', String(rejectedUploads));
    res.redirect(`/supplier-ddq/${req.params.token}?${query}`);
  });
}

module.exports = { register };
