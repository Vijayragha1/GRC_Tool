# Experience acceptance pilot

Status: **pending real participants**. Automated checks establish technical behavior; they cannot establish a 9/10 usability or flow rating. Do not claim that rating before this pilot passes.

Recruit at least five distinct people in each of six groups: client contributor, client sponsor, client coordinator, junior consultant, experienced consultant, and manager. A person belongs to one group only. Include varied experience and at least two mobile sessions per client group. Use pseudonymous participant IDs and synthetic client data. Record the tested build, browser/device, enabled programmes, task script and session date. Keep raw session notes outside this aggregate file.

Use equivalent baseline and redesigned tasks on isolated seeded workspaces. Counterbalance order within each group to reduce practice effects. Give the same short orientation and no navigation coaching. A facilitator may stop an unsafe action but must record the task as assisted and unsuccessful for the completion metric. Separate thinking time and domain analysis from navigation/admin time using the same observation rules in both versions.

Each participant completes at least five representative journeys. Select tasks from the appropriate group below; combine scenarios only when each has an independent observed outcome.

| Group | Required journey coverage |
| --- | --- |
| Contributor | Locate assigned request; upload while drafting; submit; recover and respond to changes; locate completed work/update |
| Sponsor | Identify engagement status; find team blocker; delegate released work; respond on behalf; review a named approval and inspect published output |
| Coordinator | Find unassigned released work; assign existing member; track waiting handoff; submit on behalf with attribution; recover changed/stale input |
| Junior consultant | Find next assigned assessment; save/recover diagnostic work; issue scoped evidence request; reconcile submission; prepare and submit independent review |
| Experienced consultant | Review evidence lineage; return actionable feedback; resume review; review validation result; inspect frozen report and publication readiness |
| Manager | Compare workload across clients/programmes; identify overdue/unassigned work; assign/reassign; inspect reviewer independence/blockers; drill into safe publication state |

Include ISO 27001, ISO 42001, CSF and enabled DPDPA/TPRM/vCISO programmes across the sample. Do not imply a programme supports a lifecycle or a client publication route it does not have. Record gaps and treat blocked required journeys as failures, rather than removing them after observation.

For every task, record unassisted completion, whether the participant correctly identified both the next action and the responsible person, and time to that combined identification measured from seeing the page. Record paired baseline/redesign navigation/admin seconds. After the session collect separate 1–10 ease and flow ratings, asking: “How easy was it to do your work?” and “How well did the steps fit together from start to finish?” Collect a concrete reason and greatest remaining friction without leading the participant toward a target score.

The release gate is evaluated **for every group**, so a strong consultant result cannot mask a weak contributor experience:

- At least five participants and five observed tasks per participant.
- Mean ease ≥ 9/10 and mean flow ≥ 9/10.
- Unassisted task completion ≥ 95%.
- Correct next action and responsible person identified within 10 seconds on ≥ 90% of tasks.
- Paired navigation/admin time falls by ≥ 30%, comparing the sum of redesign time with the same participants/tasks at baseline.
- No unresolved high-severity defects. All reliability gates have recorded passing evidence: draft recovery, upload failure recovery, duplicate-submit prevention, stale-change protection, role/workspace isolation, notification retry/access recheck, independent review/publication rules, and retained report/source integrity.

Use `reports/experience-pilot-template.json` as an empty collection template. The template contains no participant outcomes. Run `node scripts/evaluate-experience-pilot.js path/to/recorded-results.json`; exit code 0 means every gate passed and 1 means pending/failed. Keep the evaluated output alongside the raw aggregate input. Missing fields, incomplete samples and absent reliability evidence are failures, not zero-valued successes. Re-run affected journeys after fixes with equivalent tasks; retain earlier failed results and identify the retested build. Report group-level metrics, sample size and unresolved limitations when communicating results.

## Delivery reliability boundary

Collaboration events create one durable in-app notification and one email job per event/recipient. The worker retries failed or abandoned jobs and rechecks the recipient's current access before each send. Stable event/recipient/channel keys are forwarded to Resend through its `Idempotency-Key` header; Resend documents a 24-hour deduplication window ([official documentation](https://resend.com/docs/dashboard/emails/idempotency-keys)). This is not an unlimited exactly-once delivery guarantee. Other currently supported transports (Brevo and Gmail SMTP) do not receive a provider deduplication key in this implementation. A crash after provider acceptance but before the local sent marker can therefore cause a duplicate on retry, including Resend retries beyond that window. In-app state remains deduplicated. Test provider failures and crash recovery, and disclose the active transport/window in pilot reliability evidence. External magic-link approval emails continue using their separate token lifecycle.
