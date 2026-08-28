#!/usr/bin/env bash
set -euo pipefail

# Deploy one immutable Git commit through a clone-first compatibility gate.
# Nothing starts against the live database until both target and rollback
# images have booted successfully against an online clone migrated by target.

APP_DIR="/opt/grc-tool"
APP_UID="1000"
APP_GID="1000"
RELEASE_REF="${1:-origin/main}"
READY_URL="${READY_URL:-http://127.0.0.1:3000/readyz}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/healthz}"
READY_ATTEMPTS="${READY_ATTEMPTS:-45}"
READY_DELAY_SECONDS="${READY_DELAY_SECONDS:-2}"
PREFLIGHT_TARGET_PORT="${PREFLIGHT_TARGET_PORT:-3101}"
PREFLIGHT_PREVIOUS_PORT="${PREFLIGHT_PREVIOUS_PORT:-3102}"
MAINTENANCE_MARKER="/run/grc-deploy-maintenance"
PREFLIGHT_TARGET_NAME="nimbus-preflight-target"
PREFLIGHT_PREVIOUS_NAME="nimbus-preflight-previous"
PREFLIGHT_NETWORK="nimbus-preflight-isolated"

cd "$APP_DIR"

exec 9>/var/lock/grc-deploy.lock
if ! flock -n 9; then
  echo "ERROR: another deploy or health recovery is already running." >&2
  exit 1
fi

for value in "$READY_ATTEMPTS" "$READY_DELAY_SECONDS" "$PREFLIGHT_TARGET_PORT" "$PREFLIGHT_PREVIOUS_PORT"; do
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: readiness settings and preflight ports must be positive integers." >&2
    exit 1
  fi
done
if [ "$PREFLIGHT_TARGET_PORT" = "$PREFLIGHT_PREVIOUS_PORT" ] ||
   [ "$PREFLIGHT_TARGET_PORT" = "3000" ] || [ "$PREFLIGHT_PREVIOUS_PORT" = "3000" ]; then
  echo "ERROR: preflight ports must be distinct and must not use the live port." >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "ERROR: $APP_DIR/.env is required." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: tracked production files are modified; refusing to replace them." >&2
  exit 1
fi
if [ -e "$MAINTENANCE_MARKER" ]; then
  echo "ERROR: ingress is already in deployment maintenance mode; investigate before retrying." >&2
  exit 1
fi

CURRENT_CONTAINER_ID="$(docker compose ps -q isms)"
if [ -z "$CURRENT_CONTAINER_ID" ] ||
   [ "$(docker inspect --format='{{.State.Running}}' "$CURRENT_CONTAINER_ID" 2>/dev/null)" != "true" ]; then
  echo "ERROR: the current isms container must be running before an update." >&2
  exit 1
fi

CURRENT_HEAD="$(git rev-parse --verify HEAD^{commit})"
PREVIOUS_IMAGE="$(docker inspect --format='{{.Config.Image}}' "$CURRENT_CONTAINER_ID")"
PREVIOUS_IMAGE_ID="$(docker inspect --format='{{.Image}}' "$CURRENT_CONTAINER_ID")"
PREVIOUS_VERSION="$(docker inspect --format='{{range .Config.Env}}{{println .}}{{end}}' "$CURRENT_CONTAINER_ID" |
  awk -F= '$1=="APP_VERSION" { sub(/^[^=]*=/, ""); print; exit }')"
if [[ "$PREVIOUS_VERSION" =~ ^[0-9a-f]{40}$ ]]; then
  if ! git cat-file -e "$PREVIOUS_VERSION^{commit}" 2>/dev/null; then
    echo "ERROR: the running release commit is not present in the production checkout." >&2
    exit 1
  fi
  PREVIOUS_SHA="$(git rev-parse --verify "$PREVIOUS_VERSION^{commit}")"
  if [ "$PREVIOUS_SHA" != "$PREVIOUS_VERSION" ] || [ "$CURRENT_HEAD" != "$PREVIOUS_SHA" ]; then
    echo "ERROR: the current checkout does not match the running release; refusing an unsafe rollback baseline." >&2
    exit 1
  fi
elif [ "$PREVIOUS_VERSION" = "bootstrap" ]; then
  # The initial setup image predates commit-addressed releases. It is the only
  # exception, and its image identity must match the setup contract exactly.
  if [ "$PREVIOUS_IMAGE" != "iso27001-tool:bootstrap" ]; then
    echo "ERROR: bootstrap APP_VERSION is not paired with the bootstrap image." >&2
    exit 1
  fi
  PREVIOUS_SHA="$CURRENT_HEAD"
else
  echo "ERROR: the running container has no trustworthy commit-addressed APP_VERSION." >&2
  exit 1
fi
LIVE_DB_CONTAINER_PATH="$(docker inspect --format='{{range .Config.Env}}{{println .}}{{end}}' "$CURRENT_CONTAINER_ID" |
  awk -F= '$1=="DB_PATH" { sub(/^[^=]*=/, ""); print; exit }')"
LIVE_DB_CONTAINER_PATH="${LIVE_DB_CONTAINER_PATH:-/app/data/iso27001.db}"
if [[ "$LIVE_DB_CONTAINER_PATH" != /app/data/* ]]; then
  echo "ERROR: deployment supports a DB_PATH beneath /app/data only." >&2
  exit 1
fi
LIVE_DB_RELATIVE="${LIVE_DB_CONTAINER_PATH#/app/data/}"
if [ -z "$LIVE_DB_RELATIVE" ] || [[ "$LIVE_DB_RELATIVE" == *".."* ]] || [[ "$LIVE_DB_RELATIVE" == *\\* ]]; then
  echo "ERROR: unsafe DB_PATH in current container: $LIVE_DB_CONTAINER_PATH" >&2
  exit 1
fi
if [ ! -f "$APP_DIR/data/$LIVE_DB_RELATIVE" ]; then
  echo "ERROR: live database bind source is missing: $APP_DIR/data/$LIVE_DB_RELATIVE" >&2
  exit 1
fi
if [ -z "$PREVIOUS_IMAGE" ]; then
  echo "ERROR: could not identify the rollback image." >&2
  exit 1
fi
if [ -z "$PREVIOUS_IMAGE_ID" ] ||
   [ "$(docker image inspect --format='{{.Id}}' "$PREVIOUS_IMAGE" 2>/dev/null)" != "$PREVIOUS_IMAGE_ID" ]; then
  echo "ERROR: the running rollback image tag no longer resolves to the running image ID." >&2
  exit 1
fi

TARGET_SHA=""
TARGET_IMAGE=""
PREFLIGHT_ROOT=""
CANDIDATE_OVERRIDE=""
ROLLBACK_OVERRIDE=""
INGRESS_BLOCKED=0
CANDIDATE_STARTED=0
DEPLOY_COMMITTED=0

wait_for_http() {
  local url="$1"
  local expected_version="${2:-}"
  local attempt body
  for ((attempt = 1; attempt <= READY_ATTEMPTS; attempt++)); do
    if body="$(curl --silent --show-error --fail --max-time 5 "$url" 2>/dev/null)"; then
      if [ -z "$expected_version" ] || printf '%s' "$body" | grep -Fq "\"version\":\"$expected_version\""; then
        return 0
      fi
    fi
    sleep "$READY_DELAY_SECONDS"
  done
  return 1
}

persist_release_env() {
  local release_image="$1"
  local release_version="$2"
  local release_env_tmp
  umask 077
  release_env_tmp="$(mktemp "$APP_DIR/.env.release.XXXXXX")"
  if ! awk -v image="$release_image" -v version="$release_version" '
      /^ISMS_IMAGE=/ { next }
      /^APP_VERSION=/ { next }
      { print }
      END {
        print "ISMS_IMAGE=" image
        print "APP_VERSION=" version
      }
    ' .env > "$release_env_tmp"; then
    rm -f "$release_env_tmp"
    return 1
  fi
  chown root:root "$release_env_tmp"
  chmod 0600 "$release_env_tmp"
  mv -f "$release_env_tmp" .env
}

unblock_ingress() {
  if [ "$INGRESS_BLOCKED" -ne 1 ]; then return 0; fi
  rm -f "$MAINTENANCE_MARKER"
  nginx -t
  systemctl reload nginx
  INGRESS_BLOCKED=0
}

block_ingress() {
  if [ ! -f /etc/nginx/sites-available/grc-tool ]; then
    echo "ERROR: nginx grc-tool site is missing." >&2
    return 1
  fi
  if ! grep -Fq '/run/grc-deploy-maintenance' /etc/nginx/sites-available/grc-tool; then
    sed -i '/server_name/a\    if (-f /run/grc-deploy-maintenance) { return 503; }' /etc/nginx/sites-available/grc-tool
  fi
  nginx -t
  systemctl reload nginx
  # Set state first so an interrupt after marker creation can never strand a
  # maintenance response that EXIT cleanup believes it does not own.
  INGRESS_BLOCKED=1
  install -m 000 /dev/null "$MAINTENANCE_MARKER"
}

cleanup_preflight() {
  docker rm -f "$PREFLIGHT_TARGET_NAME" >/dev/null 2>&1 || true
  docker rm -f "$PREFLIGHT_PREVIOUS_NAME" >/dev/null 2>&1 || true
  docker network rm "$PREFLIGHT_NETWORK" >/dev/null 2>&1 || true
  if [ -n "$PREFLIGHT_ROOT" ] && [[ "$PREFLIGHT_ROOT" == "$APP_DIR"/.preflight.* ]]; then
    rm -rf -- "$PREFLIGHT_ROOT"
  fi
  if [ -n "$CANDIDATE_OVERRIDE" ]; then rm -f "$CANDIDATE_OVERRIDE"; fi
  if [ -n "$ROLLBACK_OVERRIDE" ]; then rm -f "$ROLLBACK_OVERRIDE"; fi
}

rollback_release() {
  echo "==> Candidate failed; rolling back to $PREVIOUS_IMAGE_ID..." >&2
  docker logs --tail 200 iso27001-tool >&2 2>/dev/null || true
  if ! docker image inspect "$PREVIOUS_IMAGE_ID" >/dev/null 2>&1; then
    echo "ERROR: retained rollback image is unavailable: $PREVIOUS_IMAGE_ID" >&2
    return 1
  fi

  # Compose semantics belong to the previous release. Checking out first is
  # mandatory; otherwise a candidate compose migration can make rollback fail.
  if ! git checkout --detach "$PREVIOUS_SHA"; then
    echo "ERROR: could not restore the previous release checkout." >&2
    return 1
  fi
  ROLLBACK_OVERRIDE="$(mktemp "$APP_DIR/.compose.rollback.XXXXXX.yml")"
  cat > "$ROLLBACK_OVERRIDE" <<EOF
services:
  isms:
    image: "$PREVIOUS_IMAGE_ID"
    build: null
    restart: unless-stopped
    environment:
      APP_VERSION: "$PREVIOUS_VERSION"
EOF
  if ! ISMS_IMAGE="$PREVIOUS_IMAGE_ID" APP_VERSION="$PREVIOUS_VERSION" \
      docker compose -f docker-compose.yml -f "$ROLLBACK_OVERRIDE" up -d --no-deps --force-recreate isms; then
    echo "ERROR: rollback container could not be started." >&2
    return 1
  fi
  local actual_image_id
  actual_image_id="$(docker inspect --format='{{.Image}}' iso27001-tool)"
  if [ "$actual_image_id" != "$PREVIOUS_IMAGE_ID" ]; then
    echo "ERROR: rollback container is not running the retained previous image." >&2
    return 1
  fi
  # The retained image was proven on /healthz against the target-migrated
  # clone. Keep rollback on that compatibility contract; only the candidate
  # promotion path below requires exact-version /readyz.
  if ! wait_for_http "$HEALTH_URL"; then
    echo "ERROR: rollback image started but did not become ready." >&2
    return 1
  fi
  if ! persist_release_env "$PREVIOUS_IMAGE_ID" "$PREVIOUS_VERSION"; then
    echo "ERROR: rollback is ready, but its release metadata could not be persisted." >&2
    return 1
  fi
  docker update --restart unless-stopped iso27001-tool >/dev/null
  echo "==> Rollback is ready on $PREVIOUS_IMAGE_ID." >&2
  return 0
}

on_exit() {
  local status=$?
  local safe_to_unblock=1
  trap - EXIT
  trap '' INT TERM
  set +e
  cleanup_preflight
  if [ "$DEPLOY_COMMITTED" -ne 1 ]; then
    if [ "$CANDIDATE_STARTED" -eq 1 ]; then
      if ! rollback_release; then safe_to_unblock=0; fi
    else
      git checkout --detach "$PREVIOUS_SHA" >/dev/null 2>&1 || true
    fi
  fi
  if [ "$INGRESS_BLOCKED" -eq 1 ]; then
    if [ "$safe_to_unblock" -eq 1 ]; then
      if ! unblock_ingress; then status=1; fi
    else
      echo "ERROR: ingress remains blocked because rollback did not become ready." >&2
    fi
  fi
  if [ -n "$ROLLBACK_OVERRIDE" ]; then rm -f "$ROLLBACK_OVERRIDE"; fi
  if [ "$safe_to_unblock" -ne 1 ]; then status=1; fi
  exit "$status"
}

trap 'exit 130' INT
trap 'exit 143' TERM
trap on_exit EXIT

echo "==> Checking and enforcing private runtime permissions..."
install -d -m 0700 -o "$APP_UID" -g "$APP_GID" data data/backups uploads
find data uploads -xdev \( ! -user "$APP_UID" -o ! -group "$APP_GID" \) -print 2>/dev/null || true
find data uploads -xdev -type d ! -perm 0700 -print 2>/dev/null || true
find data uploads -xdev -type f ! -perm 0600 -print 2>/dev/null || true
chown -R "$APP_UID:$APP_GID" data uploads
find data uploads -xdev -type d -exec chmod 0700 {} +
find data uploads -xdev -type f -exec chmod 0600 {} +
chown root:root .env
chmod 0600 .env

echo "==> Enforcing query-free reverse-proxy access logs..."
cat > /etc/nginx/conf.d/grc-log-format.conf <<'LOGEOF'
log_format grc_no_query '$remote_addr - $remote_user [$time_local] "$request_method $uri $server_protocol" '
                        '$status $body_bytes_sent "$http_user_agent"';
LOGEOF
if [ -f /etc/nginx/sites-available/grc-tool ] && ! grep -q 'grc_no_query' /etc/nginx/sites-available/grc-tool; then
  sed -i '/server_name/a\    access_log /var/log/nginx/grc-tool.access.log grc_no_query;' /etc/nginx/sites-available/grc-tool
fi
if [ -f /etc/nginx/sites-available/grc-tool ] && ! grep -Fq '/run/grc-deploy-maintenance' /etc/nginx/sites-available/grc-tool; then
  sed -i '/server_name/a\    if (-f /run/grc-deploy-maintenance) { return 503; }' /etc/nginx/sites-available/grc-tool
fi
nginx -t
systemctl reload nginx

echo "==> Resolving immutable release $RELEASE_REF..."
git fetch --prune --tags origin
TARGET_SHA="$(git rev-parse --verify "${RELEASE_REF}^{commit}")"
if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: release did not resolve to a full commit SHA: $TARGET_SHA" >&2
  exit 1
fi
if [ "$TARGET_SHA" = "$PREVIOUS_VERSION" ]; then
  echo "ERROR: target commit is already running; refusing to overwrite its retained rollback image tag." >&2
  exit 1
fi
TARGET_IMAGE="iso27001-tool:$TARGET_SHA"
git checkout --detach "$TARGET_SHA"

echo "==> Building immutable image $TARGET_IMAGE while the previous release remains live..."
ISMS_IMAGE="$TARGET_IMAGE" APP_VERSION="$TARGET_SHA" docker compose build --pull --no-cache isms

echo "==> Creating raw online database clone without application migrations..."
PREFLIGHT_ROOT="$(mktemp -d "$APP_DIR/.preflight.XXXXXX")"
chown "$APP_UID:$APP_GID" "$PREFLIGHT_ROOT"
chmod 0700 "$PREFLIGHT_ROOT"
install -d -m 0700 -o "$APP_UID" -g "$APP_GID" \
  "$PREFLIGHT_ROOT/data/$(dirname "$LIVE_DB_RELATIVE")" "$PREFLIGHT_ROOT/uploads"
docker run --rm --init --network none --user "$APP_UID:$APP_GID" \
  --mount "type=bind,src=$APP_DIR/data,dst=/live,readonly" \
  --mount "type=bind,src=$PREFLIGHT_ROOT/data,dst=/preflight" \
  --entrypoint node "$TARGET_IMAGE" scripts/online-db-clone.js \
  "/live/$LIVE_DB_RELATIVE" "/preflight/$LIVE_DB_RELATIVE"

KEY_CONTAINER_PATH="$(docker inspect --format='{{range .Config.Env}}{{println .}}{{end}}' "$CURRENT_CONTAINER_ID" |
  awk -F= '$1=="ISMS_KEY_FILE" { sub(/^[^=]*=/, ""); print; exit }')"
KEY_CONTAINER_PATH="${KEY_CONTAINER_PATH:-/app/data/master.key}"
KEY_MOUNT=()
if [[ "$KEY_CONTAINER_PATH" == /app/data/* ]]; then
  KEY_RELATIVE="${KEY_CONTAINER_PATH#/app/data/}"
  if [ -f "$APP_DIR/data/$KEY_RELATIVE" ]; then
    KEY_MOUNT=(--mount "type=bind,src=$APP_DIR/data/$KEY_RELATIVE,dst=$KEY_CONTAINER_PATH,readonly")
  fi
fi

start_preflight() {
  local image="$1" name="$2" port="$3" version="$4"
  docker run -d --name "$name" --restart=no --init --network "$PREFLIGHT_NETWORK" \
    --security-opt no-new-privileges:true --cap-drop ALL \
    --env-file "$APP_DIR/.env" \
    -e PORT=3000 -e NODE_ENV=production -e APP_VERSION="$version" \
    -e DB_PATH="/app/data/$LIVE_DB_RELATIVE" \
    -e ISMS_BACKUP_DIR=/app/data/preflight-backups \
    -e ISMS_UPLOADS_DIR=/app/uploads -e ISMS_DISABLE_JOBS=1 -e ISMS_PREFLIGHT=1 \
    -e EMAIL_DELIVERY_DISABLED=1 -e APP_BASE_URL=https://preflight.invalid \
    -e RESEND_API_KEY= -e BREVO_API_KEY= -e BREVO_SENDER_EMAIL= \
    -e GMAIL_USER= -e GMAIL_APP_PASSWORD= \
    -p "127.0.0.1:$port:3000" \
    --mount "type=bind,src=$PREFLIGHT_ROOT/data,dst=/app/data" \
    --mount "type=bind,src=$PREFLIGHT_ROOT/uploads,dst=/app/uploads" \
    "${KEY_MOUNT[@]}" "$image"
}

docker rm -f "$PREFLIGHT_TARGET_NAME" "$PREFLIGHT_PREVIOUS_NAME" >/dev/null 2>&1 || true
docker network rm "$PREFLIGHT_NETWORK" >/dev/null 2>&1 || true
docker network create --internal "$PREFLIGHT_NETWORK" >/dev/null
echo "==> Migrating and readiness-checking the target on the clone..."
start_preflight "$TARGET_IMAGE" "$PREFLIGHT_TARGET_NAME" "$PREFLIGHT_TARGET_PORT" "$TARGET_SHA" >/dev/null
if ! wait_for_http "http://127.0.0.1:$PREFLIGHT_TARGET_PORT/readyz" "$TARGET_SHA"; then
  docker logs --tail 200 "$PREFLIGHT_TARGET_NAME" >&2 2>/dev/null || true
  echo "ERROR: target did not become exactly ready on the preflight clone." >&2
  exit 1
fi
docker stop --time 20 "$PREFLIGHT_TARGET_NAME" >/dev/null
docker rm "$PREFLIGHT_TARGET_NAME" >/dev/null

echo "==> Proving the previous image can boot the target-migrated clone..."
start_preflight "$PREVIOUS_IMAGE_ID" "$PREFLIGHT_PREVIOUS_NAME" "$PREFLIGHT_PREVIOUS_PORT" "$PREVIOUS_VERSION" >/dev/null
if ! wait_for_http "http://127.0.0.1:$PREFLIGHT_PREVIOUS_PORT/healthz"; then
  docker logs --tail 200 "$PREFLIGHT_PREVIOUS_NAME" >&2 2>/dev/null || true
  echo "ERROR: previous image is not backward-compatible with the target-migrated clone." >&2
  exit 1
fi
docker stop --time 20 "$PREFLIGHT_PREVIOUS_NAME" >/dev/null
docker rm "$PREFLIGHT_PREVIOUS_NAME" >/dev/null

echo "==> Creating a signed v2 DB+uploads generation with target recovery tooling..."
BACKUP_OUTPUT="$(ISMS_IMAGE="$TARGET_IMAGE" APP_VERSION="$TARGET_SHA" \
  docker compose run --rm --no-deps -T --entrypoint node isms \
  scripts/backup.js --standalone-no-migrations)"
printf '%s\n' "$BACKUP_OUTPUT"
RECOVERY_GENERATION="$(printf '%s\n' "$BACKUP_OUTPUT" |
  sed -n 's/^\[backup\] recovery generation: //p' | tail -n 1)"
if [[ ! "$RECOVERY_GENERATION" =~ ^isms-[A-Za-z0-9-]+$ ]]; then
  echo "ERROR: target backup did not emit a valid generation id." >&2
  exit 1
fi
echo "==> Verifying exact recovery generation $RECOVERY_GENERATION with target tooling..."
ISMS_IMAGE="$TARGET_IMAGE" APP_VERSION="$TARGET_SHA" \
  docker compose run --rm --no-deps -T -e ISMS_BACKUP_MAX_AGE_HOURS=0.167 \
  --entrypoint node isms scripts/restore-check.js --standalone-no-migrations \
  --generation "$RECOVERY_GENERATION"

echo "==> Blocking nginx ingress for the in-place live candidate gate..."
block_ingress
CANDIDATE_OVERRIDE="$(mktemp "$APP_DIR/.compose.candidate.XXXXXX.yml")"
cat > "$CANDIDATE_OVERRIDE" <<'EOF'
services:
  isms:
    restart: "no"
EOF

echo "==> Starting release $TARGET_SHA with restart disabled until promotion..."
CANDIDATE_STARTED=1
ISMS_IMAGE="$TARGET_IMAGE" APP_VERSION="$TARGET_SHA" \
  docker compose -f docker-compose.yml -f "$CANDIDATE_OVERRIDE" \
  up -d --no-deps --force-recreate isms
if [ "$(docker inspect --format='{{.HostConfig.RestartPolicy.Name}}' iso27001-tool)" != "no" ]; then
  echo "ERROR: unpromoted candidate has a persistent restart policy." >&2
  exit 1
fi
if [ "$(docker inspect --format='{{.Image}}' iso27001-tool)" != \
     "$(docker image inspect --format='{{.Id}}' "$TARGET_IMAGE")" ]; then
  echo "ERROR: candidate container is not running the exact target image." >&2
  exit 1
fi

echo "==> Waiting for exact deployment readiness at $READY_URL..."
if ! wait_for_http "$READY_URL" "$TARGET_SHA"; then
  echo "ERROR: candidate did not report the exact target version as ready." >&2
  exit 1
fi

# Persist only after exact readiness, then make the already-proven container
# restartable. Until these two operations complete, a reboot cannot promote it.
persist_release_env "$TARGET_IMAGE" "$TARGET_SHA"
docker update --restart unless-stopped iso27001-tool >/dev/null
if [ "$(docker inspect --format='{{.HostConfig.RestartPolicy.Name}}' iso27001-tool)" != "unless-stopped" ]; then
  echo "ERROR: promoted candidate restart policy was not persisted." >&2
  exit 1
fi
DEPLOY_COMMITTED=1

# Deliberately do not prune images: PREVIOUS_IMAGE is the rollback artifact.
echo "==> Release ready: $TARGET_SHA"
ISMS_IMAGE="$TARGET_IMAGE" APP_VERSION="$TARGET_SHA" docker compose ps
