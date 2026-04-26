---
title: Backup + Disaster Recovery (SOC 2 A1)
tags: [compliance, soc2, backup, dr, availability]
related:
  - "[[index]]"
  - "[[soc2]]"
  - "[[breach-response]]"
last-reviewed: 2026-04-26
---

# Backup + Disaster Recovery

SOC 2 Availability (A1) requires a documented backup + DR posture with
evidence of operating effectiveness — i.e. you have done the restore
drill and it worked.

## Targets

| Metric | Initial target | Stretch | Notes |
|---|---|---|---|
| RPO (max acceptable data loss) | 24 h | 1 h | Per-table SQLite snapshots → daily; once on Supabase, point-in-time recovery to the minute |
| RTO (max acceptable downtime) | 4 h | 1 h | Service redeploys can be fast; data-restore is the bottleneck |
| Backup retention | 30 d daily, 12 m monthly | Same | Tax / dispute window |
| Off-region copy | Weekly | Daily | Once on Supabase + a separate cloud region |
| Restore drill cadence | Quarterly | Monthly | Documented evidence per drill |

## Today's posture (gap analysis)

| Component | State | Gap |
|---|---|---|
| Local-dev SQLite | Throwaway | Not in scope |
| Production database (planned: Supabase Postgres) | Not deployed yet | Define backup config when migrating |
| Redis (rate-limit, rotated-session store, future auth state) | Ephemeral by design (TTL'd state) | OK — no DR needed for ephemeral state; rate-limit fail-closed posture is the safety net |
| Object storage (planned: Cloudflare R2 for avatars, event covers, message media) | Not deployed yet | Mirror across two regions |
| Grafana Cloud (logs / traces / metrics) | Vendor-managed | Out of our scope; vendor SLA |
| Cloudflare Email | Vendor-managed | Same |
| GitHub | Vendor-managed | Same; mirror code to a second host (e.g. Codeberg) for catastrophic-vendor scenario |

## Restore drill protocol

Quarterly. Documented under `wiki/compliance/dr-drills/<YYYY>-<Q>.md`.

1. Pick a backup from ≥7 days ago (tests we can restore old enough).
2. Provision a parallel environment (DB instance, Redis, services).
3. Restore from backup.
4. Smoke-test:
   - `/health` and `/ready` return 200 on every service.
   - A test account can log in via passkey.
   - A test event can be created in Pulse.
   - A test message can be sent in Zap (once Zap M1 ships).
   - ARC verification works between services.
   - JWKS endpoint serves the right keys.
5. Time the restore. Compare against RTO target.
6. Tear down.
7. Write up: what worked, what didn't, what to fix.

## Failure modes and mitigations

| Mode | Mitigation |
|---|---|
| Database corruption | Daily snapshot restore + replay WAL to last good point |
| Database accidental delete (DROP TABLE, etc.) | Same; 7-day soft-delete policy on user actions reduces blast radius |
| Region outage | Multi-region replica (planned with Supabase config) |
| Cloud provider outage | Document recovery into a second cloud (planned; long lead-time, accept 24+h RTO) |
| Domain takeover | Registrar lock + WebAuthn + alert on DNS change |
| Auth-key compromise (signing keys) | Rotate; revoke ARC kid; fail-closed cache eviction (already handled by S-H100 fix) |
| Total OSN compromise | Backups are encrypted at rest; restore to clean infra; communicate per [[breach-response]] |

## Project changes required

Tracked with `C-` IDs:

1. **DR plan finalised** — this page is the skeleton; flesh out once Supabase target is chosen. ID: **C-M6**.
2. **First restore drill** — schedule for Q3 2026 (initial dry run before production traffic). ID: **C-M6** (bundled).
3. **GitHub mirror** to a second host (Codeberg / Gitlab.com / private S3) for code-catastrophic-loss scenarios. ID: **C-L23**.
4. **Encryption-at-rest documentation** — confirm Supabase / R2 / Redis-provider encryption-at-rest defaults; capture in [[soc2]] C1. ID: **C-L24**.
5. **Backup integrity verification** — checksum each snapshot; reject restores from corrupted snapshots automatically. ID: **C-L25**.
