# Experience implementation and rollout

The redesign is implemented in the existing Node, SQLite and EJS application. This is an engineering delivery and pilot candidate, not a verified 9/10 experience. On 5 September 2026 the product owner confirmed that representative participants are not yet available, so user validation remains pending.

The original critique is retained in `reports/ux-audit-2026-09-05.md`. Its persona scores are heuristic audit judgements, not participant measurements or a recorded task-time baseline. The pilot must collect paired baseline and redesigned task measurements using the retained interface and the same task scripts.

## What changed

| Area | Implemented behaviour |
| --- | --- |
| Client collaboration | The first Home card opens the next task or decision directly. My actions uses the shared projection, Mine/Team views, separate actionable/waiting/blocked/completed work, and pagination. Released unassigned requests remain coordinator exceptions. Request and deliverable detail pages retain files, discussion, history, purpose and actions. Coordinators delegate among existing members and respond with attribution. |
| Reliable responses | Evidence uploads show progress and failures without replacing the response form. Submission waits for selected uploads. Request notes, comments and approval notes have actor-scoped server drafts. A successful upload updates only its uploader's matching response draft basis atomically. |
| Consultant continuity | My work is the firm landing destination for consultants. The engagement shell exposes Overview, Work, Programmes, Evidence & documents, Reports and Team & settings. Assessment guidance and Copilot assistance remain available in expandable sections. Queue links carry filters and return context. |
| Manager oversight | A common queue, overview, calendar and workload use authorized source records. Filters cover programme, owner, reviewer, deadline, priority and waiting party. Counts link to their records. Workload describes recorded commitments and estimates, not inferred capacity. |
| Draft integrity | Autosaves affect personal storage only. Integer source versions, draft revisions, generations and mutation receipts protect formal saves. Skip retains private work; Discard removes unapplied edits. Validation and version conflicts retain entered values for comparison. ISO 27001 and ISO 42001 diagnostic responses use stable question identity and retain wording and answers in history. Earlier private assessment drafts can be previewed and copied into an empty current pass; positional answers are never guessed after wording changes. |
| Independent review | ISO 27001 and ISO 42001 review requests retain the requested version and immutable review events. The requester/latest preparer cannot approve their own work. An edited or superseded request must be submitted again. State, audit and notification events commit together. |
| Report lineage | Every independent ISO 27001 pass completion creates an immutable manifest and exact workpaper snapshots, even where a previous workpaper is frozen. All completion generations remain inspectable. Pass-based reports use an explicit selected manifest. Issued artifacts remain unchanged; operational exports are labelled as regenerated. Request changes retains the original report and creates an attributable revision obligation for its author. A linked replacement needs independent approval before publication. |
| Read and authority boundaries | Opening work queues, assessment pages, SoA, risk settings or an empty delivery cockpit does not create domain records. Starting delivery is an explicit POST action. Current account, membership and granular permissions govern both available actions and mutations. Request creation/release, coordination, response, evidence review and cancellation have distinct capabilities; explicit granular denials override the legacy firm bundle. Inactive or inaccessible owners remain visible as assignment exceptions. |
| Notifications | Recipient-specific receipts isolate reads/dismissals. A transactional outbox deduplicates events and rechecks access before sending. Retries preserve source events. Resend uses a stable provider idempotency key; other transports retain at-least-once delivery limitations. Historical notifications are not replayed as new mail. |
| Honest metrics | Commercial totals stay separated by currency. Recorded-cost margin is distinguished from forecast margin, which requires an estimated remaining cost. Coverage distinguishes source assessment/review/approval states and counts unique requirements. Programmes retain their native lifecycle rules. |
| Accessibility and phones | Shared theme and focus tokens, fixed cockpit contrast, labelled controls, task-first client and manager homes, responsive detail pages and native form fallbacks. Authenticated pages do not show campaign attribution prompts or collect campaign attribution. |

The common projection covers ISO 27001, CSF, ISO 42001, DPDPA, TPRM and vCISO. It does not create another task database or a generic status mutation endpoint. Native programme services continue to enforce their own approval, snapshot, client-decision and service-period rules. A cross-programme work count is not a combined readiness percentage.

The new personal assessment-draft and canonical diagnostic editor is implemented for ISO 27001 and ISO 42001. CSF, DPDPA, TPRM and vCISO retain their native editors and governed snapshot/decision workflows within the common navigation and work projection. The new ISO 27001 pass-manifest model does not replace those programme-specific report sources or turn ISO 42001 fieldwork completion into independent approval.

## Validation evidence

The final full regression run passed **618 tests** across 90 suite files, plus **83 smoke assertions** and **288 GET routes without server errors**. Chrome passed 10 workflow checks, 144 role/programme journeys and 144 accessibility-tree/focus checks; the final layout refresh passed 24 checks. The source verification record is in `reports/experience-engineering-results.json`.

Automated evidence is retained in the repository:

- `tests/draft-recovery.test.js`: private/formal separation, recovery, history, diagnostics, integer concurrency, atomicity and idempotency.
- `tests/assessment-review.test.js`, `tests/consultant-lineage.test.js` and `tests/report-revisions.test.js`: independent exact-version review and retained pass/report provenance.
- `tests/form-drafts-browser.test.js`: browser draft conflicts, refresh/discard races, correct Request changes destinations and duplicate submission suppression.
- `tests/iso42001-draft-experience.test.js`: native save/Skip, canonical diagnostics and read-only assessment/SoA pages.
- `tests/client-collaboration-experience.test.js`: delegation, approval authority, upload/draft handoff, recipient isolation and outbox retries.
- `tests/work-projection.test.js` and `tests/experience-upgrade.test.js`: authorization, complete counts/pagination, read-only projections and populated/fresh upgrades.
- `tests/work-performance.test.js`: disposable fixture with 50 clients, 11,450 work records (10,000 seeded tasks/requests/workpapers plus 1,450 native delivery records), 44.8 MB of private source text, and 1,000 evidence metadata records per client.
- `tests/experience-browser.js`: Chrome role/programme matrix, responsive layouts, keyboard/accessibility-tree checks, draft recovery and client handoffs. Results and screenshots are in `reports/experience-browser/`.

The final full-suite fixture measured **446 ms projection p95** and **447 ms overview HTTP p95**. The measurements and regression totals are recorded in `reports/experience-engineering-results.json`. Performance uses 20 samples on a local disposable SQLite fixture. It excludes deployed browser paint, large report histories, upload latency and AI processing. Repeat the benchmark on the supported deployment profile before accepting its two-second primary-content criterion.

Automated browser accessibility checks do not replace a real screen-reader session. No participant ratings, unassisted task-success percentages, ten-second recognition rates or navigation-time improvements have been fabricated. Those release measures remain pending.

## Deployment and rollback

Migrations are additive and preserve existing identifiers and audit history. Keep the migration files and their checksum manifest together when deploying. The populated upgrade test starts at migration 061, applies additive migrations 062–066, compares retained values and hashes, checks foreign keys/integrity and verifies that replaying the migration chain is a no-op.

Production presentation defaults to off. Development defaults to on. `EXPERIENCE_ENABLED=0` is an emergency interface rollback; `EXPERIENCE_ENABLED=1` overrides presentation enablement for an isolated development or pilot environment. Unset the variable when using per-firm settings. Flags never disable permissions, independent review, source version checks or canonical draft storage.

An operator can inspect or change a firm's cohort explicitly:

```sh
DB_PATH=/absolute/path/to/database node scripts/experience-rollout.js view FIRM_ID
DB_PATH=/absolute/path/to/database node scripts/experience-rollout.js enable FIRM_ID 1 iso-pilot
DB_PATH=/absolute/path/to/database node scripts/experience-rollout.js disable FIRM_ID
```

The ordered waves are ISO 27001, CSF, ISO 42001, DPDPA, TPRM and vCISO. A workspace with one programme automatically uses its wave; firm and mixed-programme work shells remain shared so outstanding obligations are not hidden. A configured cohort wave is still respected when `EXPERIENCE_ENABLED=1`; without a cohort that setting enables all six waves. Shared counts and native decisions remain available independently of presentation enablement. A firm's disable action clears its workspace presentation overrides and retains all canonical decisions, stored drafts and issued reports. Existing URLs and native specialist destinations remain available. Shared counts continue to represent authorized commitments during presentation rollout.

Before enabling a production cohort, use the existing backup/preflight procedure, run the isolated regression suite and confirm the actual deployment's latency and mail transport behaviour. No production deployment or live database modification was performed as part of this implementation.

## Pending user validation

Use `reports/experience-pilot-protocol.md` and the empty `reports/experience-pilot-template.json`. Recruit at least five genuine participants in each of the six groups. Establish paired baseline measurements and counterbalance task order, include recovery tasks, and retain failed observations after fixes.

`node scripts/evaluate-experience-pilot.js path/to/collected-results.json` fails closed for missing participants, ratings, task measurements or reliability evidence. Each group must independently meet mean ease and flow of at least 9/10, 95% unassisted task completion, 90% recognition of both the next action and its responsible person within ten seconds, and a 30% navigation/admin time improvement. Human validation and firm-by-firm production rollout remain pending until those results are demonstrated.

## Delivery status

The role workspaces, shared foundations, ISO journeys, programme adapters, regression harness and cohort controls are ready for an isolated pilot. Baseline participant timings, the representative-user pilot, a human screen-reader session, deployed primary-content timing and firm-by-firm production rollout remain pending. Passing engineering checks is not approval to label a released journey 9/10.
