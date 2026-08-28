# Runtime and deployment safety

This document describes the production safety boundary for Nimbus runtime
failures, process termination, and Lightsail releases.

## Release procedure

Run an update with a reviewed commit SHA or tag:

```bash
sudo /opt/grc-tool/deploy/update.sh <commit-or-tag>
```

With no argument, the script fetches `origin/main` and resolves it once to a
full 40-character commit SHA. The resolved commit is checked out detached and
built as `iso27001-tool:<commit-sha>`; a moving branch or `latest` tag is never
used as the release identity.

The update is fail-closed and serialized with the host health recovery job:

1. Refuse a dirty tracked production checkout, a missing current container, a
   running `APP_VERSION` that is not the exact checked-out commit, or a target
   SHA that is already running.
2. Resolve and build the immutable target while the previous container remains
   live.
3. Use the target image's raw SQLite utility to make an online clone without
   importing application initialization or migrations.
4. Boot target on the clone to migrate it and require the exact target version
   at `/readyz`; then boot the retained previous image on that migrated clone to
   prove binary rollback compatibility. Both preflights use an internal Docker
   network, blank delivery credentials, isolated uploads, and no-send mode.
5. Use target-image standalone/no-migration CLIs to create a signed v2 DB+uploads
   generation and restore-check that exact emitted generation ID with a ten-minute
   age gate.
6. Create the Nginx maintenance marker so external requests receive 503, then
   replace the live container with a candidate whose restart policy is `no`.
7. Require `/readyz` to return the exact target SHA and verify the container image
   ID before atomically persisting `ISMS_IMAGE`/`APP_VERSION` and enabling
   `unless-stopped` restart behavior.
8. EXIT, INT, and TERM handling owns the maintenance marker before it is
   created, removes preflight resources, and either reopens ingress after
   promotion or checks out the previous commit before using its Compose
   definition to restore the retained image. If rollback is not healthy,
   ingress remains blocked.

Production promotion requires every `/readyz` check to pass. In particular,
configure an HTTPS `APP_BASE_URL`, a transactional email provider, a strong
session secret and master key, and required ClamAV scanning before running an
update. Initial Lightsail setup leaves the public URL and email provider for
the operator to configure, so a production update correctly fails readiness
until those settings are complete.

Compose uses `/healthz` as its liveness healthcheck. Liveness proves the process
and database respond, while `/readyz` remains the stricter release-promotion
gate. Port 3000 is bound only to `127.0.0.1`; nginx is the public ingress.

## Rollback behavior

The previous container's immutable image ID and exact application commit are
captured and cross-checked before the build; a mutable tag cannot silently
change the rollback target. Images are not automatically pruned. If candidate
startup or readiness fails, the script checks out the previous commit before
invoking Compose, recreates the service from the retained image ID, verifies
its image identity and liveness, and persists the previous release metadata
only after rollback succeeds.

Rollback changes application code; it does not automatically restore the
database. The verified pre-deploy recovery generation is retained for an
explicit operator-led data restore if a migration requires it. Review migration
compatibility before deployment and treat database restoration as a separate,
audited recovery decision.

Because successful releases retain images, periodically review disk usage with
`docker image ls`. Keep at least the running image and its immediate predecessor
when applying the site's approved retention and cleanup procedure.

## Offline recovery materialization

Choose an exact signed generation from `data/backups`, create a private empty
destination, and materialize it without touching live paths:

```bash
sudo install -d -m 0700 -o 1000 -g 1000 /opt/grc-tool/data/recovery-output
cd /opt/grc-tool
docker compose exec -T isms node scripts/restore.js \
  --destination /app/data/recovery-output --generation <generation-id>
```

The command fails closed unless manifest HMAC, RPO age, archive hashes, SQLite
integrity, signed counts, every upload path/hash/size, and DB-declared physical
file references all verify. It emits `restored.db`, `uploads/`, and
`recovery-report.json`; it never promotes them. Review that report and use a
separately approved offline procedure to block ingress, stop the application,
retain current live DB/uploads, replace only those live data paths, restore
private ownership/modes, and require pinned-image `/readyz` before reopening
ingress. The separately escrowed encryption key is never replaced from a
generation. `--allow-stale-generation` is disaster-salvage override, not a
normal RPO-compliant restore.

## Request failure boundary

All handlers registered through the Express application route methods have a
Promise rejection boundary. A rejected async handler is forwarded to the final
error middleware and cannot leave the request hanging.

Every request receives an `X-Request-Id`. Internal failures are logged on the
server with that identifier, method, and path, but never the query string. The
client receives only an opaque HTTP 500 response and the request ID; exception
messages and stack traces are not returned.

## Graceful process termination

`SIGTERM` and `SIGINT` use one idempotent shutdown controller. The sequence is:

1. Cancel both the scheduled-job startup timeout and recurring interval.
2. Stop the HTTP listener and allow active requests to finish.
3. Drain queued and in-flight document worker jobs, then terminate the pool
   without respawning threads.
4. Run a passive SQLite WAL checkpoint and close the database.

The default runtime deadline is 15 seconds and can be set with
`SHUTDOWN_TIMEOUT_MS`. Compose allows 20 seconds before forcing container
termination. On deadline expiry, active HTTP connections are closed and worker
promises are rejected before forced thread termination. A second termination
signal exits immediately.

An unhandled Promise rejection in the main runtime uses the same idempotent
controller and always exits nonzero after draining. Importing `server.js` as a
test or library does not install this process-level handler. The session-store
expiry loop is disabled at its source; the governed jobs module owns the only
session sweep timer and can cancel it during shutdown.

## Verification

Focused repository tests cover async rejection handling, opaque correlated
responses, query-free application error logs, override expiry, idempotent and
bounded shutdown, scheduled-timer cancellation, worker termination without
respawn, and the static deployment invariants. CI also builds the production
Dockerfile, starts the resulting image with production readiness settings,
checks `/readyz`, and verifies a graceful zero-exit container stop.
