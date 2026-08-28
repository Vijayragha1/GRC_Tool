# Five-critique remediation plan

Status: proposed execution plan
Prepared: 2026-08-27
Decision owner: product owner
Scope: product cutover, assurance semantics, tenant and file containment,
independent recovery, and pilot economics

## 1. Executive decision

Nimbus is approved for continued internal development and, after the launch
blockers in this plan close, a controlled ISO 27001 design-partner pilot. It is
not approved for general multi-tenant production launch or for external claims
that its current attachment and status heuristics establish evidence
sufficiency, operating effectiveness, audit readiness, or Stage 2 readiness.

The remediation strategy is:

1. Stabilize and verify the substantial security and recovery work already in
   the working tree.
2. Close confirmed tenant and filesystem containment defects.
3. Make recovery independent of the Lightsail host and prove it on a fresh
   machine.
4. Contain claims and synthetic assurance behavior immediately. The pilot may
   expose management-status and audit-support outputs only.
5. Build a governed, concierge migration path for those deliberately limited
   pilot outputs.
6. Use pilot evidence to decide whether customers need a full assurance model.
   If they do, add it without rewriting retained history; if they do not, keep
   the unsafe assurance surfaces disabled.
7. Use measured adoption and support economics to decide whether the product is
   ready for limited availability, then validate a second cohort before general
   availability.

The governing rule is simple: the first external SKU is ISO 27001-only. No
other framework or module is exposed commercially until it passes its own
security, assurance, recovery, cutover, and commercial gates.

## 2. What is already in progress

The current working tree is not a clean baseline. At the time of this plan it
contains 63 modified tracked files, 3,367 insertions, 470 deletions, and 18
untracked files. Much of that work is directly useful:

- signed database-plus-upload recovery generations in `lib/backup.js`;
- full restore verification and safe materialization in `lib/restore-check.js`
  and `scripts/restore.js`;
- exact-version deployment preflights and rollback checks in
  `deploy/update.sh`;
- runtime liveness, readiness, and graceful shutdown hardening;
- authorization containment tests and firm-only evidence mutation boundaries;
- scoped report-template and handover-export access helpers;
- test discovery and new recovery, deployment, and authorization suites.

This tranche must be preserved and reviewed as foundation work. The plan does
not authorize resetting, discarding, or mechanically rewriting it. New work
must be isolated into reviewable commits after the foundation has a green test
baseline.

## 3. Observation-to-workstream traceability

| Critique | Confirmed observation | Primary remediation | Launch gate |
|---|---|---|---|
| Product and cutover | A workspace can be created without a repeatable migration-to-first-deliverable path; breadth has already caused incorrect ISO onboarding | CUT and PIL | Pilot activation and cutover gate |
| Audit and assurance | Management status, attachment counts, and upload age can become apparent assurance conclusions | ASM | Assurance truth gate |
| Tenant security | Nested IDs and stored paths are not structurally tenant-bound everywhere | SEC | Containment gate |
| Recovery | Default live data, uploads, local backups, logs, and likely the only key share one host failure domain | REC | Fresh-host recovery gate |
| Commercial implementation | Broad self-hosted sales can disguise bespoke, negative-margin implementation as SaaS traction | PIL and COM | Commercial exit gate |

## 4. Priority definitions

- **P0:** Must close before any new external user or real client evidence is put
  into a pilot environment.
- **P1:** Must close before a pilot can produce a governed external deliverable.
- **P2:** Must close before general availability.
- **P3:** Post-launch improvement; explicitly outside this remediation program.

## 5. Delivery order and dependencies

| Wave | Work | Can run in parallel | Exit condition |
|---|---|---|---|
| 0 | FND: stabilize foundation and contain claims | No | Reviewed baseline, green tests, prohibited claims removed |
| 1 | SEC: tenant and file containment; REC: independent recovery | Yes, on separate branches | Exhaustive pilot-surface containment and fresh-host restore proven |
| 2 | ASM-P: pilot-safe management-status outputs; CUT: source-specific concierge import | Yes after Wave 1 interfaces stabilize | No synthetic assurance; two dry runs reconcile with no silent loss |
| 3 | PIL-A: controlled ISO 27001 design-partner cohort | No feature expansion alongside it | Safety gates pass and repeatability/economics are measured |
| 4 | ASM-V2: full assurance model, only if pilot demand validates it | May start after the first 30 days of PIL-A | Unsafe assurance remains disabled or v2 truth gate passes |
| 5 | LA: ISO 27001 limited-availability cohort | No other-module expansion | Non-founder operator proves repeatability on additional source formats |
| 6 | COM: general-availability decision | No | Explicit go/no-go record and approved claims |

No more than two implementation branches should be active at once while the
current stabilization tranche is being landed. Security-sensitive middleware
order, released-only portal scoping, and export-source permissions must be
preserved when resolving overlapping changes.

## 6. FND: foundation stabilization and claim containment

### FND-01 - Preserve and baseline the current tranche

1. Inventory current changes by concern: deployment, recovery, authorization,
   runtime, UI-only, and test infrastructure.
2. Review and land them in concern-specific commits or branches. Do not mix
   assurance-model or pilot-import changes into those commits.
3. Confirm migration numbering and checksums after the tranche lands. Migration
   `061` is provisional because `060` is the current latest migration.
4. Run all existing tests from a fresh migrated test database. The repository
   database of record must never be mutated by tests or plan work.
5. Run a complete backup and restore verification against a copied database and
   uploads fixture.

Current focused evidence: a read-only reviewer ran
`node --test --test-force-exit tests/backup-recovery.test.js
tests/deployment-safety.test.js` against the working tree; all 25 tests passed.
This is useful foundation evidence, but it is not a substitute for the full
suite, container CI, or a drill from the eventual release commit.

Acceptance evidence:

- `npm test` passes through the discovery runner;
- `npm run test:security` passes;
- `npm run test:routes` passes;
- production container smoke and graceful-stop checks pass in CI;
- recovery test suite passes with database and upload parity;
- current tracked and untracked work is accounted for in reviewable changes.

### FND-02 - Freeze product expansion

Until the pilot exit gate passes, permitted product work is limited to:

- security or data-loss prevention;
- recovery and operator safety;
- assurance correctness;
- ISO 27001 cutover and workflow correctness;
- pilot instrumentation;
- defects blocking the defined pilot.

Freeze net-new work for ISO 42001, NIST CSF, DPDPA, SOC 2, TPRM, vCISO, AI,
integrations, new report types, and cosmetic expansion. Existing code and
retained records remain intact, but those modules are not part of the pilot or
the first external SKU. They are not commercially supported until they pass
their own launch gates. This is a roadmap and entitlement freeze, not a
destructive removal.

### FND-03 - Contain claims immediately

Before the v2 assurance model exists, change UI, export, README, and public-site
language as follows:

| Current or implied claim | Safe interim language |
|---|---|
| Evidence sufficient | Attachment target met |
| Evidence-backed conclusion | Linked-evidence coverage |
| Stage 1/2 ready | Internal Stage 1/2 preparation checks passed |
| Certification readiness | Certification preparation |
| Audit-readiness report | Audit preparation report |
| ISMS Audit Pack | Audit support pack |
| Frozen control conclusion | Frozen management-reported control-state snapshot |

Every affected report must disclose that existence, linkage, age, and hashing of
a file do not establish its relevance, sufficiency, period coverage, operating
effectiveness, or acceptance by an auditor or certification body.

Acceptance evidence:

- a controlled claim inventory covers public pages, authenticated UI, PDFs,
  DOCX, CSV and ZIP manifests, email, demo data, README, and help copy;
- a prohibited-phrase scan plus contextual review finds no external copy
  equating attachment count, status, or upload age with sufficiency,
  effectiveness, approval, or readiness;
- legacy exports carry a visible legacy-methodology and non-reliance banner;
- no database history or snapshot hash is altered by the label changes.

## 7. SEC: tenant and filesystem containment

### SEC-00 - Inventory the entire enabled pilot boundary (P0)

Before declaring containment complete, enumerate 100 percent of routes,
background jobs, magic-link handlers, exports, downloads, deletes, and file
consumers enabled for the ISO 27001 SKU. For each nested resource, record:

- tenant root and verified parent chain;
- read, write, delete, and export predicates;
- whether a global child ID is ever accepted without its workspace or firm;
- physical or virtual storage access;
- client, consultant, auditor, and unauthenticated exposure;
- focused hostile-fixture coverage.

The inventory is a gate, not a sample. No direct filesystem read or unlink may
remain outside the canonical module, and no enabled child-resource lookup may
remain unscoped.

### SEC-01 - Replace the shared upload resolver (P0)

Create one fail-closed file-access module, provisionally `lib/upload-paths.js`.
Its read and delete APIs must:

- require a positive, verified firm ID;
- reject absolute paths, URI schemes, NUL bytes, dot segments, forward slashes,
  and backslashes for physical storage keys;
- distinguish virtual references such as `ddq://...` from physical files;
- resolve the canonical firm root and target;
- reject symlinks and non-regular files;
- prove the target's real path is below exactly `uploads/firm_<firmId>`;
- avoid placing attacker-supplied path text in logs;
- return a uniform not-found result for unsafe and missing paths.

Replace all direct `resolveUploadPath` consumption across auditor, evidence,
documents, exports, client portal, supplier, engagement, register, workspace,
and TPRM routes. Remove weaker route-local wrappers after parity tests pass.

### SEC-02 - Remove arbitrary brand-logo paths (P0)

1. Replace the free-text logo path with a tenant-scoped image upload.
2. Store only a generated physical storage key.
3. Permit PNG, JPEG, and WebP after signature, MIME, and size validation.
4. Do not accept SVG, remote URLs, application-relative paths, or absolute
   paths.
5. Treat any existing non-basename value as unsafe. Inventory and migrate it;
   do not preserve compatibility by reading it.
6. Ensure workspace deletion uses only the safe-delete API and cannot unlink
   another tenant's file.

### SEC-03 - Close confirmed nested-ID defects (P0)

Member statistics:

- load the requested user through `workspace_members JOIN users` using both
  `workspace_id` and `user_id`;
- return 404 without name or email disclosure when membership is absent.

Access-review mutation:

- load an open review by `(review_id, workspace_id)` inside a transaction;
- update its item only through the verified parent;
- validate the decision enum;
- require exactly one changed row;
- perform any membership removal only for that verified item's user and the
  same workspace;
- make the audit write strict inside the transaction.

### SEC-04 - Add structural access-review scope (P1)

Use an additive forward migration allocated after the stabilization tranche:

1. establish uniqueness for `(id, workspace_id)` on `access_reviews`;
2. rebuild `access_review_items` with `workspace_id NOT NULL`;
3. backfill workspace IDs through the parent review, failing on orphans;
4. add a composite foreign key from `(review_id, workspace_id)` to the parent;
5. index `(workspace_id, review_id)`;
6. update all writers to include the workspace ID;
7. require row-count parity and a clean `PRAGMA foreign_key_check`.

Do not add a blanket basename constraint to `evidence.stored_path`; virtual DDQ
references must first be separated from physical storage objects.

### SEC-05 - Move toward tenant-owned storage objects (P2)

Add an `upload_objects` registry with, at minimum:

- `firm_id`;
- generated `storage_key`;
- storage kind;
- content hash;
- size and MIME type;
- created and deleted metadata;
- uniqueness on `(firm_id, storage_key)`.

Migrate evidence, generated-document sources, supplier documents,
questionnaire attachments, DDQ evidence, TPRM condition evidence, and workspace
branding to object references. Keep virtual references in a separate typed
field rather than overloading filesystem paths.

### SEC-06 - Make audit-trail claims accurate (P1/P2)

- Require strict audit writes for destructive, approval, withdrawal, access,
  and assurance decisions.
- Add database guards preventing ordinary update or delete of retained audit
  rows.
- Describe the current chain as tamper-evident, not immutable.
- Before making a stronger claim, publish signed chain-head checkpoints to an
  independent location with separately controlled key material.

### SEC test gate

Add or extend tests covering:

- foreign member statistics and PII non-disclosure;
- foreign review/item combinations and mixed own-parent/foreign-child IDs;
- closed-review mutation rejection;
- composite-FK violations;
- traversal, absolute paths, Windows separators, NULs, URI tokens, and symlink
  escapes;
- identical basenames in two firm directories;
- safe deletion and workspace deletion without cross-firm effects;
- arbitrary legacy brand paths;
- physical path containment in portal, auditor, supplier, and TPRM flows.

SEC exit criteria:

- every enabled pilot endpoint and nested resource appears in the reviewed
  boundary inventory;
- the inventory contains no unscoped child lookup or direct filesystem access;
- two-firm hostile fixtures produce zero foreign reads or writes;
- no file outside the current firm's root can be read or deleted;
- the storage inventory contains no unresolved unsafe physical key;
- the access-review migration preserves rows and passes FK checks;
- no existing authorization test regresses.

## 8. REC: independent recovery and operations

### REC-01 - Finish the recovery generation foundation (P0)

Preserve and finish the current signed database-plus-upload generation work.
Require:

- one committed manifest written last;
- database integrity verification;
- upload path, size, and SHA-256 verification;
- database-to-physical-file reference reconciliation;
- grouped retention for all generation artifacts;
- explicit RPO age failure;
- exact-generation restore and materialization into an empty destination;
- no live-path promotion by the restore utility.

### REC-02 - Make the second copy mandatory and independent (P0)

Production readiness must fail unless a configured recovery destination is in a
different failure domain from the live data. A second directory on the same
Lightsail root volume is not sufficient.

For the supported Lightsail profile:

1. mount or configure independent object or network storage;
2. expose it to the backup process only at the dedicated mirror destination;
3. verify it is not nested, aliased, or on the same underlying storage device
   as the live database and uploads;
4. upload the database and uploads first and the signed manifest last;
5. verify remote hashes and retain a remote object/version receipt;
6. retain generations under version-locked or WORM controls for the approved
   retention period;
7. give the production backup identity append-only permission: it may create a
   new generation but cannot overwrite or delete a retained one;
8. reserve retention changes and deletion for separately administered recovery
   credentials;
9. report backup success only after the independent receipt exists;
10. fail the backup if the independent copy cannot be committed.

The local generation may remain as a convenience copy, but it does not satisfy
the disaster-recovery gate.

### REC-03 - Separate and prove key escrow (P0)

- Keep the master key out of all recovery generations.
- Remove the production key value from the same-host application `.env`.
  Retrieve it from separately administered secret custody at boot into memory or
  a root-only ephemeral file.
- Record and display its fingerprint, never the key.
- Require an operator acknowledgement tied to the fingerprint and escrow
  location before production promotion.
- During the fresh-host drill, supply the key from escrow rather than copying it
  from the original host.
- Document rotation and loss procedures separately from data restoration.

### REC-04 - Run restore verification from an independent control plane (P0)

The current in-process monthly local drill remains useful defense in depth, but
it cannot be the authoritative disaster-recovery proof. A separately operated
monthly runner must retrieve the off-host generation and escrowed key without
depending on the production instance. It must:

- verify an exact recent off-host generation;
- enforce the production RPO age limit;
- write a structured result outside the production database with generation
  ID, start/end time, database
  integrity, upload counts, and failure reason;
- surface the latest result on the system page and readiness diagnostics;
- alert a named operator on failure.

### REC-05 - Add external logs, monitoring, and alerting (P0)

The host must not be the only place where failure is recorded. Alert externally
for:

- backup failure or stale generation;
- mirror failure;
- restore-drill failure or staleness;
- low disk space and excessive retained-image usage;
- memory pressure or repeated container recovery;
- malware-definition update failure;
- public HTTPS health failure;
- transactional-email failure.

Ship application, security, audit-integrity, deployment, backup, restore, and
host logs to independently retained storage. Run the alert heartbeat and public
HTTPS check outside the production host.

Do not silently force-recreate an unhealthy container indefinitely. Rate-limit
recovery attempts and alert after the first failed recovery cycle.

### REC-06 - Prove fresh-host recovery (P0)

Execute a timed drill using a disposable host:

1. start with no repository checkout, database, uploads, local backup, or key;
2. retrieve a reviewed application version independently;
3. retrieve one off-host recovery generation;
4. retrieve the matching key from escrow;
5. materialize and inspect the recovery report;
6. restore into private live paths while ingress is blocked;
7. start the pinned image and require exact-version readiness;
8. verify representative users, evidence downloads, hashes, and audit history;
9. record achieved RTO and restored-data age;
10. destroy the disposable environment after retaining the drill evidence.

Pilot recovery objectives must be approved before the drill:

- service RPO: no more than 24 hours of customer data loss;
- backup-freshness failure threshold: 26 hours;
- service RTO: no more than four hours from declared original-host loss to
  successful outside-in HTTPS and representative business smoke checks.

The clock may pause only for a documented external provider outage outside the
supported recovery design. Targets cannot be relaxed after observing a failed
drill without a recorded risk acceptance that blocks pilot launch.

### REC-07 - Retain immutable release artifacts independently (P0)

Publish every reviewed current and rollback image to an independent registry and
pin deployments by immutable digest. A disaster must not require rebuilding an
old image from source on the lost host. The operational preflight must verify
that both current and immediate rollback digests remain retrievable.

Keep `/healthz` as liveness and `/readyz` as application configuration
readiness. Add a separate host-side operational preflight for backup receipt,
key fingerprint mapping, independent drill freshness, remote image availability,
disk/inode headroom, and external alert heartbeat. Initial launch and normal
deployment must fail before ingress or live-database changes when that preflight
fails.

REC exit criteria:

- losing the original host does not remove the only database, upload set,
  generation, key, logs, or alerting path;
- compromise of the production backup identity cannot overwrite or delete
  retained off-host generations;
- a fresh host serves restored records within the declared RTO;
- restored data is within the declared RPO;
- the monthly drill and external alert path have both been observed working;
- independently retained logs and current/rollback image digests survive loss
  of the original host;
- rollback and recovery runbooks distinguish code rollback from data restore.

## 9. ASM: truthful outputs and optional assurance semantics v2

### ASM-P - Minimum truthful pilot behavior (P0/P1)

The design-partner pilot must not wait for a new assurance platform, but it also
must not expose the unsafe current semantics. Before the pilot:

- apply the FND claim containment everywhere;
- stop automatic suitable, sufficient, effective, approved, and frozen
  conclusions and synthetic review events;
- expose imported and assessed states only as management-reported status or gap
  assessment;
- require explicit human review before publishing an audit-support output;
- disable Stage 1/2 readiness verdicts and external assurance reports for the
  pilot cohort;
- keep other frameworks' external assurance outputs disabled.

This is the safe minimum fix. It lets Nimbus validate engagement orchestration,
cutover, requests, evidence handling, and controlled reporting without claiming
that it has performed assurance.

### ASM-01 - Correct the evidence read model (P1)

Build one canonical assurance projection that separates:

- attachment coverage;
- currency or expiry;
- reviewer-assessed relevance;
- period and scope alignment;
- approved conclusion coverage.

Count distinct evidence IDs across compatibility link paths. One dual-linked
file must count once. Upload age may indicate currency, but it must never stand
in for the operating period.

### ASM-02 - Decide whether assurance v2 is demanded (P2 decision gate)

After the first 30 days of the design-partner pilot, obtain explicit evidence
on whether buyers need Nimbus to record and support formal test and assurance
conclusions, rather than orchestrate consultant work and controlled outputs.

- If demand is not validated, keep unsafe assurance surfaces disabled and do
  not build the model below.
- If demand is validated, approve a separately capped ASM-V2 implementation
  tranche before limited availability.

### ASM-03 - Add an additive v2 model (P2, demand-gated)

Do not rewrite migration `026` or mutate retained snapshot hashes. Add new
tables after the current migration head for:

- scoped client-control instances;
- many-to-many workpaper/control links;
- test executions with objective, procedure, scope, period, population, sample,
  results, and exceptions;
- evidence reviews recording relevance, reliability, scope alignment, period
  alignment, support or contradiction, reviewer, and time;
- immutable conclusion versions separating management assertion, design,
  implementation, operating effectiveness, evidence judgment, rationale,
  author, reviewer, approval, period, and content hash;
- explicit legacy-projection classification.

The existing requirement-level workpaper may remain as a compatibility header.
New assurance conclusions must be derived from v2 records, not its legacy
conclusion columns.

### ASM-04 - Preserve legacy history without laundering it (P2)

- Classify current generated workpapers as legacy requirement projections and
  unverified for v2 assurance.
- Preserve their IDs, review rows, snapshot payloads, and hashes verbatim.
- Do not infer client controls, test procedures, evidence periods, reviewer
  judgments, or operating conclusions.
- Exclude legacy projections from approved v2 metrics.
- Keep v1 readers behind workspace-scoped compatibility flags until v2 parity
  and rollback are proven.

### ASM-05 - Stop synthetic assurance events in v2 (P2)

Assessment-pass completion may create an immutable management-status or gap
projection. It must not automatically:

- translate `Implemented` into suitable, sufficient, or effective;
- mark every linked artifact relevant;
- invent submission, approval, or freeze events;
- create a conclusion attributed to an independent reviewer.

A governed assurance workpaper requires a scoped client control, objective,
procedure, and period. An operating conclusion additionally requires population,
sample, results, and exceptions. Evidence sufficiency requires explicit evidence
reviews and independent approval.

### ASM-06 - Replace readiness with preparation plus traceability (P2)

The v2 internal preparation view must trace:

```text
applicable SoA requirement
-> active scoped client control
-> current approved conclusion
-> test period, population, sample, result
-> reviewed evidence and hashes
-> exceptions and related findings
```

Remove universal rules that two files or a 90-day-old upload establish readiness.
Any remaining methodology heuristic must be configurable, versioned, and shown
to the user. A missing link means not evaluated, not passed.

### ASM-07 - Cut reports over safely (P2)

- Add `schema_version: 2` to v2 report inputs and snapshots.
- Render reports only from frozen v2 conclusion versions.
- Include requirement, client control, conclusion hash, test period, population,
  sample, result, evidence reviews and hashes, exceptions, limitations, and
  reviewer identity.
- Keep legacy reports available with a prominent legacy/unverified banner.
- Do not perform a pre-pilot semantic rewrite of DPDPA or other frozen modules.
  Keep their external assurance outputs disabled. Each module must later apply
  the same no-inference rule before its own launch gate can pass.

### ASM rollout flags

Use workspace-scoped, temporary migration flags for:

- v2 write;
- v2 read;
- v2 reports.

Roll out in that order to seeded fixtures, then one pilot workspace. Stop v1
writes only after reconciliation. Remove legacy fields or constraints only in a
later, separately approved demolition migration.

### ASM test gate

Required tests include:

- dual-linked evidence counts once;
- arbitrary attachment copies cannot produce sufficiency;
- `Implemented` cannot create suitable, sufficient, effective, approved, or
  frozen conclusions;
- multiple controls and test cycles can coexist under one requirement;
- client controls and test records cannot cross workspaces;
- no fake approval events are created by pass completion;
- status, file count, and upload age alone cannot pass preparation gates;
- every green v2 result reconciles to an approved conclusion;
- legacy rows remain readable while producing zero v2 approved conclusions;
- migration replay, snapshot hash parity, and rollback flags work;
- v2 report traceability is complete and deterministic.

ASM pilot-ready exit criteria:

- all unsafe assurance claims and synthetic events are removed or disabled;
- pilot outputs state management-reported status and limitations only;
- external readiness and assurance surfaces are inaccessible to the pilot
  cohort.

ASM-V2 exit criteria, if that tranche is approved:

- neither status, attachment count, nor upload age can independently produce
  sufficient, effective, approved, frozen, or ready;
- all v2 external conclusions have a complete, independently approved trace;
- no legacy snapshot or review history is silently rewritten;
- methodology and limitations are visible in every controlled output.

## 10. CUT: governed migration and activation

### CUT-01 - Define the first migration contract (P1)

Start with a concierge-operated, host-side import bundle. Do not build a generic
self-service importer before observing real source variation.

In scope:

- engagement identity, contracted outcome, target date, and assessment period;
- scope statement and included or excluded organizations, locations, systems,
  and services;
- consultant, reviewer, and client roster with invitations staged but unsent;
- ISO reference, status, applicability, maturity, notes, owner, due date, and
  inclusion or exclusion rationale;
- assets and risks through existing validated import machinery;
- open remediation actions needed to continue the engagement;
- documents and evidence via manifest plus ZIP payload, with filename, type,
  version, status, date, owner, hash, ISO references, and expiry.

Explicitly defer closed historical tasks, email archives, comments, arbitrary
SharePoint hierarchy, custom fields, integrations, and non-ISO modules.

### CUT-02 - Use source-specific transformations first (P1)

For the first three engagements, use versioned, host-side transformation scripts
written against each approved source pack. Do not build a generic staging and
mapping platform in advance.

Every script must still emit an immutable reconciliation receipt containing:

- source and payload hashes;
- script version and operator;
- validation and normalization issues;
- stable-reference mappings;
- explicit row disposition: imported, duplicate, rejected, or deliberately
  excluded;
- created-ID mapping;
- deterministic rerun and idempotency result;
- commit state and completion time.

Import sequence:

1. quarantine upload;
2. inspect files and validate structure;
3. normalize stable ISO references;
4. preview every disposition;
5. obtain consultant reconciliation and sign-off;
6. take a pre-cutover recovery generation;
7. place validated files into immutable tenant storage and verify their hashes;
8. commit database references and business rows in one SQLite transaction;
9. record the committed state and verify row and file reconciliation;
10. keep invitations disabled until scope and baseline acceptance;
11. produce a signed import report;
12. garbage-collect abandoned quarantined files only after the rollback window.

Database rows and external files cannot share one atomic transaction. Treat the
operation as a crash-safe two-phase protocol and inject failure before file
placement, after file placement, during the database transaction, and before
receipt finalization. A retry must either complete idempotently or leave the
prior live engagement unchanged.

Productize a reusable importer only for fields and mappings observed in at least
two independent source packs. Until then, source-specific code and receipts are
the intended design.

Never import old signatures, approvals, or audit events as if Nimbus generated
them. Preserve them as attributed legacy source records or attachments.

### CUT-03 - Reuse truthful baseline adoption (P1)

For a complete imported current state, use the existing controlled baseline
adoption mechanism with source timestamps, digest, non-retrospective disclosure,
and independent sign-off. For partial assessments, import only known management
conclusions and continue a `Baseline verification` Pass 1. Never fabricate
retrospective interviews, procedures, answers, or evidence reviews.

Use a short shadow-validation window before formal cutover. During that window,
reconcile both sources but allow edits only through a named procedure. After
formal acceptance, make the old tracker read-only and start a documented
rollback window. Measure `no parallel edits` only after formal acceptance.

### CUT-04 - Replace workspace-created onboarding (P1)

Pilot activation requires:

1. pilot owner and support contact;
2. ISO engagement classified as new or migrate-active;
3. import reconciled, where applicable;
4. scope confirmed;
5. lead and independent reviewer assigned;
6. baseline adopted or Pass 1 started;
7. first client request sent;
8. first evidence accepted;
9. first governed report generated.

Imported scope facts should prefill intake answers, and the user should be asked
only for missing required information. The workspace remains private until
reconciliation. Navigation should show role-specific next actions rather than
exposing every product module.

### CUT-05 - Add an explicit pilot cohort model (P1)

Do not reuse migration feature flags as commercial entitlements. Add explicit
pilot firm or workspace state and enforce ISO-only pilot scope on the server and
in the UI. Existing modules stay intact but are unavailable to the pilot cohort.

### CUT test gate

- 100 percent of source rows receive an explicit disposition;
- no silent row or file loss;
- deterministic rerun produces no duplicate business records;
- automatic stable-reference mapping reaches at least 95 percent on agreed
  source packs;
- identity, tenant, ISO reference, scope, applicability, ownership, evidence
  provenance, and retained-file mappings are 100 percent correctly disposed and
  reviewed before activation;
- source-to-target totals and hashes reconcile;
- invitations cannot escape staging;
- rollback restores the matching code, database, and uploads generation;
- two-firm import fixtures cannot cross tenant boundaries;
- imported legacy evidence cannot become a v2 approved conclusion without
  review.
- crash injection at every two-phase boundary leaves either a complete import or
  a recoverable pre-import state.

## 11. PIL: ISO 27001 design-partner pilot

### PIL-01 - Pilot shape

Run a paid, time-boxed pilot with two ISO 27001 consulting firms and three live
engagements:

- one in-flight gap-only engagement;
- one in-flight certification-support engagement;
- one net-new certification-support engagement.

Each partner must provide a named champion, lead consultant, source pack before
pilot execution, weekly review attendance, permission to measure support effort,
and authority to make the prior tracker read-only at cutover. Use a redacted
representative sample under NDA for commercial scoping. Accept live client data
only after the pilot agreement, data-processing terms, retention schedule, and
deletion procedure are executed.

Testable promise:

> An approved source pack becomes an operational Nimbus engagement within two
> business days and eight consultant/operator hours, then proceeds through a real
> client request, evidence review, assessment pass, and controlled deliverable
> without duplicate spreadsheet entry.

The eight-hour limit includes all loaded implementation work: source analysis,
transformation, correction, deployment, training, engineering intervention, and
support. It is not limited to visible consultant or operator time.

### PIL-02 - Instrument activation without polluting the audit log

Add a separate, privacy-minimal pilot event stream. It must not contain source
content and must not overload `audit_log`.

Before collection, document purpose, tenant visibility, access control,
retention, deletion, clock source, event deduplication, and the exclusion of
personal and source content.

Record timestamps for:

- import upload, preview, approval, and commit;
- baseline acceptance;
- scope confirmation;
- team and reviewer assignment;
- invitation and acceptance;
- first request;
- first evidence upload and acceptance;
- pass start and sign-off;
- report generation and publication;
- prior-tracker retirement.

### PIL-03 - Weekly scorecard

Measure:

- elapsed time and human hours to preview, commit, activation, first request,
  first accepted evidence, and first deliverable;
- automatic mapping, rejection, correction, and rerun rates;
- consultant and client activation and return;
- request-to-evidence cycle time;
- edits made to the old tracker after cutover;
- support sessions and hours;
- P0/P1 incidents and correlated 4xx/5xx failures;
- engagement outcome and paid renewal decision.

### PIL-04 - Safety stop rules

Pause the affected pilot immediately for:

- suspected cross-tenant access;
- evidence loss, corruption, or unrecoverable hash mismatch;
- inability to restore within the declared RTO/RPO;
- an external output representing an unreviewed conclusion as approved;
- silent import omission or invented provenance;
- any unresolved P0 security or data-integrity incident.

These are universal gates across all pilot engagements. One safety failure
cannot be offset by two efficient engagements.

### PIL-05 - Define measurement clocks before contracting

- Cutover clock: starts when the complete approved source pack is available and
  ends at formal source-to-target reconciliation acceptance.
- First-request clock: starts at formal cutover acceptance and ends when a real
  client request is successfully delivered.
- First-evidence clock: starts at formal cutover acceptance and ends when the
  consultant accepts one real evidence submission.
- First-deliverable clock: starts at formal cutover acceptance and ends when a
  human-reviewed controlled output is published; proposed maximum is ten
  business days.
- Recurring-support clock: begins after activation week two and must meet its
  threshold for four consecutive weeks.

Pauses require a recorded client-caused dependency outside the contracted input
requirements. Engineering defects and internal resource constraints never stop
the clock.

### PIL exit criteria

All three engagements must meet the safety, containment, provenance, recovery,
and no-silent-loss gates. At least two of three must meet the following
efficiency and adoption targets:

- cutover within two business days;
- partner-two labor at or below eight hours;
- all ISO catalogue items accounted for before complete-baseline adoption;
- first client request within three business days;
- first accepted evidence within five business days;
- no edits to the parallel tracker after cutover;
- one real pass, reviewed output, and client handoff completed without manual
  re-entry;
- no P0/P1 security, isolation, recovery, provenance, or integrity incident;
- support falls below one hour per active engagement per week after week two;
- both economic buyers execute a paid follow-on order, pay a renewal invoice, or
  sign a binding renewal at recorded price and scope. A free or nominally priced
  continuation does not satisfy the commercial gate.

If the gate fails, fix import, activation, assurance, or support operations. Do
not reopen the feature-expansion roadmap.

## 12. COM: commercial and launch decision

### COM-00 - Freeze the economic gate before signing (P0)

Before any pilot agreement is signed, approve a commercial control sheet with
exact currency values and named approvers for:

- pilot price and payment schedule;
- included setup hours;
- loaded labor rates by role, including founder and engineering time;
- infrastructure and maintenance allocation;
- minimum implementation contribution margin, proposed floor 60 percent;
- minimum recurring gross margin, proposed floor 70 percent;
- included recurring support hours;
- maximum unbilled customization, proposed default zero after the approved
  partner-one learning allowance;
- partner-one internal learning cap, proposed 16 hours;
- partner-two all-in activation cap, eight hours.

These values cannot be changed after results are observed without a recorded
exception that disqualifies the affected engagement from the commercial gate.

### COM-01 - Separate implementation from subscription economics

For each partner, record:

- implementation and migration hours;
- training and support hours;
- founder engineering, deployment, recovery, and incident hours;
- infrastructure and maintenance allocation;
- custom correction work;
- recurring support after activation;
- revenue, loaded delivery cost, and contribution margin.

The standard setup fee should include a fixed hour allowance. Excess work is
explicitly priced, not hidden in recurring revenue. Partner one may have a
larger learning allowance; partner two must demonstrate the repeatable target.

### COM-02 - Approve one product claim

Before general availability, approve a single, evidence-backed promise. The
candidate is:

> Nimbus helps ISO 27001 consultancies move a live engagement from working files
> into a governed collaboration and reporting workflow on infrastructure they
> control.

Do not position the product as an all-in-one compliance automation platform or
as an auditor substitute.

### COM-03 - Limited-availability gate

The first two-firm, three-engagement cohort is design-partner discovery. Passing
it may authorize an ISO 27001-only limited-availability cohort, not general
availability.

Limited availability requires:

- all universal safety gates across all three engagements;
- at least two of three meeting the efficiency and adoption gates;
- SEC, REC, ASM pilot-safe, and CUT exit criteria complete;
- executed paid follow-on proof from both economic buyers;
- approved support ownership, claims, limitations, and runbooks.

### COM-04 - General-availability gate

Before general availability, run a second cohort with at least three additional
firms, six engagements, and three materially different source-pack formats. A
documented implementation operator other than the founder must lead the work.
The founder may handle escalations, but founder intervention must be measured
and remain within the pre-approved cap.

General availability requires:

- SEC, REC, applicable ASM, and CUT exit criteria complete;
- design-partner and limited-availability gates complete;
- universal safety gates across every cohort-two engagement;
- at least five of six cohort-two engagements meeting the approved time, labor,
  support, and margin thresholds;
- executed paid follow-on proof from at least two cohort-two economic buyers;
- documented support ownership and escalation;
- approved backup, restore, incident, and release runbooks;
- approved claims and limitations;
- modeled contribution margin meeting the product owner's threshold;
- an explicit go/no-go decision recorded by product, security, operations, and
  GRC methodology owners.

Only after that decision should the roadmap compare OIDC/SSO, read-only API,
additional import automation, one evidence integration, SOC 2, or broader module
investment. The next item must be selected from observed customer pressure.

## 13. Proposed calendar, effort caps, and stop rules

These dates assume two implementation tracks plus part-time independent
security, operations, GRC, and commercial reviewers. They are planning bounds,
not promises. Rebaseline once, before approval, after named people and actual
capacity are known. After approval, a missed cap triggers a stop/defer decision,
not silent scope growth.

| Milestone | Proposed target | Delivery cap | Named owner | Named approver |
|---|---|---|---|---|
| Plan and commercial control sheet approved | 2026-09-02 | 2 person-days | TBD | TBD |
| FND baseline and claim containment | 2026-09-11 | 1 engineer-week plus review | TBD | TBD |
| SEC P0 containment gate | 2026-10-09 | 3 engineer-weeks plus security review | TBD | TBD |
| REC P0 independent-recovery gate | 2026-10-09 | 3 engineer-weeks plus witnessed drill | TBD | TBD |
| ASM-P pilot-safe output gate | 2026-10-23 | 1.5 engineer-weeks plus GRC review | TBD | TBD |
| Two source-pack dry runs and CUT scripts | 2026-11-13 | 3 engineer-weeks plus reconciliation | TBD | TBD |
| PIL-A design-partner cohort | 2027-02-12 | 90 calendar days; commercial hours capped separately | TBD | TBD |
| ASM-V2, only if demand gate passes | Before limited availability | 6 engineer-weeks plus assurance review | TBD | TBD |
| Limited-availability cohort | 2027-05-28 | 90 calendar days | TBD | TBD |
| General-availability decision | 2027-06-18 | 3 person-days | TBD | TBD |

Execution may not start while any required owner or approver remains `TBD`.
Each workstream issue must carry its target date, effort cap, dependency, and one
of these overrun decisions:

- stop and redesign;
- defer outside the launch gate;
- replace lower-priority scope within the same cap;
- approve a documented exception that identifies the delayed milestone.

No exception may waive a universal safety gate.

## 14. Ownership and independent approval

| Workstream | Delivery owner | Required independent approver |
|---|---|---|
| FND | Engineering lead | Product owner |
| SEC | Security-focused engineer | Independent security reviewer |
| REC | Operations owner | Recovery-drill witness |
| ASM | GRC methodology owner plus engineer | Independent assurance practitioner |
| CUT | Implementation lead plus engineer | Pilot consultant reconciling source data |
| PIL | Product or implementation owner | Design-partner champion |
| COM | Product owner | Commercial/finance owner |

The person who implements a security, assurance, or recovery gate must not be
the only person who approves its closure.

For assurance work, independent means the approver is not the author, importer,
tester, client-control owner, or conclusion owner; has documented competence for
the method; is an authorized member of the workspace; and has no unresolved
conflict. Conflicts require reassignment, not a checkbox waiver.

## 15. Cross-cutting verification matrix

Every implementation branch must run the smallest relevant focused suite plus
the full discovered suite before merge.

| Change class | Required verification |
|---|---|
| Route, authorization, or tenant scope | focused hostile two-firm tests, `npm run test:security`, `npm run test:routes`, `npm test` |
| File storage or deletion | unsafe-path corpus, symlink tests, two-firm file tests, workspace-deletion tests, `npm test` |
| Migration | fresh database, copied realistic database, replay, row parity, FK check, checksum update, rollback-flag test |
| Assurance semantics | v1/v2 reconciliation, no-inference tests, independent-review tests, deterministic report tests, `npm test` |
| Recovery or deployment | backup/restore suite, exact-generation test, production image smoke, fresh-host drill evidence |
| Import | dry-run reconciliation, deterministic rerun, rollback generation, two-firm boundary tests, malformed-source corpus |
| UI claim or onboarding | claim scan, route walk, browser workflow, controlled-output review |

Manual gates are required where automated tests cannot establish the outcome:

- an assurance practitioner reviews the v2 conclusion trace;
- a security reviewer attempts cross-tenant and path-boundary abuse;
- an operator performs the fresh-host recovery drill;
- a pilot consultant reconciles every imported source row;
- a partner champion confirms retirement of the prior tracker.

## 16. Principal delivery risks

| Risk | Mitigation |
|---|---|
| Current dirty changes are accidentally overwritten | Preserve and land the stabilization tranche first; isolate workstreams in separate branches/worktrees |
| A destructive schema rewrite damages retained outputs | Use additive v2 tables, retain IDs and hashes, and defer demolition |
| Legacy rows are silently upgraded into false assurance | Mark them legacy/unverified and infer nothing |
| Path hardening makes real files unreachable | Inventory first, migrate with copy-and-hash verification, retain rollback copies |
| Importer fabricates provenance | Store source hashes and dispositions; never import old approvals as native events |
| Readiness labels change but logic remains misleading | Separate interim claim containment from the v2 semantic cutover and test both |
| Off-host mirror is actually another directory on the same disk | Verify the independent storage boundary and prove restore after original-host loss |
| Pilot mode creates a permanent product fork | Use cohort/entitlement state, not divergent code branches |
| Early revenue hides excessive service cost | Meter implementation and support hours and enforce contribution-margin gates |

## 17. Milestone definitions and completion

- **Pilot-ready:** FND, SEC P0, REC P0, ASM-P, and two CUT dry runs pass. The
  posture is a controlled ISO 27001 design-partner pilot.
- **Limited-availability-ready:** PIL-A passes, the ISO 27001 SKU and commercial
  controls are approved, and ASM-V2 either passes or the assurance surfaces
  remain disabled because demand was not validated.
- **General-availability-ready:** the independent second cohort and COM-04 pass
  and the four required owners record an explicit go decision.

This remediation program is complete only when all of the following are true:

1. The exhaustive SEC inventory is complete and no P0/P1 tenant or
   file-containment defect remains open.
2. Original-host loss has been survived in a witnessed fresh-host recovery.
3. Status, file count, and upload age cannot create an assurance conclusion.
4. If any external assurance conclusion is enabled, it is v2 and traces to
   scoped controls, tests, reviewed evidence, exceptions, and independent
   approval. Otherwise those surfaces remain disabled.
5. A real in-flight engagement has been imported with complete source-row
   disposition and no invented history.
6. Both cohorts satisfy their universal safety gates, and the required number of
   engagements satisfy the efficiency and adoption gates without
   shadow-spreadsheet updates.
7. Support effort and contribution margin meet the approved commercial gate.
8. Product, security, operations, and GRC methodology owners record an explicit
   general-availability decision.

Before the pilot-ready gate, the posture is internal development only. Between
pilot-ready and limited-availability-ready, it is a controlled ISO 27001
design-partner pilot. Between limited availability and the COM-04 decision, it
is an ISO 27001-only limited release, not general availability.
