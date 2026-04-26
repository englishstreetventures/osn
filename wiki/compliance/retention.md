---
title: Data Retention Schedule
tags: [compliance, gdpr, retention, lifecycle]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[data-map]]"
  - "[[dsar]]"
last-reviewed: 2026-04-26
---

# Retention

Per GDPR Art. 5(1)(e) ("storage limitation"), every personal-data class
needs a documented retention window and an enforcement mechanism. Some are
already enforced in code; others need a sweeper job.

## Schedule

| Data class | Retention | Enforcement | Status | Owner |
|---|---|---|---|---|
| `accounts` row + `users` profiles | While active. On `DELETE /account` (planned C-H2): 7-day soft-delete tombstone, then hard delete. | App code: `DELETE /account` cascade. | **TODO** — endpoint not built. | Identity |
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
| `event_comms` | 90 days | Sweeper job | **TODO** | Pulse |
| `pulse_close_friends` | While both profiles active; cross-DB orphans (S-L2 pulse-close-friends) need a reconciliation hook | Reconciliation hook | **TODO** — covered by S-L2 (pulse-close-friends) | Pulse |
| `messages` ciphertext (Zap) | Per chat-level disappearing-message setting; default indefinite (user-controlled) | App code: TTL sweep | **TODO** — Zap M1 disappearing-messages flag | Zap |
| `chat_members` | While membership active | App code | OK | Zap |
| `org_chats` transcripts (M3) | Per controller-org's setting; default 24 months | App code: per-org retention setting | **TODO** — Zap M3 | Zap |
| `localities` + `locality_subscriptions` (M4) | Until user opts out; travel subs have explicit expiry | App code | **TODO** — Zap M4 | Zap |
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
