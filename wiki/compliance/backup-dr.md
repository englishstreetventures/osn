---
title: Backup + Disaster Recovery (SOC 2 A1)
tags: [compliance, soc2, backup, dr, availability]
related:
  - "[[index]]"
  - "[[soc2]]"
  - "[[breach-response]]"
last-reviewed: 2026-10-10
---

# Backup + Disaster Recovery

SOC 2 Availability (A1) requires a documented backup + DR posture with
evidence of operating effectiveness — that is, you have run the restore
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
| Cire object storage — Cloudflare R2 `cire-sheets` (guest spreadsheets) and `cire-assets` (invite images) | Deployed, with no object versioning and no second copy. The daily cron's orphan reconcilers permanently delete any object no `cire-db` row names once R2 says it is 7 days old, unless an operator has stopped them (below) or a run is held because the rows naming keys fell by more than half | No backup. Restoring `cire-db` to an earlier point (below) puts objects at risk |
| Other object storage (planned: R2 for avatars, event covers, message media) | Not deployed yet | Mirror across two regions |
| Grafana Cloud (logs / traces / metrics) | Vendor-managed | Out of our scope; vendor SLA |
| Cloudflare Email | Vendor-managed | Same |
| GitHub | Vendor-managed | Same; mirror code to a second host (e.g. Codeberg) for catastrophic-vendor scenario |

## Restore drill protocol

Quarterly. Documented under `wiki/compliance/dr-drills/<YYYY>-<Q>.md`.

1. Pick a backup from ≥7 days ago (this tests that we can restore a backup that old).
2. Set up a parallel environment (DB instance, Redis, services).
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
| Restoring `cire-db` (D1 Time Travel) to an earlier point | Rows written after the restore point are gone, so the R2 objects only they named look orphaned: the cire cron's reconcilers delete those already 7 days old at the next 04:00 UTC run, and the rest as they reach 7 days. See the runbook below |
| A cron run finds the rows naming a bucket's objects fell by more than half (a bad migration, a wrong bulk delete, a partial restore) | That reconciler deletes nothing, keeps the count from before the drop and emails `CIRE_OPS_EMAIL` every run it holds. The hold ends when the rows recover to half, when an operator deletes the bucket's position object (`reconcile/imports-position.json` in `cire-sheets`, `reconcile/assets-position.json` in `cire-assets`), or after 7 held runs, when deleting resumes and a last email says so. If the loss was a mistake, stop the reconcilers as the runbook below says |
| Region outage | Multi-region replica (planned with Supabase config) |
| Cloud provider outage | Document recovery into a second cloud (planned; long lead-time, accept 24+h RTO) |
| Domain takeover | Registrar lock + WebAuthn + alert on DNS change |
| Auth-key compromise (signing keys) | Rotate; revoke ARC kid; fail-closed cache eviction (already handled by S-H100 fix) |
| Total OSN compromise | Backups are encrypted at rest; restore to clean infra; communicate per [[breach-response]] |

## Runbook: stop the R2 reconcilers around a `cire-db` restore

The daily cron's two R2 orphan reconcilers permanently delete `cire-sheets` and `cire-assets` objects no `cire-db` row names. Stop them before restoring `cire-db`, so the objects only the lost rows named survive. Every other cron job, retention included, keeps running.

1. **Stop both**, in the tier being restored — production `cire-sheets` and `cire-assets`, dev `cire-sheets-dev` and `cire-assets-dev`:

   ```bash
   printf 'restore\n' | bunx wrangler r2 object put cire-sheets/reconcile/stop --pipe --remote
   printf 'restore\n' | bunx wrangler r2 object put cire-assets/reconcile/stop --pipe --remote
   ```

   `--remote` is required: without it wrangler writes to local storage, reports success, and nothing stops. No deploy touches these objects, so the stop holds until you remove it.
2. **Check** with `bunx wrangler r2 object get cire-sheets/reconcile/stop --remote --pipe` (and the same for `cire-assets`). The next 04:00 UTC run logs `r2 reconcile stopped` and, where `CIRE_OPS_EMAIL` is set, emails it with the stop's age in days.
3. **Restore** `cire-db`.
4. **Keep what must be kept.** Copy any object the restored rows no longer name and that must survive into a dedicated R2 bucket in the same Cloudflare account, bound to no Worker and with public access off, readable only through the operator's Cloudflare login; restore it into `cire-sheets` or `cire-assets` under rebuilt rows, then delete the copy and its bucket — once the rows are rebuilt, and within 30 days at most ([[retention]]).
5. **Lift the stop** within **14 days**: orphaned guest data is not removed while it is in place. Delete both objects:

   ```bash
   bunx wrangler r2 object delete cire-sheets/reconcile/stop --remote
   bunx wrangler r2 object delete cire-assets/reconcile/stop --remote
   ```

   Do not write a stop object again to extend it: its age, which the daily email reports, counts from the last write.

The 14-day limit is this runbook's, not the code's: nothing lifts a stop by itself, and the daily email is the reminder. `CIRE_R2_RECONCILE_DISABLED` in `cire/api/wrangler.toml` turns both reconcilers off for a whole tier through a reviewed deploy; it is not the emergency route, and a dashboard edit of it is written back by the next deploy. Never `wrangler secret put` that name.

## Project changes required

Tracked with `C-` IDs:

1. **DR plan finalised** — this page is the outline; complete it once we choose the Supabase target. ID: **C-M6**.
2. **First restore drill** — schedule for Q3 2026 (initial dry run before production traffic). ID: **C-M6** (bundled).
3. **GitHub mirror** to a second host (Codeberg / Gitlab.com / private S3) for code-catastrophic-loss scenarios. ID: **C-L23**.
4. **Encryption-at-rest documentation** — confirm Supabase / R2 / Redis-provider encryption-at-rest defaults; capture in [[soc2]] C1. ID: **C-L24**.
5. **Backup integrity verification** — checksum each snapshot; reject restores from corrupted snapshots automatically. ID: **C-L25**.
