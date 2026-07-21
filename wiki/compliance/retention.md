---
title: Data Retention Schedule
tags: [compliance, gdpr, retention, lifecycle]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[data-map]]"
  - "[[dsar]]"
  - "[[cire]]"
  - "[[changelog/compliance-fixes]]"
last-reviewed: 2026-07-21
---

# Retention

Per GDPR Art. 5(1)(e) ("storage limitation"), every personal-data class
needs a documented retention window and an enforcement mechanism. Some are
already enforced in code; others need a sweeper job.

## Schedule

| Data class | Retention | Enforcement | Status | Owner |
|---|---|---|---|---|
| `accounts` row + `users` profiles | While active. On `DELETE /account` (C-H2): 7-day soft-delete tombstone, then hard delete via `account-erasure.runHardDeleteSweep`. | App code: `DELETE /account` cascade. | OK | Identity |
| `app_enrollments` (C-H2) | Per-row history preserved indefinitely (audit). Active rows have `left_at IS NULL`. | App code: `joinApp` on lazy provisioning, `leaveApp` on Flow B / Flow A cascade. | OK | Identity |
| `deletion_jobs` (C-H2) | Created at soft-delete; row removed by hard-delete sweeper after `hard_delete_at + fan-out completion`. Effective retention: 7-30 days max. | Sweeper job (`account-erasure.runHardDeleteSweep`) | OK | Identity |
| `pulse_deletion_jobs` (C-H2 Flow B) | Created at soft-delete; removed at `hard_delete_at` (= softDeletedAt + 7d). | Sweeper job (`accountErasure.runHardDeleteSweep` — Pulse) | OK | Pulse |
| Hosted events with `cancelled_at` set + `cancellation_reason = "host_left"` | 14 days from cancellation, then hard-deleted. | Sweeper (`accountErasure.runEventCancellationSweep`) | OK | Pulse |
| `passkeys` | While account active; deleted on credential revoke or account delete | App code | OK | Identity |
| `sessions` | 30 d sliding window; family-revoked on rotation reuse | DB `expires_at` + nightly purge job (planned) | Sliding window OK; purge of expired rows missing | Identity |
| `rotated_sessions` (Redis or in-memory) | `refreshTokenTtl` = 30 d; native Redis PX TTL OR FIFO eviction | Per-key TTL (Redis) / FIFO sweep (in-mem) | OK | Identity |
| `security_events` | 12 months from `created_at` | Sweeper job (planned) | **TODO** — define + write. | Identity |
| `email_changes` audit | 90 days | Sweeper job (planned) | **TODO** | Identity |
| `recovery_codes` | While account active. Used codes retain `used_at` for security-event reasoning. | App code | OK | Identity |
| `cdl_requests` | 5 min TTL; in-memory expiry on poll | App code | OK; consider lazy eviction P-W1 (cdl) | Identity |
| `otpStore`, `magicStore`, `pendingRegistrations` | 5 min TTL; current Map has no sweeper (P-W4) | Migrate to Redis with native TTL (Redis Phase 4) | **TODO** — Redis Phase 4 in TODO | Identity |
| `events` (Pulse) | While host has not deleted; archived 90 d after `endTime` (read-only) | Sweeper job + host-controlled hard-delete | **TODO** — archival not built. | Pulse |
| `event_rsvps` | Same as parent event | Cascade on event hard-delete | OK once archival lands | Pulse |
| `event_rsvps.shareSource*` (attribution) | Same as parent RSVP row — no independent retention | Cascade on RSVP/event hard-delete; no separate sweeper needed (columns live on the RSVP row) | OK once archival lands | Pulse |
| `event_comms` | 90 days | Sweeper job | **TODO** | Pulse |
| `pulse_close_friends` | While both profiles active; cross-DB orphans (S-L2 pulse-close-friends) need a reconciliation hook | Reconciliation hook | **TODO** — covered by S-L2 (pulse-close-friends) | Pulse |
| `venues` | While venue listed (seed-only today); delete on owning-org request | App code (manual until org self-service lands) | OK — no automated path needed yet | Pulse |
| `event_lineup` | Same as parent event (event + 90 d archival) | Cascade with event hard-delete | OK once event archival lands (C-L20) | Pulse |
| `messages` ciphertext (Zap) | Per chat-level disappearing-message setting; default indefinite (user-controlled) | App code: TTL sweep | **TODO** — Zap M1 disappearing-messages flag | Zap |
| `chat_members` | While membership active | App code | OK | Zap |
| `org_chats` transcripts (M3) | Per controller-org's setting; default 24 months | App code: per-org retention setting | **TODO** — Zap M3 | Zap |
| `localities` + `locality_subscriptions` (M4) | Until user opts out; travel subs have explicit expiry | App code | **TODO** — Zap M4 | Zap |
| Cire guest data (`families`, `guests`, `rsvps` incl. `dietary` + its Art. 9(2)(a) consent record + `consent_source` writer/consent-basis, PR 5b) | **1 year after the wedding's final event** (`RETENTION_AFTER_FINAL_EVENT_MS` = 365 days), per the published privacy notice (PR #124). | `retentionService.sweepExpiredGuestData(now)` (Effect, `cire/api/src/services/retention.ts`, PR #132) — daily cron `scheduled` sweep deletes `rsvps` / `guests` / `families` / `imports` for every wedding whose latest event's **effective end** is >365 days past — effective end = `events.end_at`, falling back to `events.start_at` when no end is stated (End optional in the events sheet since 2026-07-08; `""` sentinel = open-ended); the wedding+events shell is kept, and no-events weddings are kept. `cire.guest_data.swept` metric. | **OK** — automated 1-year sweep enforced. | Cire |
| Cire `sessions` (expired guest session rows) | 30-day cookie TTL; expired rows are storage-only after that | `session.ts` sweep on a daily Cloudflare cron `scheduled` handler (PR #127), `cire.session.swept` metric | **OK** — **expired-guest-session purge now exists** (distinct from the still-open osn-api C-M2 / C-M15 in-process sweeper). Sliding-window auth already prevents reuse; the purge is for hygiene + DSAR completeness. | Cire |
| Cire `guest_account_links` (guest→OSN account opt-in link; AL-C-L1) | Tied to wedding lifecycle — same window as the parent guest/family/wedding | DB `ON DELETE cascade` from `guests` / `families` / `weddings` (incl. the 1-year `sweepExpiredGuestData` which deletes the parent `guests` row, so the link row goes with it) | **OK on the cire side** — fully covered by cascade. **Orphan caveat:** `osn_account_id`/`osn_profile_id` are opaque cross-DB references with no FK, so an **OSN-side account deletion does NOT fan out to cire** — the link row lingers holding a stale account id. Orphan-tolerant by design (cire holds no OSN-side PII; the stale link surfaces nothing once the account resolve fails closed); a reverse ARC purge fan-out is deferred. See [[data-map]] (account-link orphan note) + [[dsar]] (C-M1). | Cire |
| Cire `imports` table rows | Tied to wedding lifecycle; reverted imports should not linger | DB rows swept by `sweepExpiredGuestData` (1 year after final event, PR #132); cascade on wedding delete | **OK** — expired weddings' import DB rows swept at 1 year, and the R2 objects they reference are now reaped in the same sweep (see next row). | Cire |
| Cire R2 `imports/<id>/{events,guests}.csv` (raw uploads in `cire-sheets`) | Tied to wedding lifecycle; reaped with the 1-year guest-data sweep | R2-aware pass in the retention sweep | **OK** — `feat/cire-retention-r2-sweep`: `sweepExpiredGuestData` now **collects each expired wedding's `events_r2_key`/`guests_r2_key` BEFORE the D1 deletes** (D1 cascade never reaches R2), then **best-effort deletes them from `SHEETS`** via the reusable `services/r2-cleanup.ts` `reapR2Objects` (chunked, failures logged + counted on `cire.r2.objects.swept`, never aborts the sweep). The cron `scheduled` handler passes `env.SHEETS`. Closes the erasure path for the uploaded-sheet guest PII (IB-S-L2 sheets path / C-H1). | Cire |
| Cire `wedding_invite_customisations` (invite-builder copy + image keys) | Tied to wedding lifecycle | Cascade on wedding delete (FK `ON DELETE cascade`) | **OK for the D1 row** (cascades with the wedding); the R2 images it references do **not** — see below | Cire |
| Cire wedding-profile + event-location columns (migration 0030: `weddings.wedding_date`/`guest_count_estimate`/`currency`/`budget_total_minor`; `events.location_lat`/`location_lng`/`pricing_region`) | Retained with the wedding+events **shell** — which the 1-year guest-data sweep deliberately keeps (the invite stays live), so these organiser-volunteered planning facts are **effectively retained until a wedding-DELETE flow exists** (the open C-H1 remainder). | None today beyond FK cascade on a (not-yet-buildable) wedding delete. The future wedding-DELETE flow must count these columns in its scope — they go with the `weddings`/`events` rows automatically. | **Honest-gap** — low-sensitivity organiser-provided data about their own event (budget figure + venue coordinates are the most sensitive); no dedicated sweeper warranted, but the register must reflect that "wedding lifecycle" currently has no end for the shell. Tracked under the C-H1 wedding-DELETE remainder. | Cire |
| Cire R2 `assets/<weddingId>/*` (invite hero/story/event **images** in `cire-assets`) | Tied to wedding lifecycle; superseded/removed/orphaned images should not linger | App-code best-effort delete on re-upload/remove **+ a daily scheduled orphan-reconciliation sweep** (`asset-reconcile.ts`) for the cases where that best-effort delete failed | **OK** — `feat/cire-assets-reconcile`: `assetReconcileService.reconcileOrphans` (wired into the cron `scheduled` handler with `env.ASSETS`) lists `assets/`-prefixed objects and best-effort deletes those referenced by **no** live `wedding_invite_customisations`/`events.event_image_key` row, reusing `reapR2Objects` (`cire.r2.objects.swept`, `bucket=assets`). The **live invite's images are untouched** (they are referenced, so never candidates). **Fail-safe guards** (it deletes real wedding photos): **abort-on-uncertainty** — a failed or empty referenced-key read against a non-empty bucket deletes NOTHING; **7-day grace window** so a lagging row-write isn't reaped; **`assets/` prefix scoping**; **500/run cap**; best-effort deletes. Closes the open `cire-assets` half of IB-S-L2 / C-H1. A future wedding-DELETE flow (none today) must still fan out to R2 for the full-wedding case — `reapR2Objects` is bucket-agnostic for that. | Cire |
| Cire `directory_vendors.email` / `phone` (sole-trader contact on the directory listing) | While listing active; removed on org or cire admin request | App code (organiser or vendor deletes listing / account-delete flow) | **TODO** — no automated path yet; low-volume, operator-managed today | Cire |
| Cire `vendors.email` / `phone` / `contact_name` (sole-trader contact in the per-wedding CRM) | Tied to wedding lifecycle — cascades when the organiser removes the CRM entry or the wedding is deleted | DB `ON DELETE cascade` from `vendors`/`weddings` | **OK for cascade path**; no independent sweeper needed (CRM entry is organiser-controlled) | Cire |
| Cire `vendor_claims.email` (sole-trader email recorded on a claim token) | 7-day claim TTL; `status` flips to `expired`/`consumed` at expiry/consumption | App code (TTL enforced at consume-time check); claim rows retained indefinitely after expiry (no purge today) | **TODO** — add a sweeper once claim volumes warrant (e.g. purge `expired`/`consumed` rows older than 90 d) | Cire |
| Cire `wedding_entitlements` (incl. `granted_by` audit field) | Life of the wedding record | DB `ON DELETE CASCADE` on `weddings.id` — when the wedding row is deleted the entitlement rows cascade automatically; no independent sweeper required | **OK** — fully covered by the wedding-deletion cascade | Cire |
| Cire `vendor_enquiries` rows (S4 — `status`, `quoted_minor`, `pending_body`, `lead_forward_email`) | Tied to the wedding lifecycle (`ON DELETE CASCADE` from `weddings.id`) **and** to the directory listing (`ON DELETE CASCADE` from `directory_vendors.id`). `pending_body` is additionally cleared to `NULL` in-place when the vendor claims and the buffer is flushed (transient first-message text — see [[data-map]] S4 rows); if never flushed (vendor never claims), it persists with the enquiry row until one of the two cascades fires. | DB cascade on wedding or listing delete. No independent sweeper — low volume; cascade paths cover the two main lifecycle events. A future "close stale unclaimed enquiries" sweeper may be warranted once listing volumes grow. | **OK for cascade path** — both cascade FKs are declared. **Honest-gap** for `pending_body` on a never-claimed listing: the text persists indefinitely until the listing is deleted or the wedding is deleted. Low-priority given listing-delete removes it, but no time-bounded purge exists today. | Cire |
| Cire `lead_forward_email` (vendor-supplied sole-trader contact email on `vendor_enquiries`) | Same lifecycle as the `vendor_enquiries` row — cascades on wedding or listing delete | DB cascade (see row above) | **OK** — covered by parent cascade | Cire |
| Zap c2b message bodies in the cire vendor-enquiry thread | Governed by Zap message retention — currently indefinite pending the Zap disappearing-messages flag (Zap M1). Covered by the `account-export` DSAR path (PR A, [[zap]]). | Zap message retention sweeper (planned, Zap M1) | **TODO** — Zap M1 disappearing-messages flag (shared open item, see Zap row above) | Zap / Cire |
| Grafana Cloud traces | 14 days (free tier) | Vendor-enforced | OK | Platform |
| Grafana Cloud logs | 50 GB rolling (~30 d typical) | Vendor-enforced | OK | Platform |
| Grafana Cloud metrics | 30 days (free tier) | Vendor-enforced | OK | Platform |
| Frontend Faro events | 14 days | Vendor-enforced | OK | Platform |
| Cloudflare Email delivery logs | Per Cloudflare DPA | Vendor-enforced | Confirm in DPA | Platform |
| DSAR request log | 24 months (CCPA requirement) | DSAR runbook | **TODO** — runbook | Identity |
| DSA notice-and-action log (Art. 16 reports) | 6 months (Art. 20 internal complaint window) | App code: `moderation_actions` table | **TODO** — DSA C-H6/C-H7 | Pulse + Zap |

## Project changes required

Tracked with `C-` IDs:

1. **Sweeper job framework** — single cron-style worker in `@osn/api` that runs the per-table delete queries on a schedule. Use Bun's built-in `setInterval` for now; revisit if we move to Kubernetes CronJobs. ID: **C-M15**. Mandatory design constraints (see "Sweeper design contract" below).
2. **`security_events` sweeper** — batched delete of rows older than the 12-month cutoff per the C-M15 contract. ID: **C-M2** (bundled).
3. **`email_changes` sweeper** — same pattern. ID: **C-M2** (bundled).
4. **`sessions` expired-row purge** — sliding-window expiry already prevents valid use; the purge is for storage hygiene + DSAR completeness. ID: **C-M2** (bundled).
5. **Pulse event archival flow** — `archived_events` view or a status flag + `endTime + 90 d` cutoff. ID: **C-L20**.
6. **Deletion-tombstone retention** — keep enough info to explain "this user deleted their account on YYYY-MM-DD" for 30 d in case of recovery, then purge per the C-M15 contract. ID: rolled into **C-H2**.
7. **Cire guest-data lifecycle** — **largely shipped this session.** A daily Cloudflare-native cron `scheduled` handler now runs both an **expired-`cire_session` sweeper** (`session.ts`, PR #127, `cire.session.swept` metric) and a **1-year guest-data sweep** (`retentionService.sweepExpiredGuestData`, PR #132, `cire.guest_data.swept` metric) that deletes `families` / `guests` / `rsvps` (incl. dietary + its consent record) / `imports` DB rows for any wedding whose final event is >365 days past — the window enforced from the published privacy notice (PR #124). The sweep now also **reaps the `cire-sheets` R2 objects** behind the deleted `imports` rows (`feat/cire-retention-r2-sweep`): it collects the `events_r2_key`/`guests_r2_key` BEFORE the D1 deletes, then best-effort deletes them from `SHEETS` (reusable `services/r2-cleanup.ts` `reapR2Objects`, `cire.r2.objects.swept` metric) — closing the uploaded-guest-PII erasure path. The `cire-assets` invite **images** are intentionally NOT reaped by the 1-year sweep (it keeps the live invite), but their re-upload-failure orphan path is now closed by a **separate daily orphan-reconciliation sweep** (`feat/cire-assets-reconcile`, `asset-reconcile.ts`) — guarded to abort-on-uncertainty + a 7-day grace window so it can never reap a live invite's images. **Remaining open part of C-H1:** a future organiser wedding-DELETE flow (none today) must fan out the full wedding's R2 objects, and the account-level data-export endpoint (`GET /account/export`) is still unbuilt.

## Sweeper design contract (C-M15)

Every sweeper invocation **must** follow these rules. They exist because a naive `DELETE … WHERE created_at < ?` against a large table holds a write lock long enough to time out concurrent auth writes (passkey ceremonies, refresh-token rotation, session revocation). Locked in before C-M15 implementation starts:

1. **Batched delete** — `DELETE FROM <table> WHERE id IN (SELECT id FROM <table> WHERE <cutoff> LIMIT 500)` looped until 0 rows. Never an unbounded delete.
2. **Inter-batch yield** — 50–100 ms `setTimeout` between batches to release the SQLite / Postgres write lock.
3. **Single-instance lock** — Redis `SET sweeper:<table> $instance NX EX 600` before each cycle; abort if not acquired. Falls back to a DB advisory row when Redis is unavailable. Prevents two API nodes from running the same sweeper concurrently.
4. **Re-entrancy guard** — the `setInterval` callback checks an in-process `running` flag; a slow run that crosses the next tick skips the new tick rather than overlapping itself.
5. **Observability** — emit `osn.retention.rows_deleted` counter (attrs: `table`) and `osn.retention.cycle_duration_ms` histogram per pass. Spike on the counter is the early signal for a runaway accumulation.
6. **All sweeper deletes share this pattern** — including the C-H2 deletion-tombstone purge, the Pulse event archival (C-L20), and the C-M2 trio. No per-table reinvention.

## Per-feature checklist

When you ship a new column / table that holds personal data, you must
add a row above before merge. The `/review-security` skill enforces this.
The minimum information per row:

- Data class (table + column / data structure)
- Retention window (days / months / "while active")
- Enforcement mechanism (DB constraint, app code, sweeper, vendor-enforced)
- Status (OK / TODO / BLOCKED)
- Owner team

## Why these particular numbers

| Window | Reason |
|---|---|
| 30 d sessions | Industry default; balances UX (no daily re-auth) against compromised-device exposure. |
| 12 months security_events | Covers a full audit cycle. SOC 2 auditors typically request 12-month windows of evidence. |
| 90 d email_changes | Long enough to investigate a hostile email-change abuse claim; short enough to avoid stale PII. |
| 24 months DSAR log | Mandatory under CCPA §999.317. Convenient default for GDPR record-keeping too. |
| 6 months DSA reports | Art. 20 mandates appeal availability for at least 6 months after a moderation action. |
| 30 d soft-delete tombstone | Lets us reverse an accidental account-delete while bounding the window for the user-facing erasure right. Mention in privacy notice. |
| 14 d traces | Free-tier Grafana ceiling. Sufficient for incident postmortems. |
| 1 yr cire guest data (after final event) | The window **published in the cire `/privacy` notice** (PR #124) and enforced by `sweepExpiredGuestData` (PR #132). One year past the last event covers post-wedding thank-yous / late corrections while honouring storage limitation for special-category dietary data. Open-ended events (no stated end — legal since 2026-07-08) count from their **start** instant. |
