---
title: Backup + Disaster Recovery (SOC 2 A1)
tags: [compliance, soc2, backup, dr, availability]
related:
  - "[[index]]"
  - "[[soc2]]"
  - "[[breach-response]]"
  - "[[retention]]"
  - "[[account-deletion]]"
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
| Restoring any production database (D1 Time Travel) to an earlier point | It undoes every deletion made since that point. A deletion the restored database still records as due (an account in its 7 days, a soft-deleted wedding, guest data past its date) runs again at the next sweep; when osn-api's and cire's databases are both restored, cire's erasure then emails the remaining owners of a wedding whose payout account holder it takes a second time, unless cire's seats are gone by then (englishstreetventures/osn#2541). A deletion asked for after the restore point is undone in the database: that account, wedding or guest detail comes back live. Each such request is recorded outside the database ([[#Deletion records outside the databases]]), and the action that applies the records again is englishstreetventures/osn#2541. So a restore is the owner's decision, made knowing this, and each lost deletion is repeated before the restore counts as done |
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

## Deletion records outside the databases

A D1 Time Travel restore takes a database back to an earlier minute, and with it every erasure request accepted since. So each product's API Worker records every erasure request it accepts, and each withdrawal of one, in a private R2 bucket of its own, before it writes the request to its database ([`shared/db-utils/src/deletion-records.ts`](../../shared/db-utils/src/deletion-records.ts)). A restore of one database leaves that product's records in place.

| Bucket | Worker | Records |
|---|---|---|
| `osn-deletion-records` | osn-api | `DELETE /account` (`account_deletion_requested`), `POST /account/restore` (`account_deletion_withdrawn`), `POST /profiles/delete` (`profile_deleted`) |
| `cire-deletion-records` | cire-api | "Remove my Cire data" (`organiser_data_removed`), a wedding's delete and restore (`wedding_deleted`, `wedding_restored`), a guest's removal of their own email address (`guest_email_removed`), osn-api's account erasure (`account_erased`) |
| `zap-deletion-records` | zap-api | osn-api's account erasure (`account_erased`) |

Dev buckets take a `-dev` suffix. Each is declared by its product's Alchemy stack, bound to its API Worker alone as `DELETION_RECORDS`, with no public access, CORS or custom domain ([[infrastructure-as-code]]); production's were created once by the owner and are adopted ([[production-deploy#2.4 Deletion-record buckets — OWNER STEP before the first release that declares them 🔑]]).

- **What a record holds.** The kind, the time it was accepted, and ids: the account, profile, wedding, guest or job it names, and, for an account deletion, the person's answers to its open actions as action ids and choice tokens, a successor's profile id among them. Cire's two erasures of an account ("Remove my Cire data" and osn-api's `account_erased`) also carry their outcome, written over the record under its own key once the call returns or stops (a failed write of it is tried once more): the weddings the call deleted; each seat of the account it removed, as a wedding and a profile, in its weddings' batches and in its clean-up alike; a wedding whose batch failed or did not answer; whether the account's clean-up ran; and whether the erasure finished. A record lists only what the database confirmed in its own answer, a statement's `RETURNING` in a batch that answered; whatever is in doubt it marks unsettled, for a person to decide. A call takes at most three owned weddings and 200 seats below owner, so every seat it removes fits its record; a call that leaves more answers not finished and the next call writes its own record. The encoder refuses any value that is not an id, a time, a flag or a fixed token, so no name, handle, email address, IP address, wedding slug or free text reaches a bucket. Records are pseudonymous personal data ([[retention]], [[data-map]]).
- **How long.** Each bucket's lifecycle rule deletes a record 31 days after it is written: Time Travel's 30-day window, and a day to apply the records after a restore. Cloudflare's [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) documentation says an object is typically removed within 24 hours of its rule coming due.
- **When the record cannot be written.** An erasure request is refused with 503 and nothing is written: no request is accepted without its record. A withdrawal (keeping an account, restoring a wedding) tries its record once more, then goes ahead and logs the failure, since a withdrawal works only inside its window. A request the database refused after its record was written — a guarded write losing a race, a refusal only the write can make — deletes its record again. A database error leaves the record, since the write may have landed and a deletion the database took must stay on record; the person was told it failed and may try again. A write to the bucket that timed out may still land: its object is deleted once it does. A cire erasure whose payout rule stopped it before it removed a seat did nothing, and its record is deleted too. Each failure logs `deletion record write failed` (or `discard failed`, or `settle failed` when an outcome or a cire deletion could not be written) with the kind and, when the store failed, the record's key, which names no one (a failed discard or settle names the store's reason too), so an operator can find a stray record; osn-api and cire-api keep these in Workers Logs for 7 days, and zap-api, whose logs are off, answers osn-api's fan-out 503, which osn-api logs and retries.
- **After a restore.** The action that reads a bucket and applies the requests recorded after the restore point again, through the same services, is englishstreetventures/osn#2541. A record's time is taken before its write to the bucket and its database write, which can take up to the store's 5-second timeout and a batch longer, so the listing starts a minute before the restore point. A withdrawal goes ahead when its record cannot be written, so before the replay runs, the operator reads the `deletion record write failed` lines of the withdrawal kinds (`account_deletion_withdrawn`, `wedding_restored`) over the restore window, while Workers Logs still hold them. Until it ships, a restore loses the erasure requests accepted after its point, and the owner decides on a restore knowing that. A restore also undoes changes that are not erasure requests — a passkey removed, a connection ended, a guest's put-back of an address — and no record covers those.
- **What a replay applies.** A replay applies what the record says was done, bounded to the ids it lists, never "run the service again and see": the restored rows can differ from the rows the original call read, and the services decide some outcomes from the rows. For each kind:

  | Kind | A replay |
  |---|---|
  | `account_deletion_requested` | Schedules the deletion job again with its time, its answers and its hard-delete time. The hard delete then applies its rules to the rows as they stand at that time, as it would have; it removes an organisation only when no member of another account is left in it. |
  | `account_deletion_withdrawn` | Cancels that job alone, inside its window as at the record's time, and not once the restored job's purge has started. |
  | `profile_deleted` | Deletes that profile alone. Where the restored rows refuse it (the account's last profile, an organisation owner), it is counted for the operator. |
  | `wedding_deleted`, `wedding_restored` | Deletes or restores that wedding alone, with its rules checked as at the record's time. |
  | `guest_email_removed` | Removes that guest's address and opts them out, whatever address the restored row holds. |
  | `organiser_data_removed`, cire's `account_erased` | Applies the outcome, by the rules for the records of one account below, and never infers. It deletes the weddings listed as deleted. It takes the seats listed in `removedSeats`, the clean-up's seats below owner among them, and no other seat, so a seat the call kept stays; a listed seat on a wedding another record leaves unsettled is taken too. A listed seat whose removal would leave a live wedding with no owner on the restored rows (an owner who joined after the restore point kept it live in the original) is not taken, and that wedding goes to the operator. It applies nothing for a wedding in `unsettledWeddings`, for `cleanUp: unsettled`, or for a record with no outcome (its Worker stopped mid-call, or the outcome's write failed twice and was logged); each goes to the operator. |
  | zap's `account_erased` | Erases again: every write is bounded by the profile ids, or deletes a chat whose only members on the restored rows are the person's profiles. |

- **Records of one account.** Cire's erasure of an account can take several calls, each with its own record, of either kind. A replay takes them together:
  1. It applies the union of their `deletedWeddings` and of their `removedSeats`. A wedding one record lists as unsettled stays unsettled unless a later record of the same account (by `at`) lists it as deleted: a later delete means the wedding was still live, so the unsettled batch did not delete it. A seat a record lists on that wedding does not settle it, since it says nothing about what the earlier batch did; that seat is still taken, by the no-owner rule, and the wedding still goes to the operator. A wedding settled by a later deletion is applied, and any seat the account's profiles still hold on it after that goes to the operator, since the later record lists only the seats its own call took.
  2. Then, once, if any of them says `cleanUp: done`, it runs the rest of the account's clean-up, without the clean-up's own seat delete (its seats are in `removedSeats`). It runs in the `account` scope if any `account_erased` record of the account says done, and in the `host` scope otherwise, which keeps guest account links and vendor listing claims.
  3. It deletes the account's organiser sessions when any `account_erased` record of it exists, whatever that record's outcome says: the record is the accepted request to erase the account, and no one else's data depends on those sessions. It also deletes them when any record says `finished: true`. And it clears every wedding deleter naming one of its profiles when any record says `finished: true`, without reading the restored rows' "no seat left" guard: such a record says the live call ran those statements. Otherwise the guard stands, and a seat the restored rows hold that no record lists keeps them, counted for the operator.
- **What the operator does with what the records leave open.** An unsettled wedding, an unsettled clean-up, a wedding a seat removal would leave with no owner, a wedding settled by a later deletion that still holds a seat of the account, and a record with no outcome each mean the records cannot say what the live call did, so a person decides; the replay applies nothing for them. It names each to the operator by account and wedding id in the operator's own terminal; any output a CI job or log keeps carries counts only, never an id. For each, the person who runs the restore (on production, the owner; an agent only on dev):
  1. Looks, on the restored database, at the wedding's `deleted_at`, at the host seats (`wedding_hosts`) the account's profiles hold on it, and at how many owner seats on it are held outside the account, beside the account's records.
  2. Decides one of: run the account's erasure again on the restored rows, through the same service the original call ran (the replay's operator action, englishstreetventures/osn#2541), knowing it decides from those rows and takes every seat of the account, deleting the wedding when no other owner is left; or leave the wedding as restored, when its rows already show what the request asked (no seat of the account left, or the wedding deleted). When the wedding has no owner seat outside the account and no record lists it as deleted, the restore has removed the owner the original kept it for, and running again would delete another person's wedding: the operator keeps the wedding and the account's seat, and records it as an erasure left open until an owner returns: by count on the restore's issue, and by account and wedding id only in the private tracker. Whether and how to close it is the owner's call.
  3. Notes on the restore's issue how many cases were decided each way, with no ids.

## Project changes required

Tracked with `C-` IDs:

1. **DR plan finalised** — this page is the outline; complete it for the D1 databases above.
2. **First restore drill** — schedule for Q3 2026 (initial dry run before production traffic).
3. **GitHub mirror** to a second host (Codeberg / Gitlab.com / private S3) for code-catastrophic-loss scenarios.
4. **Encryption-at-rest documentation** — confirm D1 / R2 / Durable Object storage encryption-at-rest defaults; capture in [[soc2]] C1.
5. **Backup integrity verification** — checksum each snapshot; reject restores from corrupted snapshots automatically.
