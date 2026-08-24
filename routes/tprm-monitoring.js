'use strict';

const crypto = require('crypto');
const express = require('express');
const rbac = require('../lib/rbac');
const monitoring = require('../lib/tprm-monitoring-connectors');
const tprmDomain = require('../lib/tprm-domain');
const serviceCapabilities = require('../lib/tprm-capabilities');
const { withToast, auditCtx } = require('../lib/http-helpers');

const PUBLIC_WEBHOOK_PATH = '/integrations/tprm/monitoring/:ingressKey';
const CONNECTOR_ROOT = wsId => `/workspaces/${wsId}/tprm/monitoring/connectors`;
const PAID_ADAPTERS = new Set(['securityscorecard', 'bitsight', 'riskrecon']);
const PUBLIC_PREBODY_WINDOW_MS = 60 * 1000;
const PUBLIC_PREBODY_CLIENT_LIMIT = 60;
const PUBLIC_PREBODY_SOCKET_LIMIT = 1000;
const PUBLIC_PREBODY_MAX_BUCKETS = 8192;
const publicPrebodyBuckets = new Map();

function titleCase(value, fallback = 'Not recorded') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function checked(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function assertNoCredentialFormFields(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s-]+/g, '_');
    const allowedReference = normalized === 'secret_reference';
    const credentialField = /(^|_)(secret|password|passphrase|api_key|apikey|access_token|refresh_token|authorization|credential|credentials|private_key|client_secret|webhook_secret)($|_)/.test(normalized);
    if (credentialField && !allowedReference) {
      throw new monitoring.TprmConnectorError(
        'TPRM_SECRET_MATERIAL_FORBIDDEN',
        'Credential material cannot be submitted to Nimbus. Provide only an external secret-store reference.',
        400
      );
    }
    assertNoCredentialFormFields(nested, depth + 1);
  }
}

function publicErrorStatus(error) {
  const status = Number(error && error.status);
  if ([400, 401, 404, 409, 413, 429, 503].includes(status)) return status;
  return 503;
}

function publicErrorMessage(status) {
  if (status === 401) return 'Webhook authentication failed.';
  if (status === 413) return 'Webhook delivery is too large.';
  if (status === 429) return 'Webhook delivery is temporarily rate limited.';
  if (status === 409) return 'Webhook delivery conflicts with a previously accepted event.';
  if (status === 400) return 'Webhook delivery is not valid.';
  if (status === 404) return 'Webhook endpoint was not found.';
  return 'Webhook delivery could not be accepted.';
}

function publicResponseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function normalizedAddress(value) {
  return String(value || 'unknown').trim().toLowerCase().replace(/^::ffff:/, '').slice(0, 160);
}

function consumePublicPrebodyBucket(key, limit, nowMs) {
  const windowStart = Math.floor(nowMs / PUBLIC_PREBODY_WINDOW_MS) * PUBLIC_PREBODY_WINDOW_MS;
  const current = publicPrebodyBuckets.get(key);
  if (!current || current.windowStart !== windowStart) {
    if (publicPrebodyBuckets.size >= PUBLIC_PREBODY_MAX_BUCKETS) {
      for (const [candidate, bucket] of publicPrebodyBuckets) {
        if (bucket.windowStart < windowStart) publicPrebodyBuckets.delete(candidate);
      }
      while (publicPrebodyBuckets.size >= PUBLIC_PREBODY_MAX_BUCKETS) {
        publicPrebodyBuckets.delete(publicPrebodyBuckets.keys().next().value);
      }
    }
    publicPrebodyBuckets.set(key, { windowStart, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

// This limiter runs before express.raw. The socket-wide budget cannot be
// bypassed with a forged forwarding header; the smaller logical-client budget
// keeps one caller from monopolising a trusted reverse proxy.
function consumePublicPrebodyBudget(req, nowMs = Date.now()) {
  const socketAddress = normalizedAddress(req.socket && req.socket.remoteAddress);
  const clientAddress = normalizedAddress(req.ip || socketAddress);
  const socketAllowed = consumePublicPrebodyBucket(`socket:${socketAddress}`, PUBLIC_PREBODY_SOCKET_LIMIT, nowMs);
  const clientAllowed = consumePublicPrebodyBucket(`client:${socketAddress}:${clientAddress}`, PUBLIC_PREBODY_CLIENT_LIMIT, nowMs);
  return socketAllowed && clientAllowed;
}

function resetPublicPrebodyLimiterForTests() {
  publicPrebodyBuckets.clear();
}

/**
 * This endpoint owns a strict raw-body parser and is registered before the
 * application's general JSON parser. Oversized bodies are rejected before
 * JSON allocation, while the exact signed bytes remain available for HMAC
 * verification. The CSRF layer exempts only this authenticated public path.
 */
function registerPublic(app, deps) {
  const { db } = deps;
  const secretResolver = deps.secretResolver || deps.resolveTprmSecretReference;
  const rawJson = express.raw({
    type: ['application/json', 'application/*+json'],
    limit: 1024 * 1024,
  });

  // Resolve the opaque locator and enforce bounded IP budgets before reading
  // a single request-body byte. Unknown/random endpoints therefore cannot use
  // the JSON parser as an unauthenticated memory/CPU sink.
  app.post(PUBLIC_WEBHOOK_PATH, (req, res, next) => {
    publicResponseHeaders(res);
    const ingressKey = String(req.params.ingressKey || '').trim().toLowerCase();
    if (!consumePublicPrebodyBudget(req)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ accepted: false, message: publicErrorMessage(429) });
    }
    if (!/^[a-f0-9]{32}$/.test(ingressKey)) {
      return res.status(404).json({ accepted: false, message: publicErrorMessage(404) });
    }
    const connector = db.prepare(`SELECT c.id,c.workspace_id FROM tprm_monitoring_connectors c
      INNER JOIN tprm_modules m ON m.workspace_id=c.workspace_id AND m.id=c.module_id
      WHERE c.ingress_key=? AND c.status='active' AND m.status='active'
      AND c.capability_mode='webhook' LIMIT 1`).get(ingressKey);
    if (!connector) return res.status(404).json({ accepted: false, message: publicErrorMessage(404) });
    req.tprmPublicConnector = connector;
    return next();
  }, rawJson, (req, res) => {
    publicResponseHeaders(res);
    const contentType = String(req.get('content-type') || '').trim();
    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
    if (!/^application\/(?:json|[^;]+\+json)(?:\s*;|$)/i.test(contentType)
        || !rawBody || !rawBody.length) {
      return res.status(400).json({ accepted: false, message: publicErrorMessage(400) });
    }
    const connector = req.tprmPublicConnector;

    try {
      monitoring.consumeWebhookIngressBudget(db, {
        workspaceId: connector.workspace_id,
        connectorId: connector.id,
        sourceIdentifier: req.ip || req.socket && req.socket.remoteAddress || 'unknown',
      });
      const result = monitoring.ingestWebhook(db, {
        workspaceId: connector.workspace_id,
        connectorId: connector.id,
        rawBody,
        signature: req.get('x-nimbus-signature') || req.get('x-signature-256'),
        timestamp: req.get('x-nimbus-timestamp') || req.get('x-signature-timestamp'),
        idempotencyKey: req.get('idempotency-key') || undefined,
        sourceIdentifier: req.ip || req.socket && req.socket.remoteAddress || 'unknown',
        secretResolver,
      });
      const disposition = result.status === 'processed' ? 'processed'
        : result.status === 'duplicate' ? 'duplicate'
          : result.status === 'quarantined' ? 'quarantined_for_review' : 'accepted_for_review';
      return res.status(202).json({
        accepted: true,
        disposition,
      });
    } catch (error) {
      const status = publicErrorStatus(error);
      if (status === 429 && error && error.details && error.details.nextAllowedAt) {
        const seconds = Math.max(1, Math.ceil((new Date(error.details.nextAllowedAt).getTime() - Date.now()) / 1000));
        if (Number.isFinite(seconds)) res.setHeader('Retry-After', String(seconds));
      }
      // Public responses deliberately omit internal error codes, secret-store
      // references, stack traces, connector names and tenant information.
      return res.status(status).json({ accepted: false, message: publicErrorMessage(status) });
    }
  });

  // Route-local raw-parser failures never fall through to the application's
  // larger general JSON parser or disclose parser details.
  app.use(PUBLIC_WEBHOOK_PATH, (error, req, res, next) => {
    if (req.method !== 'POST') return next(error);
    const status = error && error.type === 'entity.too.large' ? 413 : 400;
    publicResponseHeaders(res);
    return res.status(status).json({ accepted: false, message: publicErrorMessage(status) });
  });
}

function register(app, deps) {
  const { db, requireAuth, requireWorkspace, requirePermission, logAction } = deps;
  const csvUpload = deps.csvUpload && typeof deps.csvUpload.single === 'function'
    ? deps.csvUpload.single('file') : (_req, _res, next) => next();

  function permissionsForRequest(req, res) {
    return req.userPerms || res.locals.userPerms
      || rbac.rolePermissions(req.workspace && req.workspace._userRole || req.user && req.user.firm_role);
  }

  function requireFirm(req, res, next) {
    if (!req.user || req.user.user_type !== 'firm') {
      return res.status(403).render('error', {
        user: req.user || null,
        ws: req.workspace || null,
        message: 'Monitoring configuration is restricted to the consulting team.',
      });
    }
    return next();
  }

  function requireActiveModule(req, res, next) {
    try {
      const state = serviceCapabilities.assertCapability(
        db, req.workspace.id, serviceCapabilities.CAPABILITIES.MONITORING_CONNECTORS
      );
      req.tprmModule = state.module;
      res.locals.tprmModule = { row: state.module, enabled: true, readOnly: false, closed: false };
      res.locals.tprmPolicy = state.policy;
      return next();
    } catch (error) {
      if (!(error instanceof serviceCapabilities.TprmCapabilityError)) return next(error);
      return res.status(error.status).render('error', {
        user: req.user,
        ws: req.workspace,
        message: error.message,
      });
    }
  }

  function requireReadableModule(req, res, next) {
    const module = db.prepare(`SELECT * FROM tprm_modules
      WHERE workspace_id=? ORDER BY id DESC LIMIT 1`).get(req.workspace.id);
    if (!module) {
      return res.status(404).render('error', {
        user: req.user,
        ws: req.workspace,
        message: 'Third-party risk is not enabled for this client.',
      });
    }
    req.tprmModule = module;
    res.locals.tprmModule = {
      row: module,
      enabled: true,
      readOnly: module.status !== 'active',
      closed: module.status === 'closed',
      activationRequired: module.status === 'needs_classification',
    };
    res.locals.tprmPolicy = serviceCapabilities.policyForModule(module);
    return next();
  }

  function scopedConnector(workspaceId, connectorId) {
    return db.prepare(`SELECT * FROM tprm_monitoring_connectors
      WHERE workspace_id=? AND id=?`).get(workspaceId, connectorId) || null;
  }

  function transportStatus(connector) {
    if (!PAID_ADAPTERS.has(connector.provider_type)) {
      return { provisioned: true, label: 'Nimbus intake implemented' };
    }
    if (typeof deps.monitoringTransportStatus !== 'function') {
      return { provisioned: false, label: 'Provider transport not provisioned' };
    }
    try {
      const value = deps.monitoringTransportStatus({
        workspaceId: connector.workspace_id,
        connectorId: connector.id,
        providerType: connector.provider_type,
      });
      if (value && typeof value.then === 'function') return { provisioned: false, label: 'Provider transport status unavailable' };
      if (value === true) return { provisioned: true, label: 'Provider transport provisioned' };
      if (value && value.provisioned === true) return { provisioned: true, label: value.label || 'Provider transport provisioned' };
      return { provisioned: false, label: value && value.label || 'Provider transport not provisioned' };
    } catch (_) {
      return { provisioned: false, label: 'Provider transport status unavailable' };
    }
  }

  function adapterState(connector) {
    const adapter = monitoring.getAdapter(connector.provider_type);
    const transport = transportStatus(connector);
    const health = monitoring.connectorHealth(db, connector.workspace_id, connector.id);
    const externallyProvisioned = Boolean(connector.external_provisioning_confirmed);
    const honestConnected = Boolean(health.connected && (
      adapter.integrationState === 'implemented'
      || (transport.provisioned && externallyProvisioned)
    ));
    let connectionLabel = 'No successful intake yet';
    if (connector.status === 'draft') connectionLabel = 'Draft, not receiving data';
    else if (connector.status === 'paused') connectionLabel = 'Paused';
    else if (connector.status === 'disabled') connectionLabel = 'Disabled';
    else if (honestConnected) connectionLabel = 'Connected and verified by a successful run';
    else if (adapter.integrationState !== 'implemented' && !transport.provisioned) connectionLabel = 'Adapter contract only, transport unavailable';
    else if (health.health === 'unhealthy') connectionLabel = 'Active but unhealthy';
    else if (health.health === 'degraded') connectionLabel = 'Active with quarantined or partial intake';
    return {
      ...connector,
      adapter,
      transport,
      health,
      connected: honestConnected,
      connectionLabel,
      canActivate: adapter.integrationState === 'implemented' || transport.provisioned,
      secretReferenceDisplay: connector.secret_reference
        ? `${String(connector.secret_reference).split('://')[0]}://…${monitoring.sha256(connector.secret_reference).slice(-8)}`
        : null,
      webhookPath: connector.capability_mode === 'webhook'
        ? `/integrations/tprm/monitoring/${connector.ingress_key}` : null,
    };
  }

  function connectorRows(workspaceId) {
    return db.prepare(`SELECT * FROM tprm_monitoring_connectors
      WHERE workspace_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,name,id`).all(workspaceId)
      .map(adapterState);
  }

  function selectedData(workspaceId, connector) {
    if (!connector) return {
      mappings: [], rules: [], runs: [], signals: [], receivedEvents: [], queue: [], audit: [],
      eventChain: { valid: true, checked: 0 }, auditChain: { valid: true, checked: 0 },
    };
    const params = [workspaceId, connector.id];
    const mappings = db.prepare(`SELECT m.*,s.name AS supplier_name,u.name AS created_by_name
      FROM tprm_connector_supplier_mappings m
      INNER JOIN suppliers s ON s.workspace_id=m.workspace_id AND s.id=m.supplier_id
      LEFT JOIN users u ON u.id=m.created_by
      WHERE m.workspace_id=? AND m.connector_id=? ORDER BY m.active DESC,m.provider_entity_id,m.id DESC`).all(...params);
    const rules = db.prepare(`SELECT r.*,u.name AS created_by_name FROM tprm_monitoring_rules r
      LEFT JOIN users u ON u.id=r.created_by
      WHERE r.workspace_id=? AND r.connector_id=? ORDER BY r.enabled DESC,r.rule_key,r.version DESC`).all(...params);
    const runs = db.prepare(`SELECT * FROM tprm_monitoring_connector_runs
      WHERE workspace_id=? AND connector_id=? ORDER BY completed_at DESC,id DESC LIMIT 30`).all(...params);
    const signals = db.prepare(`SELECT signal.*,supplier.name AS supplier_name,user.name AS triaged_by_name
      FROM tprm_monitoring_signals signal
      INNER JOIN suppliers supplier
        ON supplier.workspace_id=signal.workspace_id AND supplier.id=signal.supplier_id
      LEFT JOIN users user ON user.id=signal.triaged_by
      WHERE signal.workspace_id=? AND signal.source=?
      ORDER BY CASE signal.status WHEN 'new' THEN 0 ELSE 1 END,
        CASE signal.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END,
        signal.observed_at DESC,signal.id DESC LIMIT 100`).all(
      workspaceId, `connector:${connector.provider_type}:${connector.id}`
    );
    const receivedEvents = db.prepare(`SELECT e.id,e.provider_event_id,e.provider_entity_id,e.supplier_id,
      e.observed_at,e.received_at,e.payload_hash,e.event_hash,s.name AS supplier_name,
      a.status AS latest_status,a.error_code,a.error_redacted,a.retryable,a.completed_at AS processed_at
      FROM tprm_monitoring_received_events e
      LEFT JOIN suppliers s ON s.workspace_id=e.workspace_id AND s.id=e.supplier_id
      LEFT JOIN tprm_monitoring_processing_attempts a ON a.id=(
        SELECT a2.id FROM tprm_monitoring_processing_attempts a2
        WHERE a2.received_event_id=e.id ORDER BY a2.attempt_number DESC,a2.id DESC LIMIT 1
      )
      WHERE e.workspace_id=? AND e.connector_id=? ORDER BY e.received_at DESC,e.id DESC LIMIT 100`).all(...params);
    const queue = db.prepare(`SELECT q.*,s.name AS supplier_name,e.connector_id
      FROM tprm_reassessment_queue q
      INNER JOIN suppliers s ON s.workspace_id=q.workspace_id AND s.id=q.supplier_id
      INNER JOIN tprm_monitoring_received_events e ON e.workspace_id=q.workspace_id AND e.id=q.received_event_id
      WHERE q.workspace_id=? AND e.connector_id=?
      ORDER BY CASE q.status WHEN 'manual_review' THEN 0 WHEN 'pending' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END,
      CASE q.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END,q.created_at`).all(...params);
    const audit = db.prepare(`SELECT a.*,u.name AS actor_display_name FROM tprm_monitoring_connector_audit a
      LEFT JOIN users u ON u.id=a.actor_user_id
      WHERE a.workspace_id=? AND a.connector_id=? ORDER BY a.id DESC LIMIT 50`).all(...params);
    return {
      mappings, rules, runs, signals, receivedEvents, queue, audit,
      eventChain: monitoring.verifyReceivedEventChain(db, workspaceId, connector.id),
      auditChain: monitoring.verifyConnectorAuditChain(db, workspaceId, connector.id),
    };
  }

  function renderPage(req, res, options = {}) {
    const connectors = connectorRows(req.workspace.id);
    const requested = positiveInteger(options.connectorId || req.query.connector);
    const selected = requested ? connectors.find(row => row.id === requested) || null : connectors[0] || null;
    if (requested && !selected) {
      return res.status(404).render('error', {
        user: req.user,
        ws: req.workspace,
        message: 'Monitoring connector not found for this client.',
      });
    }
    const detail = selectedData(req.workspace.id, selected);
    const permissions = permissionsForRequest(req, res);
    const tprmPolicy = serviceCapabilities.policyForModule(req.tprmModule);
    const suppliers = db.prepare(`SELECT id,name,service_provided FROM suppliers
      WHERE workspace_id=? AND archived_at IS NULL ORDER BY name,id`).all(req.workspace.id);
    const adapters = monitoring.listAdapters().map(adapter => ({
      ...adapter,
      available: adapter.integrationState === 'implemented',
      availabilityLabel: adapter.integrationState === 'implemented'
        ? 'Implemented in Nimbus' : 'Adapter contract only; transport must be separately provisioned',
    }));
    const summary = {
      configured: connectors.length,
      connected: connectors.filter(row => row.connected).length,
      attention: connectors.filter(row => ['unhealthy', 'degraded'].includes(row.health.health)).length,
      queued: detail.queue.filter(row => row.status !== 'completed').length,
    };
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    return res.status(options.status || 200).render('tprm_connector_settings', {
      user: req.user,
      ws: req.workspace,
      active: 'tprm-monitoring',
      canSettings: req.user.user_type === 'firm' && rbac.isManager(req.user.firm_role),
      canManage: tprmPolicy.capabilities[serviceCapabilities.CAPABILITIES.MONITORING_CONNECTORS].allowed
        && req.user.user_type === 'firm'
        && rbac.hasPermission(permissions, 'tprm.monitoring.manage'),
      tprmPolicy,
      tprmCapabilities: serviceCapabilities.CAPABILITIES,
      connectors,
      selected,
      suppliers,
      adapters,
      summary,
      detail,
      importResult: options.importResult || null,
      failurePolicy: monitoring.FAILURE_POLICY,
      runtimeSecretResolverConfigured: Boolean(deps.secretResolver || deps.resolveTprmSecretReference),
      titleCase,
      dateOnly,
      nonce: () => crypto.randomBytes(24).toString('hex'),
    });
  }

  function redirectError(req, res, connectorId, error) {
    const safe = error instanceof monitoring.TprmConnectorError
      ? error.message : 'The monitoring change could not be completed. No governed records were changed.';
    const root = CONNECTOR_ROOT(req.workspace.id);
    const target = connectorId ? `${root}?connector=${connectorId}` : root;
    return res.redirect(303, withToast(target, safe, 'error'));
  }

  function record(req, action, entityType, entityId, details) {
    if (typeof logAction === 'function') {
      logAction(req.user.id, req.workspace.id, action, entityType, entityId, details || {}, auditCtx(req));
    }
  }

  const viewChain = [requireAuth, requireWorkspace, requirePermission('tprm.third_party.view'), requireFirm, requireReadableModule];
  const mutationChain = [requireAuth, requireWorkspace, requirePermission('tprm.monitoring.manage'), requireFirm, requireActiveModule];

  app.get('/workspaces/:wsId/tprm/monitoring/connectors', ...viewChain, (req, res) => renderPage(req, res));

  app.post('/workspaces/:wsId/tprm/monitoring/connectors', ...mutationChain, (req, res) => {
    try {
      assertNoCredentialFormFields(req.body);
      const providerType = String(req.body.provider_type || '').trim().toLowerCase();
      const adapter = monitoring.getAdapter(providerType);
      const capabilityMode = providerType === 'csv_import' ? 'csv'
        : adapter.integrationState === 'implemented' ? 'webhook'
          : String(req.body.capability_mode || 'webhook').trim().toLowerCase();
      const startActive = checked(req.body.start_active);
      if (startActive && adapter.integrationState !== 'implemented') {
        const probe = transportStatus({
          id: 0, workspace_id: req.workspace.id, provider_type: providerType,
        });
        if (!probe.provisioned) {
          throw new monitoring.TprmConnectorError(
            'TPRM_TRANSPORT_NOT_PROVISIONED',
            'This paid provider adapter cannot be activated until a real transport is provisioned and verified.',
            409
          );
        }
      }
      const adapterConfig = {};
      if (String(req.body.accepted_schema || '').trim()) adapterConfig.acceptedSchema = String(req.body.accepted_schema).trim();
      if (String(req.body.source_environment || '').trim()) adapterConfig.sourceEnvironment = String(req.body.source_environment).trim();
      if (String(req.body.provider_account_reference || '').trim()) adapterConfig.providerAccountReference = String(req.body.provider_account_reference).trim();
      const connector = monitoring.createConnector(db, {
        workspaceId: req.workspace.id,
        actorId: req.user.id,
        providerType,
        capabilityMode,
        name: req.body.name,
        status: startActive ? 'active' : 'draft',
        secretReference: providerType === 'csv_import' ? null : req.body.secret_reference,
        adapterConfig,
        externalProvisioningConfirmed: adapter.integrationState !== 'implemented'
          && checked(req.body.external_provisioning_confirmed),
      });
      record(req, 'create_tprm_monitoring_connector', 'tprm_monitoring_connector', connector.id, {
        providerType: connector.provider_type,
        capabilityMode: connector.capability_mode,
        status: connector.status,
      });
      return res.redirect(303, withToast(`${CONNECTOR_ROOT(req.workspace.id)}?connector=${connector.id}`, 'Monitoring connector created.', 'success'));
    } catch (error) {
      return redirectError(req, res, null, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/monitoring/connectors/:connectorId/status', ...mutationChain, (req, res) => {
    const connectorId = positiveInteger(req.params.connectorId);
    try {
      const connector = scopedConnector(req.workspace.id, connectorId);
      if (!connector) throw new monitoring.TprmConnectorError('TPRM_CONNECTOR_NOT_FOUND', 'Monitoring connector not found for this client.', 404);
      const target = String(req.body.status || '').trim().toLowerCase();
      if (target === 'active' && PAID_ADAPTERS.has(connector.provider_type)) {
        const transport = transportStatus(connector);
        if (!transport.provisioned) {
          throw new monitoring.TprmConnectorError(
            'TPRM_TRANSPORT_NOT_PROVISIONED',
            'This adapter remains unavailable because no verified provider transport is provisioned.',
            409
          );
        }
      }
      const updated = monitoring.updateConnectorStatus(db, {
        workspaceId: req.workspace.id,
        connectorId,
        actorId: req.user.id,
        status: target,
        externalProvisioningConfirmed: checked(req.body.external_provisioning_confirmed),
        reason: req.body.reason,
      });
      record(req, 'change_tprm_monitoring_connector_status', 'tprm_monitoring_connector', connectorId, {
        from: connector.status,
        to: updated.status,
      });
      return res.redirect(303, withToast(`${CONNECTOR_ROOT(req.workspace.id)}?connector=${connectorId}`, `Connector ${target}.`, 'success'));
    } catch (error) {
      return redirectError(req, res, connectorId, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/monitoring/connectors/:connectorId/secret-reference', ...mutationChain, (req, res) => {
    const connectorId = positiveInteger(req.params.connectorId);
    try {
      assertNoCredentialFormFields(req.body);
      const result = monitoring.rotateSecretReference(db, {
        workspaceId: req.workspace.id,
        connectorId,
        actorId: req.user.id,
        secretReference: req.body.secret_reference,
      });
      record(req, 'rotate_tprm_monitoring_secret_reference', 'tprm_monitoring_connector', connectorId, {
        changed: result.changed,
      });
      return res.redirect(303, withToast(`${CONNECTOR_ROOT(req.workspace.id)}?connector=${connectorId}`, result.changed ? 'Secret-store reference rotated.' : 'Secret-store reference is unchanged.', result.changed ? 'success' : 'info'));
    } catch (error) {
      return redirectError(req, res, connectorId, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/monitoring/connectors/:connectorId/mappings', ...mutationChain, (req, res) => {
    const connectorId = positiveInteger(req.params.connectorId);
    try {
      const mapping = monitoring.createSupplierMapping(db, {
        workspaceId: req.workspace.id,
        connectorId,
        actorId: req.user.id,
        supplierId: req.body.supplier_id,
        providerEntityId: req.body.provider_entity_id,
        mappingNote: req.body.mapping_note,
      });
      record(req, 'create_tprm_monitoring_mapping', 'tprm_connector_supplier_mapping', mapping.id, {
        connectorId,
        supplierId: mapping.supplier_id,
      });
      return res.redirect(303, withToast(`${CONNECTOR_ROOT(req.workspace.id)}?connector=${connectorId}#mappings`, 'Provider identifier mapped to the selected third party.', 'success'));
    } catch (error) {
      return redirectError(req, res, connectorId, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/monitoring/connectors/:connectorId/mappings/:mappingId/retire', ...mutationChain, (req, res) => {
    const connectorId = positiveInteger(req.params.connectorId);
    try {
      const result = monitoring.retireSupplierMapping(db, {
        workspaceId: req.workspace.id,
        connectorId,
        mappingId: req.params.mappingId,
        actorId: req.user.id,
        reason: req.body.reason,
      });
      record(req, 'retire_tprm_monitoring_mapping', 'tprm_connector_supplier_mapping', req.params.mappingId, {
        connectorId,
        changed: result.changed,
      });
      return res.redirect(303, withToast(`${CONNECTOR_ROOT(req.workspace.id)}?connector=${connectorId}#mappings`, result.changed ? 'Mapping retired. Historic events remain unchanged.' : 'Mapping was already retired.', result.changed ? 'success' : 'info'));
    } catch (error) {
      return redirectError(req, res, connectorId, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/monitoring/connectors/:connectorId/rules', ...mutationChain, (req, res) => {
    const connectorId = positiveInteger(req.params.connectorId);
    try {
      const operator = String(req.body.operator || '').trim().toLowerCase();
      let threshold;
      if (operator !== 'exists') {
        const kind = String(req.body.threshold_type || 'string').trim().toLowerCase();
        if (kind === 'number') threshold = Number(req.body.threshold);
        else if (kind === 'boolean') threshold = String(req.body.threshold).trim().toLowerCase() === 'true';
        else threshold = String(req.body.threshold == null ? '' : req.body.threshold);
      }
      const rule = monitoring.createRule(db, {
        workspaceId: req.workspace.id,
        connectorId,
        actorId: req.user.id,
        ruleKey: req.body.rule_key,
        metricPath: req.body.metric_path,
        operator,
        threshold,
        signalType: req.body.signal_type,
        severity: req.body.severity,
        requiresReassessment: checked(req.body.requires_reassessment),
        missingBehavior: req.body.missing_behavior,
        title: req.body.title,
      });
      record(req, 'create_tprm_monitoring_rule', 'tprm_monitoring_rule', rule.id, {
        connectorId,
        ruleKey: rule.rule_key,
        version: rule.version,
        requiresReassessment: Boolean(rule.requires_reassessment),
      });
      return res.redirect(303, withToast(`${CONNECTOR_ROOT(req.workspace.id)}?connector=${connectorId}#rules`, `Monitoring rule v${rule.version} published.`, 'success'));
    } catch (error) {
      return redirectError(req, res, connectorId, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/monitoring/connectors/:connectorId/import', ...mutationChain, csvUpload, (req, res) => {
    const connectorId = positiveInteger(req.params.connectorId);
    try {
      const connector = scopedConnector(req.workspace.id, connectorId);
      if (!connector) throw new monitoring.TprmConnectorError('TPRM_CONNECTOR_NOT_FOUND', 'Monitoring connector not found for this client.', 404);
      if (connector.provider_type !== 'csv_import') {
        throw new monitoring.TprmConnectorError('TPRM_CONNECTOR_MODE_INVALID', 'This connector does not accept CSV imports.', 409);
      }
      const csvText = req.file && req.file.buffer
        ? req.file.buffer.toString('utf8') : String(req.body && req.body.csv_text || '');
      const result = monitoring.ingestCsvRows(db, {
        workspaceId: req.workspace.id,
        connectorId,
        csvText,
        csvOptions: { maxBytes: 5 * 1024 * 1024, maxRows: 10000, maxColumns: 200 },
      });
      record(req, 'import_tprm_monitoring_csv', 'tprm_monitoring_connector_run', result.connectorRun.id, {
        connectorId,
        status: result.status,
        counts: result.counts,
      });
      return renderPage(req, res, { connectorId, importResult: result });
    } catch (error) {
      return redirectError(req, res, connectorId, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/monitoring/reassessment/:queueId/process', ...mutationChain, (req, res) => {
    const queueId = positiveInteger(req.params.queueId);
    const row = db.prepare('SELECT * FROM tprm_reassessment_queue WHERE workspace_id=? AND id=?')
      .get(req.workspace.id, queueId);
    const connectorId = row && db.prepare(`SELECT connector_id FROM tprm_monitoring_received_events
      WHERE workspace_id=? AND id=?`).get(req.workspace.id, row.received_event_id)?.connector_id;
    try {
      if (!row) throw new monitoring.TprmConnectorError('TPRM_REASSESSMENT_QUEUE_NOT_FOUND', 'Reassessment request not found for this client.', 404);
      const result = monitoring.processReassessmentQueueItem(db, {
        workspaceId: req.workspace.id,
        queueId,
        actorId: req.user.id,
      });
      record(req, 'process_tprm_reassessment_queue', 'tprm_reassessment_queue', queueId, {
        processed: result.processed,
        failedClosed: Boolean(result.failedClosed),
        resultingCycleId: result.cycle && result.cycle.id || null,
      });
      const message = result.processed
        ? 'Triggered reassessment cycle created.'
        : result.failedClosed
          ? 'Processing failed closed. The request remains queued for retry or manual review.'
          : 'This reassessment request was already processed.';
      return res.redirect(303, withToast(`${CONNECTOR_ROOT(req.workspace.id)}?connector=${connectorId || ''}#reassessment`, message, result.failedClosed ? 'error' : 'success'));
    } catch (error) {
      return redirectError(req, res, connectorId, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/monitoring/reassessment/:queueId/retry', ...mutationChain, (req, res) => {
    const queueId = positiveInteger(req.params.queueId);
    let connectorId = null;
    try {
      const reason = String(req.body.reason || '').trim();
      if (reason.length < 10 || reason.length > 1000) {
        throw new monitoring.TprmConnectorError('TPRM_MANUAL_REVIEW_REASON_INVALID', 'Record a 10 to 1,000 character manual-review resolution before returning work to the queue.', 400);
      }
      const row = db.prepare(`SELECT q.*,e.connector_id FROM tprm_reassessment_queue q
        INNER JOIN tprm_monitoring_received_events e ON e.workspace_id=q.workspace_id AND e.id=q.received_event_id
        WHERE q.workspace_id=? AND q.id=?`).get(req.workspace.id, queueId);
      if (!row) throw new monitoring.TprmConnectorError('TPRM_REASSESSMENT_QUEUE_NOT_FOUND', 'Reassessment request not found for this client.', 404);
      connectorId = row.connector_id;
      if (row.status !== 'manual_review') {
        throw new monitoring.TprmConnectorError('TPRM_REASSESSMENT_QUEUE_NOT_MANUAL', 'Only a manual-review item can be returned to the processing queue.', 409);
      }
      const changed = db.prepare(`UPDATE tprm_reassessment_queue SET status='pending',next_attempt_at=datetime('now'),
        last_error_code='TPRM_MANUAL_REVIEW_RETRY_AUTHORISED',last_error_redacted='Consultancy manual review authorised a controlled retry.',
        updated_at=datetime('now'),row_version=row_version+1
        WHERE workspace_id=? AND id=? AND status='manual_review' AND row_version=?`).run(
        req.workspace.id, queueId, row.row_version
      );
      if (changed.changes !== 1) {
        throw new monitoring.TprmConnectorError('TPRM_REASSESSMENT_QUEUE_RACE', 'The queue item changed while you were reviewing it. Reload and try again.', 409);
      }
      record(req, 'authorise_tprm_reassessment_retry', 'tprm_reassessment_queue', queueId, {
        connectorId,
        reason,
        priorAttempts: row.attempt_count,
      });
      return res.redirect(303, withToast(`${CONNECTOR_ROOT(req.workspace.id)}?connector=${connectorId}#reassessment`, 'Manual review recorded. The request is ready for a controlled retry.', 'success'));
    } catch (error) {
      return redirectError(req, res, connectorId, error);
    }
  });

  app.post('/workspaces/:wsId/tprm/monitoring/signals/:signalId/triage', ...mutationChain, (req, res) => {
    const signalId = positiveInteger(req.params.signalId);
    let connectorId = positiveInteger(req.body.connector_id);
    try {
      const signal = signalId ? db.prepare(`SELECT * FROM tprm_monitoring_signals
        WHERE workspace_id=? AND id=?`).get(req.workspace.id, signalId) : null;
      if (!signal) {
        throw new monitoring.TprmConnectorError('TPRM_SIGNAL_NOT_FOUND', 'Monitoring signal not found for this client.', 404);
      }
      const sourceMatch = /^connector:[^:]+:(\d+)$/.exec(String(signal.source || ''));
      const sourceConnectorId = sourceMatch ? Number(sourceMatch[1]) : null;
      if (sourceConnectorId) connectorId = sourceConnectorId;
      const result = tprmDomain.triageMonitoringSignal(db, {
        workspaceId: req.workspace.id,
        signalId,
        actorId: req.user.id,
        status: String(req.body.status || '').trim(),
        note: String(req.body.note || '').trim(),
        idempotencyKey: req.body.idempotency_key || null,
      });
      record(req, 'triage_tprm_monitoring_signal', 'tprm_monitoring_signal', signalId, {
        connectorId,
        status: result.signal.status,
        requiresReassessment: Boolean(result.signal.requires_reassessment),
      });
      return res.redirect(303, withToast(
        `${CONNECTOR_ROOT(req.workspace.id)}${connectorId ? `?connector=${connectorId}` : ''}#triage`,
        'Monitoring signal triage recorded.',
        'success'
      ));
    } catch (error) {
      return redirectError(req, res, connectorId, error);
    }
  });
}

module.exports = {
  PUBLIC_WEBHOOK_PATH,
  consumePublicPrebodyBudget,
  resetPublicPrebodyLimiterForTests,
  registerPublic,
  register,
};
