'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const updatePath = path.join(root, 'deploy', 'update.sh');
const setupPath = path.join(root, 'deploy', 'lightsail-setup.sh');
const composePath = path.join(root, 'docker-compose.yml');
const workflowPath = path.join(root, '.github', 'workflows', 'ci.yml');
const serverPath = path.join(root, 'server.js');
const emailPath = path.join(root, 'lib', 'email.js');

const update = fs.readFileSync(updatePath, 'utf8');
const setup = fs.readFileSync(setupPath, 'utf8');
const compose = fs.readFileSync(composePath, 'utf8');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const serverSource = fs.readFileSync(serverPath, 'utf8');
const emailSource = fs.readFileSync(emailPath, 'utf8');

test('deployment shell scripts remain executable and syntactically valid', () => {
  for (const script of [updatePath, setupPath]) {
    assert.notEqual(fs.statSync(script).mode & 0o111, 0, `${path.basename(script)} must be executable`);
    const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('update builds and proves the target on a raw clone before touching the live DB', () => {
  const checkoutAt = update.indexOf('git checkout --detach "$TARGET_SHA"');
  const buildAt = update.indexOf('docker compose build --pull --no-cache isms');
  const cloneAt = update.indexOf('scripts/online-db-clone.js');
  const targetPreflightAt = update.indexOf('Migrating and readiness-checking the target');
  const previousPreflightAt = update.indexOf('Proving the previous image can boot');
  const backupAt = update.indexOf('scripts/backup.js --standalone-no-migrations');
  const restoreAt = update.indexOf('scripts/restore-check.js --standalone-no-migrations');
  const ingressAt = update.indexOf('Blocking nginx ingress');
  const liveCandidateAt = update.indexOf('Starting release $TARGET_SHA with restart disabled');
  assert.ok(checkoutAt > 0);
  assert.ok(buildAt > checkoutAt);
  assert.ok(cloneAt > buildAt);
  assert.ok(targetPreflightAt > cloneAt);
  assert.ok(previousPreflightAt > targetPreflightAt);
  assert.ok(backupAt > previousPreflightAt);
  assert.ok(restoreAt > backupAt);
  assert.ok(ingressAt > restoreAt);
  assert.ok(liveCandidateAt > ingressAt);
  assert.match(update, /scripts\/backup\.js --standalone-no-migrations/);
  assert.match(update, /scripts\/restore-check\.js --standalone-no-migrations[\s\\]*--generation "\$RECOVERY_GENERATION"/);
  assert.doesNotMatch(update, /git pull\b/);
});

test('update isolates candidate ingress, traps failure, and promotes only an exact SHA image', () => {
  assert.match(update, /TARGET_SHA=.*rev-parse --verify/);
  assert.match(update, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(update, /TARGET_IMAGE="iso27001-tool:\$TARGET_SHA"/);
  assert.match(update, /MAINTENANCE_MARKER="\/run\/grc-deploy-maintenance"/);
  assert.match(update, /trap 'exit 130' INT/);
  assert.match(update, /trap 'exit 143' TERM/);
  assert.match(update, /trap on_exit EXIT/);
  assert.match(update, /restart: "no"/);
  assert.match(update, /HostConfig\.RestartPolicy\.Name/);
  assert.match(update, /wait_for_http "\$READY_URL" "\$TARGET_SHA"/);
  assert.match(update, /docker update --restart unless-stopped iso27001-tool/);
  assert.match(update, /rollback_release\(\)/);
  assert.match(update, /PREVIOUS_IMAGE/);
  assert.doesNotMatch(update, /docker image prune/);

  const readyAt = update.indexOf('if ! wait_for_http "$READY_URL" "$TARGET_SHA"; then');
  const promoteAt = update.lastIndexOf('persist_release_env "$TARGET_IMAGE" "$TARGET_SHA"');
  assert.ok(promoteAt > readyAt, 'candidate metadata must be persisted only after readiness');
  assert.match(update, /mktemp "\$APP_DIR\/\.env\.release\./);
  assert.match(update, /mv -f "\$release_env_tmp" \.env/);

  const rollbackAt = update.indexOf('rollback_release()');
  const rollbackEnd = update.indexOf('\non_exit() {', rollbackAt);
  const rollbackBody = update.slice(rollbackAt, rollbackEnd);
  const rollbackCheckoutAt = update.indexOf('git checkout --detach "$PREVIOUS_SHA"', rollbackAt);
  const rollbackComposeAt = update.indexOf('docker compose -f docker-compose.yml -f "$ROLLBACK_OVERRIDE" up', rollbackAt);
  const rollbackHealthAt = update.indexOf('wait_for_http "$HEALTH_URL"', rollbackAt);
  assert.ok(rollbackCheckoutAt > rollbackAt);
  assert.ok(rollbackComposeAt > rollbackCheckoutAt, 'rollback must restore previous checkout before Compose');
  assert.ok(rollbackHealthAt > rollbackComposeAt, 'rollback must use its proven liveness compatibility contract');
  assert.doesNotMatch(rollbackBody, /wait_for_http "\$READY_URL"/);
  assert.equal(update.indexOf('wait_for_http "$READY_URL" "$TARGET_SHA"', rollbackAt) > rollbackAt, true,
    'candidate promotion must retain exact-version readiness');
});

test('rollback checkout is bound to the running release identity', () => {
  const versionAt = update.indexOf('PREVIOUS_VERSION="$(docker inspect');
  const commitValidationAt = update.indexOf('git cat-file -e "$PREVIOUS_VERSION^{commit}"');
  const checkoutMismatchAt = update.indexOf('[ "$CURRENT_HEAD" != "$PREVIOUS_SHA" ]');
  const bootstrapAt = update.indexOf('[ "$PREVIOUS_VERSION" = "bootstrap" ]');
  const targetCheckoutAt = update.indexOf('git checkout --detach "$TARGET_SHA"');

  assert.ok(versionAt > 0);
  assert.ok(commitValidationAt > versionAt, 'the running APP_VERSION must resolve to a retained Git commit');
  assert.ok(checkoutMismatchAt > commitValidationAt, 'a checkout/container release mismatch must fail closed');
  assert.ok(bootstrapAt > checkoutMismatchAt, 'only the explicit initial bootstrap release may use HEAD');
  assert.ok(targetCheckoutAt > bootstrapAt, 'rollback identity must be validated before changing checkout');
  assert.match(update, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(update, /PREVIOUS_IMAGE" != "iso27001-tool:bootstrap"/);
  assert.doesNotMatch(update, /PREVIOUS_VERSION="\$\{PREVIOUS_VERSION:-\$PREVIOUS_SHA\}"/);
});

test('rollback image is pinned by ID and same-commit redeploys fail before build', () => {
  const captureAt = update.indexOf('PREVIOUS_IMAGE_ID="$(docker inspect');
  const tagValidationAt = update.indexOf('running rollback image tag no longer resolves');
  const sameTargetAt = update.indexOf('[ "$TARGET_SHA" = "$PREVIOUS_VERSION" ]');
  const buildAt = update.indexOf('docker compose build --pull --no-cache isms');
  const previousPreflightAt = update.indexOf('start_preflight "$PREVIOUS_IMAGE_ID"');
  const rollbackAt = update.indexOf('rollback_release()');
  const rollbackEnd = update.indexOf('\non_exit() {', rollbackAt);
  const rollbackBody = update.slice(rollbackAt, rollbackEnd);

  assert.ok(captureAt > 0);
  assert.ok(tagValidationAt > captureAt, 'tag drift must be rejected before retaining rollback state');
  assert.ok(sameTargetAt > tagValidationAt && sameTargetAt < buildAt,
    'a same-SHA no-cache rebuild must be rejected before it can move the rollback tag');
  assert.ok(previousPreflightAt > buildAt, 'previous compatibility preflight must use the captured image ID');
  assert.match(rollbackBody, /image: "\$PREVIOUS_IMAGE_ID"/);
  assert.match(rollbackBody, /persist_release_env "\$PREVIOUS_IMAGE_ID"/);
});

test('maintenance marker creation is owned by EXIT cleanup before it can interrupt ingress', () => {
  const blockAt = update.indexOf('block_ingress()');
  const blockEnd = update.indexOf('\ncleanup_preflight() {', blockAt);
  const body = update.slice(blockAt, blockEnd);
  const stateAt = body.indexOf('INGRESS_BLOCKED=1');
  const markerAt = body.indexOf('install -m 000 /dev/null "$MAINTENANCE_MARKER"');
  assert.ok(stateAt > 0 && markerAt > stateAt,
    'cleanup ownership must be recorded before the maintenance marker can exist');
});

test('preflight clears delivery credentials and runs on an internal no-egress network', () => {
  assert.match(update, /docker network create --internal "\$PREFLIGHT_NETWORK"/);
  assert.match(update, /-e EMAIL_DELIVERY_DISABLED=1/);
  assert.match(update, /-e RESEND_API_KEY= -e BREVO_API_KEY=/);
  assert.match(update, /-e GMAIL_USER= -e GMAIL_APP_PASSWORD=/);
  assert.match(update, /-e ISMS_PREFLIGHT=1/);
  assert.match(update, /PREFLIGHT_PREVIOUS_PORT\/healthz/);
  assert.match(serverSource, /preflight_isolation/);
  assert.match(serverSource, /EMAIL_DELIVERY_DISABLED !== '1'/);
  assert.match(emailSource, /EMAIL_DELIVERY_DISABLED/);
});

test('Compose keeps nginx as ingress and distinguishes liveness from promotion readiness', () => {
  assert.match(compose, /image: "\$\{ISMS_IMAGE:-iso27001-tool:local\}"/);
  assert.match(compose, /APP_VERSION=\$\{APP_VERSION:-development\}/);
  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /healthcheck:[\s\S]*\/healthz/);
  assert.match(compose, /stop_grace_period: 20s/);
  assert.match(setup, /ISMS_IMAGE=iso27001-tool:bootstrap/);
  assert.match(setup, /grc-deploy\.lock/);
  assert.match(setup, /if \(-f \/run\/grc-deploy-maintenance\) \{ return 503; \}/);
});

test('CI builds, readiness-checks, and gracefully stops the actual production image', () => {
  assert.match(workflow, /docker build --tag iso27001-tool:ci/);
  assert.match(workflow, /http:\/\/127\.0\.0\.1:3300\/readyz/);
  assert.match(workflow, /docker stop --time 20 nimbus-ci/);
});
