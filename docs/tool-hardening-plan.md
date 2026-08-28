# Tool hardening plan: flaws 1-6

Written 2026-07-05. Execution plan for the six structural flaws identified in the
tool-perspective review. Ordered so each phase locks in a guarantee the later,
riskier phases depend on. Each phase ends with an explicit gate; do not start
the next phase until the gate passes.

Standing constraints that bind every phase:

- `iso27001.db` in the repo root is the instance of record. Never mutate its
  data from plan work; tests copy it, they do not touch it.
- Schema changes go through the migration runner in `db.js` only. Pragmas set
  at connection time (WAL is already on at `db.js:13`) are not schema changes.
- `*.db` is gitignored, so CI can never rely on the live DB existing.
- Design language for any new UI (pager): weights 400/500 only, sentence case,
  no coloured left-border strips, no em dashes in copy or comments.
- The verification gate for anything touching routes is
  `npm run test:routes` (198-route walk, fails on any 5xx or server death)
  plus `npm test` for the full suite.

---

## Phase 0: CI pipeline (flaw 4) and /healthz (flaw 5)

Do this first. It is half a day and it makes every later phase self-verifying.

### 0.1 Make the test suite CI-compatible

Both `tests/smoke.test.js` and `tests/routes.test.js` copy the live
`iso27001.db`. In CI that file does not exist; `routes.test.js` currently
aborts without it, and `data/master.key` will not exist either.

- Add `scripts/build-test-db.js`: creates a throwaway DB at a path given by
  argv, by setting `DB_PATH` and requiring `db.js` (migrations run on boot),
  then running the seeding used by `scripts/seed-realistic-engagements.js`
  against it. Must not read or write the repo-root `iso27001.db`.
- Change `routes.test.js` and `smoke.test.js`: if the live DB exists, copy it
  (current behaviour, richest data); otherwise call the builder. The master-key
  copy in `routes.test.js` is already conditional; keep it that way so a fresh
  key is generated when no live key exists (fresh DB has no encrypted rows, so
  nothing needs the old key).
- Gate: delete nothing, and verify locally with
  `cd $(mktemp -d) && git clone <repo> . && npm ci && npm test` so the run
  proves the no-live-DB path works.

### 0.2 Workflow file

`.github/workflows/ci.yml`, triggers `push` to main and `pull_request`:

- ubuntu-latest, actions/setup-node with the Node 24 line (needed for
  `process.loadEnvFile`), `npm ci` (native builds for bcrypt and
  better-sqlite3 work out of the box on ubuntu-latest).
- Steps: `npm ci`, `npm test`. Puppeteer is a dependency but no test launches
  it; if install is slow, set `PUPPETEER_SKIP_DOWNLOAD=1` in the workflow env.
- On failure, upload the route-walk output as an artifact.
- After the first green run, turn on branch protection for `main` requiring
  the check (repo settings, done by Vijay in the GitHub UI, not by Claude).

### 0.3 /healthz

- `GET /healthz` registered before the session middleware in `server.js` so a
  probe never creates a session row: returns
  `{ ok: true, db: <result of SELECT 1>, version: assetVersion, uptime: process.uptime() }`
  with `Cache-Control: no-store`. Returns 503 with `ok: false` if the DB
  query throws.
- No auth (probes cannot log in). It leaks nothing beyond liveness.

Gate for phase 0: CI green on a PR from a fresh clone, and
`curl localhost:3100/healthz` returns `{"ok":true,...}`.

---

## Phase 1: pagination (flaw 3)

180 list queries do `.all(ws.id)` with no LIMIT anywhere. Paginate the pages
that grow without bound; leave small bounded lists (the 118 controls, the 25
clauses) alone.

### 1.1 Shared machinery

- `lib/paginate.js`: `paginate(req, countStmt, rowsStmt, params, { perPage: 50 })`
  returning `{ rows, page, pages, total, perPage }`. Clamp page to [1, pages].
  LIMIT/OFFSET appended by the helper, not hand-written per route.
- `views/partials/pager.ejs`: prev / next plus "page N of M · T rows", meta
  text style, preserving the current querystring except `page`. No numbered
  page buttons in v1.

### 1.2 Targets, in order of unboundedness

1. Activity / audit log (`/activity-log`, admin activity): grows fastest.
2. Evidence library.
3. Documents list.
4. Risk register: paginate the table only; the heatmap and band counts must
   come from separate aggregate queries over the full set, not the page rows.
5. Tasks, vendors, nonconformities, improvements, incidents, changes.

Watch-outs learned from the codebase: CSV exports and the audit-pack must stay
full-table (they do their own queries; verify none reuse a paginated helper);
filter forms must compose with the pager (filters live in the querystring
already, the pager partial preserves them); FTS search results are capped
already and stay as they are.

Gate: `npm test` green, plus a seeded-DB spot check that page 2 of the
activity log renders and filters survive page flips.

---

## Phase 2: heavy work off the request path (flaw 6)

The offenders, all inline in request handlers today: audit-pack zip (GET,
streams archiver), audit-pack PDF (POST, Puppeteer), gap-assessment DOCX and
the other `generateDocxBuffer` exports. On synchronous better-sqlite3 these
block every other user.

### 2.1 Worker pool for CPU-bound document generation

- `lib/workers.js`: a small `node:worker_threads` pool (size 2). Jobs:
  `docx` (doc id, ws id in; buffer out) and `zip-pack` (ws id in; the worker
  builds the full archive buffer or streams through a MessagePort).
- Workers open their own read-only better-sqlite3 connection to `DB_PATH`.
  WAL is already on, so worker reads do not block main-thread writes. Add
  `db.pragma('busy_timeout = 5000')` to both main and worker connections so
  a rare write lock retries instead of throwing.
- The route handlers become: validate, enqueue, await the worker result,
  stream the response. Same URLs, same UX, no job table, no polling UI.
- Puppeteer PDF: keep in-process (its heavy work is in the browser process,
  not the event loop) but serialize it: a one-at-a-time queue so two
  simultaneous PDF requests cannot spawn two Chromium instances.

### 2.2 Explicitly out of scope

A persistent job queue with a deliverables-style "your pack is ready" UX is
the eventual right answer if packs outgrow ~30s, but it is a product change.
Do not build it in this phase; note it in the phase commit message as the
follow-up trigger.

Gate: generate an audit pack on the seeded workspace while a second logged-in
browser tab clicks through the app; navigation must stay responsive. Route
walk green. Verify the pack zip byte-for-byte matches a pre-phase pack for the
same workspace (deterministic apart from the generated timestamp line).

---

## Phase 3: raise the SQLite ceiling without leaving it (flaw 2)

Policy is single instance, dev DB is the record; a Postgres migration is
explicitly not this plan. What can be done inside the policy:

- `busy_timeout` pragma (covered in 2.1).
- Restore drill: `scripts/restore-check.js` restores the newest encrypted
  backup dump to a temp path, boots migrations against it, asserts row counts
  within tolerance of the live DB, prints a one-line verdict. Wire it into the
  hourly jobs runner as a monthly job and surface the last verdict on the
  system page. A backup that has never been restored is a hope, not a backup.
- Off-site copy: the backup runner currently writes AES-encrypted dumps to
  the local disk, same failure domain as the DB and the master key. Add a
  configurable second destination (env `BACKUP_MIRROR_DIR`, e.g. a mounted
  drive or synced folder; cloud is descoped). Copy after each successful dump.
- Document the revisit triggers in this file when phase 3 lands: needing a
  second app process, p95 page render over ~500ms at realistic data volume,
  or DB file over ~2GB. Any of those reopens the datastore question.

Gate: restore drill passes against a real backup; mirror file appears after a
host-operated `npm run backup`. Tenant workspaces do not execute platform-wide
backup or key-management operations.

---

## Phase 4: finish the server.js split (flaw 1)

The pattern is proven (`routes/tenants.js`, `auditor.js`, `engagement.js`,
`glossary.js`): each module exports `register(app, deps)`, deps is the explicit
contract, no reach-back into server.js. What remains is a campaign, not a
design problem. ~14 slices, one commit each, route walk as the gate every time.

### 4.1 First, a shared helpers module

Most sections lean on the same closure helpers. Before slicing further,
extract to `lib/http-helpers.js` (or grow `lib/rbac.js` where it fits):
`withToast`, `logAction`, `auditCtx`, `escapeHtml`, `listWorkspaces`,
`currentUser`, and the `require*` middleware if they are not already
importable. This shrinks every deps object from ~15 keys to ~5 and removes
the shadowing class of bug (two `escapeHtml`s existed until the glossary
slice).

### 4.2 Slice order (self-contained first, tangled last)

1. Auth (login, logout, register, reset, invites): `routes/auth.js`
2. Admin (users, email settings, activity): `routes/admin.js`
3. Workspace CRUD + members + team setup: `routes/workspaces.js`
4. Risks cluster (register, methodology, appetite, treatments, library,
   CSV import, guided AI wizard): `routes/risks.js`
5. Controls, gap assessment, flag-for-review, SoA, crosswalks:
   `routes/controls.js`
6. Documents, template library, versioning, approvals, e-sign, magic-link
   approval portal: `routes/documents.js`
7. Evidence + coverage: `routes/evidence.js`
8. Audits, nonconformities, improvements, MRMs: `routes/governance.js`
9. Operational registers (incidents, BCP, changes, vendors/TPRM):
   `routes/registers.js`
10. Readiness engine + exec brief + blockers: `routes/readiness.js`
11. Exports, audit pack (zip/PDF/config), deliverables, reports:
    `routes/exports.js`
12. Metrics, training, competence, communication plan, objectives:
    `routes/performance.js`
13. ISO 42001 cluster: `routes/iso42001.js`
14. NIST CSF cluster: `routes/csf.js`

Mechanics per slice, learned from the glossary extraction: locate the banner
bounds, grep every helper and constant the section references for uses
*outside* the section before moving (this is what catches shared state),
move verbatim into `register(app, deps)`, replace with a 3-line register
call, `node --check` both files, run the route walk. If a section defines a
helper used elsewhere, the helper moves to `lib/http-helpers.js` first, in
its own commit.

Note for slices 4-6: the route walk only covers GETs. For these three, also
run the smoke suite (it exercises the wizard POST and SoA writes) and do one
manual mutation each (create a risk, save a control status, upload a doc
version) on the seeded workspace before committing.

End state: `server.js` under ~2,000 lines holding boot, middleware, security
config, shared locals, and fourteen register calls.

### 4.3 Sequencing across sessions

Each slice is 30-90 minutes including verification. Sensible session chunks:
(1+2), (3), (4), (5), (6), (7+8), (9+10), (11), (12), (13), (14). Stop a
session at a green gate, never mid-slice.

---

## Suggested overall order

| Order | Work | Size | Why this position |
|---|---|---|---|
| 1 | Phase 0: CI + healthz | half day | Everything after self-verifies |
| 2 | Phase 1: pagination | 1 day | User-visible, low risk, uses new CI |
| 3 | Phase 2: workers | 1 day | Needs busy_timeout thinking; do before the split moves these handlers |
| 4 | Phase 3: backup drill + mirror | half day | Independent, schedule anywhere |
| 5 | Phase 4: the split | ~6 sessions | Longest; every slice lands on a green suite |

Phases 0-3 happen on one branch each. Phase 4 is one branch per session chunk,
merged when its slices are green, so main never sits mid-refactor.
