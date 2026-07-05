# DPDP gap assessment: plan

Written 2026-07-05. Feature plan for a Digital Personal Data Protection Act,
2023 + DPDP Rules, 2025 gap assessment inside Compliance Sphere, taking a
client from "does this law even apply to us" through a scored gap register,
remediation worklist, and board-ready deliverables. Plan only; each phase
ends with a gate, same discipline as docs/tool-hardening-plan.md.

## Why this is a strong next feature

- The market timing is set by statute: the Rules were notified 13 November
  2025 (G.S.R. 846(E)) with phased commencement, so every Indian client of
  the firm has a running clock and most have not started.
- The firm's ISO 27001 work compounds: a large share of DPDP's security
  obligations (Rule 6: encryption, access control, logging, backups, breach
  detection) map onto Annex A controls the client has already assessed and
  evidenced in this tool. "Your ISO evidence already covers N of your DPDP
  gaps" is the pitch no standalone DPDP checklist can make.
- Penalty exposure gives prioritisation for free: the Act's Schedule caps
  (up to Rs. 250 crore for failure of security safeguards) let the register
  rank gaps by rupee exposure, not just severity labels.

## What already exists (verified)

1. **Content seed:** `archive/claude-blissful-einstein-ydMtk` holds
   `docs/dpdpa-gap-assessment.md` + `.csv`: 54 scored controls in 9 sections
   (notice; consent + Consent Manager; legitimate uses; general Data
   Fiduciary obligations; children and persons with disability; Significant
   Data Fiduciary; Data Principal rights; cross-border transfer) plus an
   applicability screening (Section 0), scoring summary, penalty-exposure
   and commencement-runway appendices. Every control cites its section of
   the Act or rule/Schedule of the Rules; nothing is inferred; items pending
   a Central Government notification are marked conditional.
2. **Framework machinery:** the converged catalog (frameworks, requirements,
   requirement_mappings, control_instances, evidence_requirement_links)
   already runs iso27001, iso42001, csf, and soc2. Adding `dpdp` is
   reference-data insertion, not schema invention.
3. **Feature blueprint:** ISO 42001 followed exactly the path DPDP needs
   (catalog → intake → gap wizard → SoA → readiness → exec brief) and lives
   in one module, routes/iso42001.js, as the reference implementation.
4. **Scattered DPDP touchpoints** in data/questionnaire-templates.js,
   assessment-questions.js, and iso-catalog.js already name DPDP as an
   applicable-law example; nothing structural.

## Product shape (decisions, stated not asked)

- DPDP is a **workspace-level framework** like iso42001: enabled per client
  via the framework picker, its own nav group, gated tiles.
- **Converged-native from day one.** No `dpdp_items` legacy-style table.
  Requirements live in the `requirements` table under a `dpdp` framework
  row; per-client state in `control_instances` keyed by requirement id. If
  a read view is needed (the iso27001 pages read `v_control_states`), that
  is one migration through the runner, nothing else touches schema.
- **Applicability is first-class, not an afterthought.** Per the worksheet,
  exactly two blocks are structurally conditional: 2B (Consent Manager
  obligations, only if the client is or registers as one) and Section 6
  (SDF, only if notified under §10(1)). Everything else is core; the
  Section 0 screening can still mark individual items Not Applicable (for
  example no children's data, no cross-border flows), with the screening
  answer recorded as the justification. The screening derives all of this;
  the consultant confirms rather than hand-toggling 54 rows.
- **Statutory fidelity is a hard rule.** Catalog entries carry their
  citation verbatim; anything the Act leaves to future notification stays
  marked conditional. Vijay reviews the catalog before it ships (he supplied
  the authoritative source for the worksheet).

## Phases

### Phase 0: content foundation

- Cherry-pick the archived worksheet + CSV into docs/ (done alongside this
  plan; the archive tag remains the provenance).
- Convert the 54 controls into `data/dpdp-catalog.js`. Per item: `ref`
  (e.g. `dpdp-s6.1` for Act sections, `dpdp-r6.2` for Rules), `title`,
  `citation` (verbatim source pointer), `diagnostic` (the current-state
  question), `conditions` (array drawn from: fiduciary, processor,
  consent_manager, sdf, children, cross_border; empty = always applies),
  `penalty_band` (Schedule reference + cap), `iso_refs` (Annex A crosswalk,
  empty where none), `remediation_hint`.
- A lint script asserts: refs unique, every item cites something, every
  condition value is from the closed set, every iso_ref resolves in
  iso_items.

Gate: lint green + Vijay signs off the catalog content (legal-accuracy
review; the one gate a test cannot run).

### Phase 1: framework plumbing

- `dpdp` row in frameworks; idempotent reference-data backfill (the 002
  pattern) inserting requirements from the catalog file, grouped by the 9
  sections as parent requirements.
- Crosswalk: requirement_mappings rows from each item's `iso_refs` to the
  canonical iso27001 requirements ("partial" coverage flag, same vocabulary
  the SOC 2/CSF mappings use).
- `dpdp` joins ALLOWED_FRAMEWORKS (lib/frameworks.js), the workspace
  framework picker, and the sidebar nav group (tiles gated like iso42001's).

Gate: full suite green; catalog renders on a browse page; crosswalks view
shows DPDP as a mapped framework.

### Phase 2: applicability screening

- Section 0 of the worksheet becomes a short guided intake (the iso42001
  intake is the pattern): does the Act apply (digital personal data,
  in-India or targeting-India processing), role, SDF status (explicitly
  "notified / expect notification / no"; conditional until the government
  notifies classes), children's data, cross-border destinations, Consent
  Manager usage.
- Answers derive an applicability matrix: each of the 54 requirements gets
  applicable / excluded (with the screening answer recorded as the
  exclusion justification) on the workspace's control_instances.
- Re-running the screening after facts change re-derives, never silently
  overwrites a consultant's manual override (same guard the SoA uses).

Gate: unit test the derivation table (screening answers × 54 requirements
→ expected applicability); walk + smoke green.

### Phase 3: gap wizard

- routes/dpdp.js on the register(app, deps) pattern. The wizard walks
  applicable requirements one at a time: statutory text, diagnostic
  question, status (same closed vocabulary), findings, evidence attach
  (evidence_requirement_links is already framework-aware), remediation
  owner + date.
- The crosswalk panel per item: linked Annex A controls, their current
  status in this workspace, and any evidence already attached to them,
  one click to reuse. This is the compounding feature; it ships in the
  wizard's first cut, not later.
- Flag-for-review reuses the controls module's reviewer fan-out (exported
  already for iso42001).

Gate: walk (both DB paths) + smoke + one manual end-to-end pass on seeded
data: screen, assess three items, attach ISO evidence via the crosswalk,
flag one for review.

### Phase 4: readiness, penalty exposure, runway

- DPDP readiness score in lib (conditional-aware: excluded requirements
  drop from the denominator), consumed by the workspace overview tile and
  a readiness page, same shape as lib/readiness.js.
- Penalty-exposure rollup: open gaps grouped by Schedule penalty band,
  worst-first: the board-meeting number.
- Commencement runway: the Rules' phased dates become compliance-calendar
  entries per workspace when DPDP is enabled (calendar machinery exists).

Gate: engine unit checks (known fixture → expected score and exposure);
suite green.

### Phase 5: deliverables

- Gap report DOCX via the branded-deliverable pipeline (worker pool
  already handles generation).
- Remediation worklist → tasks bulk-spawn (the NC/worklist pattern
  exists).
- Starter document templates into doc_templates: privacy notice (with the
  Eighth-Schedule languages requirement flagged as a client obligation,
  generation in English first), consent record format, breach response
  playbook (Board intimation without delay + detailed report within 72
  hours per the Rules), grievance-redressal SOP, retention schedule, DPIA
  outline (SDF-gated).
- Exec brief gains a DPDP section when the framework is enabled.

Gate: export parity checks (report renders with fixture data), suite
green, Vijay reviews template copy.

### Explicitly out of scope for now

Consent Manager platform features, live consent capture or receipts, Data
Principal request portal automation, multilingual notice generation (the
twenty-two language obligation is surfaced as a client task, not tool
output), and anything that turns the tool from assessor into processor of
personal data itself. Each is a separate product decision.

## Sizing and order

| Phase | Size | Depends on |
|---|---|---|
| 0 content | 1 session (mostly conversion + lint; review is Vijay's time) | archive restore |
| 1 plumbing | half session | 0 |
| 2 screening | 1 session | 1 |
| 3 wizard | 1-2 sessions | 2 |
| 4 engines | half session | 3 |
| 5 deliverables | 1-2 sessions, template copy dominates | 3 |

Phases 0-1 are safe to run back-to-back. The Phase 0 content gate (legal
review) is the only external dependency; everything after builds on the
already-hardened test rig, so every phase lands the same way the split
did: on a green gate.

## Open questions for Vijay

1. **SDF stance:** until the government notifies SDF classes, should the
   screening default clients to "assess SDF obligations anyway" (safer,
   more work) or "excluded-conditional" (lighter, revisit on
   notification)? Plan assumes excluded-conditional with a loud banner.
2. **First deliverable templates:** which two of the Phase 5 set matter
   most to your engagements? Plan assumes breach playbook + privacy
   notice.
3. **Positioning:** DPDP as part of the existing engagement (framework
   toggle, current pricing) or a standalone offering with its own portal
   view? Plan assumes framework toggle; a standalone auditor-portal-style
   surface would be a later phase.
