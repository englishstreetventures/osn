---
title: Backup + Disaster Recovery (SOC 2 A1)
tags: [compliance, soc2, backup, dr, availability]
related:
  - "[[index]]"
  - "[[soc2]]"
  - "[[breach-response]]"
last-reviewed: 2026-11-27
---

# Backup + Disaster Recovery

SOC 2 Availability (A1) requires a documented backup + DR posture with
evidence of operating effectiveness — that is, you have run the restore
drill and it worked.

## Targets

| Metric | Initial target | Stretch | Notes |
|---|---|---|---|
| RPO (max acceptable data loss) | 24 h | 1 h | D1 Time Travel restores a production database to any minute of the last 30 days |
| RTO (max acceptable downtime) | 4 h | 1 h | Service redeploys can be fast; data-restore is the bottleneck |
| Backup retention | 30 d | Same | D1 Time Travel on Workers Paid. The privacy notices state 30 days, so a longer retention changes them first |
| Off-region copy | Weekly | Daily | None today: D1 Time Travel, inside Cloudflare, is the only copy of each database |
| Restore drill cadence | Quarterly | Monthly | Documented evidence per drill |

*Quoted 2026-11-19 from Cloudflare's [D1 Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/): Time Travel "is always on" and restores "up to 30 days in the past (Workers Paid plan) or 7 days (Workers Free plan)".*

## Today's posture (gap analysis)

| Component | State | Gap |
|---|---|---|
| Local-dev SQLite | Throwaway | Not in scope |
| Production databases: Cloudflare D1 (`osn-db-prod`, `cire-db`, `zap-db-prod`) | Deployed. D1 Time Travel is always on: it restores a database to any minute of the last 30 days on Workers Paid, the production account's plan ([[production-deploy#1.4 Workers Paid on the production account]]), and of the last 7 days on Workers Free, the dev account. Deleted rows stay restorable for that long | No copy outside Cloudflare, and no restore drill written up yet |
| osn-api's coordination store (a Cloudflare Durable Object: long-window rate limits, ceremonies, lockouts — [[coordination-store]]) | Ephemeral by design: every entry has a TTL of minutes to a day, 72 hours for a recovery disown token | OK — no DR needed. A lost store resets limits and drops ceremonies in flight, and every consumer fails closed while it is down. Rotated-session records are in D1, with the rest of osn-api's data |
| Cire object storage — Cloudflare R2 `cire-sheets` (guest spreadsheets) and `cire-assets` (invite images) | Deployed, with no object versioning and no second copy. The daily cron's orphan reconcilers permanently delete any object no `cire-db` row names once R2 says it is 7 days old, unless an operator has stopped them (below) or a run is held because the rows naming keys fell by more than half | No backup. Restoring `cire-db` to an earlier point (below) puts objects at risk |
| Other object storage (planned: R2 for avatars, event covers, message media) | Not deployed yet | Mirror across two regions |
| Cloudflare Workers Logs and traces | Vendor-managed, kept 7 days on Workers Paid ([[retention]]); nothing is exported | Out of our scope; nothing to restore |
| Cloudflare Email | Vendor-managed | Same |
| GitHub | Vendor-managed | Same; mirror code to a second host (e.g. Codeberg) for catastrophic-vendor scenario |

## Restore drill protocol

Quarterly. Documented under `wiki/compliance/dr-drills/<YYYY>-<Q>.md`.

1. Pick a backup from ≥7 days ago (this tests that we can restore a backup that old).
2. Set up a parallel environment (DB instance, services).
3. Restore from backup.
4. Smoke-test:
   - `/health` returns 200 on osn-api and zap-api, and cire-api's `GET /api/auth/session`
     returns 200 `{"signedIn":false}` (cire-api has no health route). `/ready` checks no
     dependency on any service ([[observability-setup]]), so it proves nothing here.
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
| Database corruption | Restore the database with D1 Time Travel to a minute before the corruption, within the last 30 days |
| Database accidental delete (DROP TABLE, etc.) | Same; 7-day soft-delete policy on user actions reduces blast radius |
| Restoring any production database (D1 Time Travel) to an earlier point | It undoes every deletion made since that point. A deletion the restored database still records as due (an account in its 7 days, a soft-deleted wedding, guest data past its date) runs again at the next sweep; when osn-api's and cire's databases are both restored, cire's erasure then emails the remaining owners of a wedding whose payout account holder it takes a second time, unless cire's seats are gone by then (englishstreetventures/osn#2541). A deletion asked for after the restore point is lost: that account, wedding or guest detail comes back live, and nothing outside the database records the request. So a restore is the owner's decision, made knowing this, and each lost deletion is repeated before the restore counts as done |
| Restoring `cire-db` (D1 Time Travel) to an earlier point | Rows written after the restore point are gone, so the R2 objects only they named look orphaned: the cire cron's reconcilers delete those already 7 days old at the next 04:00 UTC run, and the rest as they reach 7 days. See the runbook below |
| A cron run finds the rows naming a bucket's objects fell by more than half (a bad migration, a wrong bulk delete, a partial restore) | That reconciler deletes nothing, keeps the count from before the drop and emails `CIRE_OPS_EMAIL` every run it holds. The hold ends when the rows recover to half, when an operator deletes the bucket's position object (`reconcile/imports-position.json` in `cire-sheets`, `reconcile/assets-position.json` in `cire-assets`), or after 7 held runs, when deleting resumes and a last email says so. If the loss was a mistake, stop the reconcilers as the runbook below says |
| Region outage | None planned. Each D1 database has one primary, in Oceania; Cloudflare's read-only copies in other regions take no writes |
| Cloud provider outage | Document recovery into a second cloud (planned; long lead-time, accept 24+h RTO) |
| Domain takeover | Registrar lock + WebAuthn + alert on DNS change |
| Auth-key compromise (signing keys) | Rotate; revoke ARC kid; downstream JWKS caches keep the old key up to 5 min, so redeploy each downstream Worker to clear them sooner (see `production-deploy.md` §1.2) |
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

1. **DR plan finalised** — this page is the outline; complete it for the D1 databases above.
2. **First restore drill** — schedule for Q3 2026 (initial dry run before production traffic).
3. **GitHub mirror** to a second host (Codeberg / Gitlab.com / private S3) for code-catastrophic-loss scenarios.
4. **Encryption-at-rest documentation** — confirm D1 / R2 / Durable Object storage encryption-at-rest defaults; capture in [[soc2]] C1.
5. **Backup integrity verification** — checksum each snapshot; reject restores from corrupted snapshots automatically.
