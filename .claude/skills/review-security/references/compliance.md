---
title: Compliance reference — GDPR, CCPA, COPPA, DSA, SOC 2
---

The classes below are split out of `SKILL.md`, which keeps only the two checked on every review (subprocessors, accessibility). Read this file when the diff adds a column, a table, a request body, a response payload, an endpoint, a moderation action, a ranking surface, or an operator-facing code path. Findings from here carry the `C-` prefix and go in the compliance section of the report, same as any other.

## GDPR / privacy (lawful basis, minimisation, transparency)

- New columns / tables / request bodies / response payloads that capture personal data without a corresponding row in `wiki/compliance/data-map.md`. Adding a new field implies declaring purpose, lawful basis, retention, and recipients.
- New API endpoints that introduce a new processing purpose without naming the lawful basis (Art. 6(1) letter; for special-category data, Art. 9(2) letter) — flag and require documentation in the same PR.
- New code that collects data falling under GDPR Art. 9 (health, race, religion, politics, sex life or orientation, biometric, genetic, trade-union membership) without explicit consent capture or a documented Art. 9(2) basis. Pulse events whose category implies a special-category attribute count.
- New columns / data classes without an entry in `wiki/compliance/retention.md` (storage limitation — Art. 5(1)(e)).
- Code paths that prevent the user from exercising rectification (Art. 16), erasure (Art. 17), or portability (Art. 20) — e.g. data written to an immutable store with no overwrite path, or fields that the planned `GET /account/export` / `DELETE /account` endpoints cannot reach.
- New cross-DB writes (Pulse → OSN, Zap → OSN, etc.) that would orphan personal data on profile / account deletion. Either fan out the deletion via ARC or document the orphan-tolerance rationale.
- PII (email, handle, phone, IP, free-text user content) added to log annotations, span attributes, metric attributes, or error `cause` payloads without going through the redaction deny-list at `shared/observability/src/logger/redact.ts`. Reading the deny-list only catches names already on the list; verify the new field name is added to the deny-list **and** to the `redact.test.ts` assertion.
- `accountId` (or `account_id`) leaking through any new wire surface (response payload, JWT claim, log line, span attribute, metric attribute) — privacy invariant from the multi-account audit (P6).

## CCPA / state privacy

- New "selling" or "sharing" surface (advertising network, cross-context behavioural ad pixel, third-party data partner) that inverts our current "no sell, no share" declaration. Even a single integration requires the "Do Not Sell or Share" link and rebuild of the privacy notice.
- New code paths that ignore the `Sec-GPC: 1` header / planned consent middleware. Once GPC recognition lands (C-L7), every CCPA-scoped data flow must consult it.

## COPPA

- New registration / onboarding surface that does not check the age gate. Currently the gate is planned (C-H8); until it lands, every new field collected at registration must be gated behind it once shipped.
- New marketing copy, illustration, mascot, advertising, or feature whose tone reads as targeted at under-13 users — flag immediately. We rely on the "general audience" defense.
- Code that ingests data from a user we have actual knowledge is under 13 — terminate flow, do not persist.

## DSA (UGC moderation)

- New user-generated-content surface (Pulse event titles / descriptions / images, Zap message bodies, organisation profile bios, custom event categories) without a corresponding `POST /reports` Art. 16 notice path AND a `moderation_actions` audit row when content is restricted. Statement of reasons (Art. 17) is mandatory for every restriction.
- Moderation actions (post removal, account suspension, demotion, RSVP rejection by host, organisation handle revocation) executed without writing a `moderation_actions` audit row + emailing the affected user a structured statement of reasons.
- New algorithmic-ranking code (Pulse discovery, friend recommendation, event "for you", Zap inbox sort) without an updated recommender-transparency disclosure in the ToS draft (`wiki/compliance/legal-drafts/tos.md`).
- New trader-facing surface (Zap M3 organisation chats, organisation creation in `@osn/api`) that does not capture Art. 30 trader-traceability fields (name, address, phone, email, registration ID, self-declaration of compliance) before allowing consumer interaction.

## SOC 2 (CC6 access, CC7 ops, CC8 change, CC9 mitigation)

- New production-touching code path that logs an admin action (operator querying / modifying user data) without writing an `admin_actions` audit row (planned C-M16). All operator data access must be attributable, logged, and reviewable.
- New service that does not carry the `@shared/observability/elysia` plugin (RED metrics, request ID, `/health`, `/ready`, redacted logs) — CC4 monitoring + CC7 system operations.
- New third-party dependency added without a documented decision (changeset note acceptable). Surfaces SCA / supply-chain risk that the planned CI dep-scan (C-M7) will catch.
- Changes to GitHub branch protection, codeowners, required status checks, or CI hooks — change-management evidence (CC8). Flag and require named reviewer.
- Changes to access mechanisms — new role, new bearer-token type, new step-up gate, new ARC scope, new admin endpoint — without a corresponding update to `wiki/compliance/access-control.md` or the planned quarterly matrix.
- Changes to backup, restore, or DR-relevant code (database connection pooling, batch jobs, sweepers) — A1 availability evidence; flag for [[backup-dr]] cross-reference.

## Further pre-merge gates

- [ ] New consent-based processing → consent-record table updated (or a scaffold task filed if this is the first one)
- [ ] New UGC surface → notice-and-action endpoint coverage confirmed; statement-of-reasons path confirmed
- [ ] New algorithmic-ranking surface → recommender disclosure updated in the ToS draft
- [ ] New age-gate-bypassing data collection → flagged explicitly
- [ ] New high-risk processing (special-category, large-scale, vulnerable groups, novel tech) → DPIA filed under `wiki/compliance/dpia/`
