---
title: DSAR Runbook (Access, Erasure, Rectification, Portability)
tags: [compliance, gdpr, ccpa, dsar, runbook]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[ccpa]]"
  - "[[data-map]]"
  - "[[retention]]"
  - "[[cire]]"
  - "[[cire-auth]]"
last-reviewed: 2026-11-16
---

# DSAR Runbook

How OSN handles a **Data Subject Access Request** (GDPR Arts. 15, 16, 17,
18, 20, 21) or a **Verifiable Consumer Request** (CCPA / state laws). One
runbook, two regimes, because the operational steps overlap.

## Endpoints and entry points

| Channel | Who uses it | Where it lands | SLA |
|---|---|---|---|
| `GET /account/export` | The account holder, self-service | `@osn/api` — streams NDJSON | Immediate |
| `DELETE /account` | The account holder, self-service | `@osn/api` — soft delete, then hard delete in 7 d | 7 d |
| `DELETE /account` (pulse-api, Flow B) | Leave Pulse without losing OSN | `@pulse/api` — soft delete + hosted-event 14-day cancellation window | 7 d (account) / 14 d (events) |
| `dsar@osn.example` (planned, alias on landing) | Anyone via email | Identity team inbox | 30 d (GDPR) / 45 d (CCPA) |
| Postal address (planned, on landing) | Anyone via mail | Identity team inbox | Same |
| Authorised agent | Third party with notarised authority | Same email + verification | Same; verification adds days, log it |

## Step-by-step for a written request

1. **Acknowledge within 72 hours** — automated reply confirming receipt and the response deadline.
2. **Identify the regime** — GDPR if EU/UK; CCPA + state laws if US-resident; treat unclear cases as both (apply the stricter rule).
3. **Verify identity** — for the account holder using the in-app endpoints, the bearer token + step-up token verifies them. For email/postal:
   - First test: email-controlled OTP to the email on file.
   - If that fails (e.g. user has lost the email): require step-up via a recovery code, OR a notarised statement of identity, OR proof of association (last login IP region, recent profile activity).
   - **Do not** require government ID for a basic DSAR — over-collection.
4. **Verify scope** — the request must specify the right exercised. "I want my data" = Art. 15 (access). "I want it deleted" = Art. 17. "I want it sent to Acme" = Art. 20 (portability). Document the inferred scope back to the requester before acting.
5. **Authorised agent path** — verify notarised power-of-attorney + the underlying user's identity per step 3. CCPA also allows the user to confirm directly.
6. **Execute** — see "Per-right execution" below.
7. **Respond** — include what was provided / deleted, the format, the lawful basis to refuse anything refused (see "Refusals"), and the right to lodge a complaint with a supervisory authority (GDPR Art. 77 — list the relevant DPA based on user's residence).
8. **Log** — add a row to `dsar_requests` (planned table) including: opened, closed, regime, right exercised, decisions, evidence path. Retain 24 months (CCPA min).

## Per-right execution

### Art. 15 — Right of access

Status: **shipped**. `GET /account/export` — bearer +
`x-step-up-token` (purpose `account_export`) gated, 1 export / 24 h / account,
streams the NDJSON bundle below. Implementation: `osn/api/src/routes/account-export.ts`
+ `osn/api/src/services/account-export.ts`; the `pulse.*`, `zap.*` and `cire.*`
sections are fetched over ARC (scope `account:export`) from the
`POST /internal/account-export` of every app in `DELETION_APPS`
(`osn/api/src/services/deletion-apps.ts`) and streamed through line-by-line,
degrading to a `{"degraded":...}` line if a bridge fails. Building Zap's inbound-ARC stack for
this also closed the gap where Zap had no `/internal` ARC surface.

Use `GET /account/export`. The endpoint returns a JSON bundle:

- `account` — explicit field list: `email`, `passkey_user_id`, `max_profiles`, `created_at`, `updated_at`. **Never includes the internal `accountId`** per the [[identity-model]] privacy invariant — `accountId` is the multi-account correlation key and must not appear in any API response, even one served to the account holder.
- `profiles[]` — rows from `users` for this account.
- `passkeys[]` — `id`, `label`, `aaguid`, `backup_eligible`, `backup_state`, `last_used_at`, `created_at`. **Not** `credentialId` or `publicKey` — those have no value to the user and could leak in transport.
- `sessions[]` — `ua_label`, `ip_hash` (raw, not the public 16-hex handle), `last_used_at`, `created_at`. Note: `ip_hash` is HMAC-peppered; we cannot reverse to an IP.
- `security_events[]` — kind, metadata, created_at, acknowledged_at.
- `recovery_codes` — `total`, `used` (counts only; never the hashes).
- `email_changes[]` — old / new email, timestamp.
- `oidc_consents[]` — the apps this account authorised via the OIDC provider: `clientId`, `clientName` (null if the client row was hand-deleted), `profileId`, `scope`, `grantedAt`, `revokedAt`. Revoked grants are **included** — the withdrawal itself is the person's record. Never the internal `accountId`.
- `oidc_clients_owned[]` — the relying parties this account registered via `POST /oidc/clients` (added 2026-07-24): `clientId`, `name`, `redirectUris`, `sectorIdentifier`, `createdAt`, `disabledAt`. **Never** the secret hash, never the internal `accountId`.
- `connections[]` — requester / addressee handles + status + timestamps.
- `blocks[]` — blocked handles + timestamps.
- `organisations[]` — orgs the account's profiles own or are members of.
- `pulse.rsvps[]` — fetched via ARC from `@pulse/api`. Status, event title (if visible to the requester), timestamps.
- `pulse.events_hosted[]` — events created by the account's profiles.
- `pulse.close_friends[]`.
- `zap.chats[]` — chat ids, role, joined-at. **Message content is excluded** because it is E2E-encrypted and we cannot decrypt; the user's local Zap client can export the decrypted history separately.
- `cire.weddings[]` — fetched via ARC from `@cire/api` (`cire/api/src/routes/internal-account-export.ts`, `services/account-export.ts`): one record for every seat a profile of the account holds on a cire wedding, a soft-deleted wedding's included until its purge. Each has `weddingId`, `name`, `profileId` (the account's own profile holding the seat), `role`, `seatAddedAt`, `seatAddedBy` (the profile that gave the seat, the source of the data, Art. 15(1)(g)), `otherOwners` (a count; other owners are never named, Art. 15(4)), `deletedAt`, `restoreUntil` and `deletedByYou` (filled only where the requester owns the wedding or deleted it: cire never tells a co-host a wedding was deleted), and `download`: for an owner of a live wedding, the host-portal page that downloads the whole wedding, `<organiser origin>/#/w/<weddingId>/settings/export` (null unless the portal is `https:`, or `http:` on a loopback host). The wedding's own data is not in the bundle — guest data is not the owner's personal data ([[#Cire (wedding-invite) data]]), the fan-out gives each app 10 seconds for its whole answer, and NDJSON cannot carry the wedding's pictures — so the owner takes it from that download. The link works only while the account can sign in to cire: a pending deletion ends cire's organiser sessions and `/authorize` refuses the account, so the download comes before the deletion is confirmed. Past 500 seats the section ends with `{"degraded":"cire","reason":"too_many_weddings"}`. Tests: `cire/api/tests/routes/internal-account-export.test.ts`; end to end, `tools/e2e/tests/flows/musubi-step-up-email.flow.ts`.
- `consents[]` — once consent records ship.
- `dsar_requests[]` — prior requests for this user.

**Wire format:**

- **NDJSON envelope** — one JSON object per line, prefixed by a header line `{"version":1,"sections":[...]}` and terminated by `{"end":true}`. This lets the response stream via `ReadableStream` without ever holding the full bundle in memory.
- **Per-section keyset pagination** — every multi-row section (`security_events`, `sessions`, `connections`, `pulse.rsvps`, `pulse.events_hosted`, `zap.chats`) is fetched in batches of `LIMIT 500` ordered by `id` with `WHERE id > :cursor`. No `OFFSET` (degrades on large tables).
- **ARC fan-out sub-bundles streamed** — `pulse.*`, `zap.*` and `cire.*` sections are fetched via ARC and re-serialised line-by-line into the outer NDJSON; the bridge call uses chunked transfer too.
- **Memory budget** — ≤32 MB resident per export. A run that exceeds the budget logs a warning + truncates with a tombstone record, so the user gets a partial bundle + a notice rather than an OOM.

Auth: bearer access token + step-up token. Rate-limit: 1 export per 24 h per account.

### Art. 16 — Rectification

Most fields are user-editable in `@musubi/social` (handle change, displayName, avatar, email change). For non-editable fields (security_events metadata, sessions ua_label) — these are observed facts, not user-supplied data; rectification right is narrower under GDPR Recital 65 ("inaccuracy" must be the data itself). Document the refusal under "Refusals" if challenged.

### Art. 17 — Right of erasure

Status: **shipped**. Two flows:

- **Flow A — full OSN account delete.** `DELETE /account` on osn-api. Soft-deletes the account at once. Once the 7-day grace window has passed, the six-hourly cron calls every app over ARC with the person's answers (`runFanOutRetrySweep`, [[#The apps' open actions and the app contract]]), then hard-deletes it (`account-erasure.runHardDeleteSweep`).
- **Flow B — per-app delete (leave Pulse).** `DELETE /account` on pulse-api. Soft-deletes the user's Pulse-scoped data; hosted public events get a 14-day public-cancellation window (audience-commitment, independent of the account grace) before being hard-deleted. Pulse calls back to osn-api `/internal/app-enrollment/leave` to flip `app_enrollments.left_at`. The OSN account stays alive — the user can keep using Zap / OSN identity.

Use `DELETE /account` ([`routes/account-erasure.ts`](../../osn/api/src/routes/account-erasure.ts), [`services/account-erasure.ts`](../../osn/api/src/services/account-erasure.ts)). The request needs the profile's handle typed (`confirm_handle`), a live session, every app able to answer a fresh preview, an answer for each open action that needs one, organisation or app, or `delete_everything: true` instead (below), and a step-up token for `account_delete`, read last, so a refused request spends no token. Three stages:

1. **Soft delete** (`requestErasure`), one read and one batch, answering 202 with `scheduled_for`. In order:
   - writes the `deletion_jobs` row, with a random `job_id`, its restore record (`restore`: each profile's handle, display name and avatar as they stood, and the ids of the open app enrolments), the person's answers to the open actions (`choices`), `delete_everything`, and every app's mark (`pulse_done_at`, `zap_done_at`, `cire_done_at`) NULL: the fan-out reaches every app, whatever the account's enrolments. The restore record comes from the rows this statement reads, so an enrolment that lands before it is closed with the rest;
   - redacts every profile: handle `deleted_<id>`, or `deleted_<id>_<8 hex>` when another profile already has `deleted_<id>`; display name and avatar cleared;
   - holds each profile's handle in `handle_holds`, as a keyed hash, with one insert whatever the profile count ([[#Handle holds]]);
   - deletes every session and rotation record of the account but those of the requesting device's family;
   - writes an `account_deletion_scheduled` security event;
   - closes every open app enrolment;
   - sets `accounts.deleted_at`, last: a job and a tombstone together mean the whole batch ran.

   A deletion counts as pending only when the job and the tombstone both stand. On D1 the batch is atomic. On bun:sqlite, which runs a batch one statement at a time, a batch that fails part way answers the failure, and so does every retry, since the job's key refuses a second job. Test: `osn/api/tests/services/account-erasure.test.ts` ("a soft delete that fails at its redaction answers the failure, and so does a retry").

   An app join (`/internal/app-enrollment/join`, `joinApp`) for an account whose deletion is pending writes no enrolment and answers `enrolled: false`: its insert reads `accounts.deleted_at` in the same statement. It changes nothing on the job, which reaches every app anyway. Tests: `osn/api/tests/services/account-erasure.test.ts` ("joinApp writes nothing for an account whose deletion is pending", "a join refused during the window leaves the job as it is").

   Passkeys, recovery codes and TOTP stay until the hard delete, so a person who can still sign in can cancel. The soft delete ends OSN sessions, and, in the background, the person's Pulse web sessions (`POST /internal/account-sessions/revoke` on pulse-api, scope `account:sessions-revoke`, best effort: a refusal is counted as `osn.account.deletion.app_sessions_ended` and logged, and Pulse's erasure at the end of the window deletes any that survived). Cire's organiser sessions are not OSN sessions: the route then asks cire-api to end them through the same revoke sign-out-everywhere uses (`POST <CIRE_API_URL>/internal/revoke-organiser-sessions`, one call per profile of the account that has signed in to cire, trigger `account_deletion` on `osn.auth.cire_session.revocations`, [[sessions#Sign out everywhere else reaches cire]]), best effort and only where both Workers hold `CIRE_INTERNAL_REVOKE_SECRET`; cire's erasure at the end of the window deletes any that survived. Nothing else changes in cire during the window, so a cancel loses nothing there. A new sign-in to any relying party is refused, since `/authorize` answers `access_denied` for an account whose deletion is pending, before it records a consent or mints a code (`osn/api/tests/routes/oidc.test.ts`, "GET /authorize for an account whose deletion is pending").

   Two deletes at once answer one 202 scheduled and one 202 `already_pending`, never a 500. A repeat during the window answers `already_pending` with the date, before the handle check, since the handle is redacted by then; it needs no step-up. Tests: `osn/api/tests/routes/account-erasure.test.ts` ("two deletions at once…", "DELETE /account returns 202 with both scheduling fields, and is idempotent") and `osn/api/tests/d1/account-hard-delete.test.ts` ("two deletions of one account at once on D1"); credentials kept and the restore record written: `osn/api/tests/services/account-erasure.test.ts` ("soft-deletes the account, redacts identity, keeps credentials and the cancel session", "holds every profile's handle and records each in the restore record").

2. **The window**, seven days. Any sign-in of the account, from any device, mints a **pending-deletion session**: its access tokens carry the audience `osn-pending-deletion` ([[sessions#The pending-deletion session]]). The device that asked keeps its session, which mints the same audience from its next refresh. Such a token reaches only:
   - `GET /account/deletion-status`;
   - `GET /account/export`, with an `account_export` step-up. Its profiles section shows each handle, display name and avatar as the restore record holds them;
   - `POST /account/restore`, with an `account_restore` step-up ([[step-up#Purpose binding]]);
   - `DELETE /account`, for the `already_pending` answer only;
   - `GET /totp/status`, which the step-up sheet reads before it offers the authenticator;
   - the step-up routes, for those two purposes only.

   Every other route, and Pulse, Zap and cire, refuse it, since they pin `osn-access`. A passkey, a recovery code, or email or TOTP recovery each lead here. Recovery ends in a passkey enrolment, which a restricted recovery session of such an account may make, and the session's next refresh is pending-deletion ([[account-recovery-factors#Recovery of an account whose deletion is pending]]). So **mailbox access alone is enough to cancel an erasure**: email recovery, enrol a passkey, step up with it or with an emailed link, cancel. Every notice about the account goes to that mailbox. Sign-in by the handle the person had does not find the account during the window, since every handle is redacted; sign-in by email, or with a discoverable passkey, does. Tests: `osn/api/tests/routes/pending-deletion-session.test.ts`.

   **Cancel** (`POST /account/restore`, `cancelErasure`) needs any live session of the account and an `account_restore` step-up token, from the body's `step_up_token` or the `x-step-up-token` header. In one batch it deletes the job, clears `accounts.deleted_at`, records an `account_deletion_cancelled` event, and, from the restore record: puts back each profile's handle, display name and avatar; reopens the enrolments the deletion closed, where the account has no other open enrolment in that app; and releases the account's handle holds. A profile whose handle someone else holds by then, as a profile or an organisation, keeps its redacted handle; either redacted form is put back. A job written before the restore record existed cancels with none of the putting back. Tests: `osn/api/tests/services/account-erasure.test.ts` ("puts back each profile's handle, display name and avatar…", "a handle taken by a profile or an organisation since stays redacted…", "a job written before the restore record existed cancels as before") and `osn/api/tests/routes/account-erasure.test.ts` ("POST /account/restore asks for an account_restore step-up").

3. **Hard delete** (`hardDeleteAccount`), once the window has passed and the fan-out has finished with every app. One batch, with no read before it:
   - each organisation a profile of the account owns passes on or goes ([[#Organisations the person owns]]);
   - deleted: connections, blocks, the account's memberships, OIDC consents and authorization codes, the profiles, sessions, rotation records, passkeys, recovery codes, TOTP, every `app_enrollments` row of the account, open or closed, the `deletion_jobs` row, and the `accounts` row;
   - OIDC clients the account registered are disabled and unlinked;
   - the handle holds lose their account id and are released 30 days on;
   - kept, as security records (Art. 6(1)(c)+(f), [[data-map]]): `security_events` (12 months) and `email_changes` (90 days), with the account id they name.

   Outside osn-api's database, before the hard delete, the fan-out reaches every app ([[#The apps' open actions and the app contract]]):
   - Pulse deletes the person's RSVPs, close friends, messages sent, Pulse profile, onboarding, series and web sessions; each upcoming event they host is cancelled and kept 14 days for its guests, or deleted at once, as answered; finished and cancelled events are deleted.
   - Zap removes their memberships, deletes a chat left with no one with its messages, replaces their sender id with a deletion sentinel on what stays and wipes the body of a plain-text message they wrote; an end-to-end message keeps its ciphertext, which Zap cannot read and the other members still hold.
   - cire removes their seats; deletes a wedding that leaves with no owner, in the same batch; deletes their organiser sessions, guest account links, Stripe OAuth states and budget rows; and clears every column that names them ([[#Cire (wedding-invite) data]]). It keeps nothing.
   - Backups remain until next rotation cycle (document in privacy notice).
   - Grafana logs: redacted at write time, no PII to scrub. Trace and metric retention windows handle the rest.

Nothing of the account outlives the hard delete in osn-api's database but its `security_events` and `email_changes` rows, kept for their windows, and its handle holds: keyed hashes with no account id, which the retention sweep deletes 30 days later ([[retention]]).

**Fan-out reliability:**

- **`deletion_jobs` table** — one row per soft-delete, with columns `account_id`, `soft_deleted_at`, `hard_delete_at` (= `soft_deleted_at + 7 d`), `pulse_done_at`, `zap_done_at`, `cire_done_at` (one mark per app: a positive time once the fan-out is done with it, NULL while pending), `reason`, `cancel_session_id`, `purge_started_at`, `restore` (what a cancel puts back), `choices` (the person's answers, organisation and app, JSON keyed by action id; NULL with `delete_everything`, which two triggers enforce on insert and update), `delete_everything`, `app_outcomes` (what each app reported, JSON keyed by app: `{ "status": "done", "kept": [...] }` or `{ "status": "skipped" }`), `fanout_failed_at`, `hard_delete_failed_at` ([[#Hard-delete sweep isolation]]) and `job_id` (a random id naming the job; NULL on a row written before the column). A row written before every account went to every app may hold `-1` ("not enrolled") in a mark: that reads as pending, so such a job is sent to that app too; so does the NULL `cire_done_at` of a row written before that column.
- **A hard delete never outruns an app's purge.** The hard delete's read, its claim, and its delete of the job inside the batch each need every mark to read done (positive) at the moment they run; otherwise the claim refuses, or the job stays, the `accounts` delete fails on the job's foreign key and D1 rolls the whole batch back. The fan-out claims a job before it calls any app, so a job with an app still pending usually reaches the hard delete claimed already, and then only the read and the batch's job delete hold it. Only the fan-out writes a mark, from pending to a time, and only while the mark reads pending: a mark another pass wrote first, and that app's outcome, stand, and the later pass counts nothing. `/internal/app-enrollment/join` and `/leave` write only for the calling service's own app (`pulse-api` for `pulse`, `zap-api` for `zap`, from the ARC token's signed issuer). Tests: `osn/api/tests/d1/account-hard-delete.test.ts` ("the hard delete waits for every app, on D1", a claimed job included), `osn/api/tests/services/deletion-fanout.test.ts` and `osn/api/tests/routes/internal-account.test.ts` ("internal app enrolment writes").
- **A cancel never restores an account a purge has begun on.** `POST /account/restore` cancels only inside the grace window. Before a sweep sends its first bridge call, or the hard delete runs, it stamps `purge_started_at`, and only while the job row still exists. The cancel deletes the job it read (the one with the `job_id` it read; for a row with none, the one with its `soft_deleted_at` and no `job_id`) only while `purge_started_at` is NULL and the window is open, in the same statement, then restores the account and writes its audit event only once no job stands. So a cancel and a purge that meet at the end of the window settle one way: the cancel lands first and the sweep finds no job to purge, or the sweep claims first and the cancel answers `{ cancelled: false }`, as one past the window does. The `account_deletion_cancelled` event's id is derived from the account and the job's `job_id`, so a job's cancellation is recorded once: of two cancels of the same job, the second answers `{ cancelled: false }` and writes nothing, and a cancel that read a job the user has since cancelled and asked for again, even in the same second, leaves the new job standing. Tests: `osn/api/tests/services/account-erasure.test.ts` (both orders, fan-out and hard delete; two cancels of one job; a cancel of a replaced job, also in the same second) and `osn/api/tests/d1/conditional-writes.test.ts` (both orders of the fan-out, and two cancels of one job, on D1).
- **Idempotent per app** — each app's `/internal/account-deleted` accepts the same `accountId` repeatedly: a repeat, or a second call that overlaps the first, writes nothing more and answers what the first call kept (Pulse reads it from the kept events; Zap from `zap_account_purges`, whose count the erasure's own batch writes). The sweeper retries an unfinished app every cycle until its mark is done.
- **Parallel fan-out, one stuck job never blocks the rest** — each pass reads its jobs once, with what every app is sent; a job's pending apps are called at once, each with a 10 s timeout; jobs four at a time. A job's first pass claims it and, in the same statement, marks each app the tier does not run as skipped. An app that does not answer, answers an error, or answers outside the contract leaves its mark pending and stamps the job's `fanout_failed_at`, and so does a job whose fan-out fails for any other reason, such as stored answers that do not parse; each pass reads never-failed jobs first, then the least recently failed, each group by `hard_delete_at`. A pass reaches at most `OSN_DELETION_FANOUT_MAX_JOBS` jobs (unset: 4, inside Workers Free's 50 D1 queries a cron run; production: 50), and the hard delete erases at most as many accounts ([[free-tier-limits]]). Tests: `osn/api/tests/services/deletion-fanout.test.ts`.
- **ARC rate limits** — no ARC route carries one. osn-api's calls are bounded by the per-run job cap and, for previews, by the per-IP limiter on `GET /account/deletion-preview` and `DELETE /account`.

The export path uses the same `Effect.all` parallelism + 10 s per-bridge timeout. A failing bridge during export emits a partial bundle with a `{"degraded":"pulse|zap","reason":"..."}` line so the user can see the gap and re-request later.

#### Organisations the person owns

One profile owns each organisation (`organisations.owner_id`). `GET /account/deletion-preview` lists each organisation a profile of the account owns as an open action with the id `osn:organisation:<orgId>`, the member it would pass to (`successor`), the choices it allows and its default:

| The organisation has | Choices | Default |
|---|---|---|
| another admin, from another account | `transfer`, `successor`, `delete` | `transfer`: needs no answer |
| no other admin, but a member from another account | `transfer`, `successor`, `delete` | none: the person must answer |
| no member from another account | `delete` | none: the person must answer |

`DELETE /account` takes the answers as `choices: [{ action, choice, successor_profile_id? }]`, at most 200, and stores them on the job. It answers 409 `{ error: "open_actions", open_actions }` while an organisation with no default has no answer, and 400 `{ error: "invalid_choice", action }` for an action answered twice, a choice the organisation does not offer, or a successor who is not a member from another account. Both answers come before the step-up token is read. An answer for an action the account does not have is ignored.

At the hard delete, in its batch and before the profiles go, each owned organisation passes to:

1. the successor the person named, while that profile is still a member from another account;
2. else the longest-standing admin from another account;
3. else the longest-standing member from another account, who is made admin;
4. else, or where the person chose `delete`, no one: the organisation and its memberships are deleted.

Longest-standing means the earliest `organisation_members.created_at`, then the lowest id. The account's own other profiles are never chosen. The rules run on the rows as they stand at the hard delete, not as the preview showed them, so an organisation whose other admins all left during the window falls to rule 3 or 4 with no further question. cire's weddings follow the same rule: a wedding the person is the only owner of when the fan-out reaches cire is deleted, even one that had another owner when they asked ([[#Cire (wedding-invite) data]]). No email tells the new owner. `osn.account.deletion.organisation` (`outcome`: `transferred` or `deleted`) counts each. Tests: `osn/api/tests/services/account-erasure.test.ts` ("account-erasure: owned organisations at hard delete"), `osn/api/tests/d1/account-hard-delete.test.ts` (the same rules on D1 with foreign keys enforced) and `osn/api/tests/routes/account-erasure.test.ts` ("the organisations an account owns").

#### The apps' open actions and the app contract

Every app takes part in an account deletion through two ARC calls, signed with osn-api's published outbound key ([[arc-tokens#osn-api as issuer — published outbound keys]]). Every account goes to every app; nothing checks enrolment. The apps are `DELETION_APPS` in [`osn/api/src/services/deletion-apps.ts`](../../osn/api/src/services/deletion-apps.ts): Pulse, Zap and cire. A further app is one more entry there, its `*_done_at` column, its URL variable, and its host in the stacks.

| Call | Scope | Request | Answer |
|---|---|---|---|
| `POST /internal/account-deletion-preview` | `account:deletion-preview` | `{ profileIds, deletesAt }` (`deletesAt`: unix seconds the fan-out would reach the app) | `{ openActions: [{ id, kind, label, choices: [{ choice, description, erasedOn }], defaultChoice, link }] }`, at most 200; every `id` starts `<app>:` |
| `POST /internal/account-deleted` | `account:erase` | `{ accountId, profileIds, choices, deleteEverything }` (`choices`: this app's answers only, by action id) | `{ kept: [{ what, erasedOn, requestUrl }] }`, at most 100: what the app keeps, until when (unix seconds, or null for no date), and where to ask about it (https, or null) |

Only `account-deleted` carries the account id, which keys the app's record of the erasure; the preview and Pulse's session end at the soft delete (`POST /internal/account-sessions/revoke`, `{ profileIds }`, scope `account:sessions-revoke`) carry the profile ids alone ([[identity-model]]).

**Preview.** `GET /account/deletion-preview` asks every app at once (8 s each) beside the organisations, and answers `{ open_actions, could_not_check }`: each app action in the route's field names (`choices[].erased_on`, `default_choice`, `link`), and each app that did not answer in time, answered an error or a 404, or answered outside the contract (an id of another app, an action twice, a default not among its choices, a link that is not https). An action with no choices is shown for information only.

**Delete.** `DELETE /account` asks every app again. In order: `delete_everything` together with `choices` is 400 `choices_with_delete_everything`, before any app is asked; any app that cannot be checked is 409 `{ error: "could_not_check", open_actions, could_not_check }`; an answer twice, a choice an action does not offer, or a successor who is not a member is 400 `invalid_choice`; an answer to an app action the fresh preview does not list is 409 `stale_choices` with the fresh preview, so no answer is dropped silently; an action with choices and no default, unanswered, is 409 `open_actions`. An answer to an organisation id the account does not own, or to an id of no known app, is ignored. With `delete_everything` nothing is stored but the flag: each app takes, for each action it has, the choice that erases the person's data soonest, and each organisation passes to a successor where one exists (rules 2 to 4 above). Tests: `osn/api/tests/routes/account-erasure.test.ts` ("the apps' open actions").

**Where each app is.** osn-api reads `PULSE_API_URL`, `ZAP_API_URL` and `CIRE_API_URL` with no fallback, and `OSN_DELETION_ABSENT_APPS`, the apps a tier does not run. A URL must be `https:`; a local run also takes `http:` to a loopback host. Any other fails the boot (503), as a missing `INTERNAL_SERVICE_SECRET` does. An app is skipped (no preview actions; the fan-out marks it done, outcome `skipped`, and logs it) only on a local run without its URL, or where it is declared absent. On a deployed tier an app with neither fails closed: its preview is `could_not_check` and its mark stays pending. Dev and production give osn-api Zap's and cire's addresses and declare Pulse, which has no API Worker on any tier, absent (`musubi/infra/tests/deletion-apps.test.ts`). `CIRE_API_URL` is also where osn-api ends cire organiser sessions ([[sessions#Sign out everywhere else reaches cire]]), so a value that is not `https:` (or `http:` to a loopback host on a local run) refuses the boot.

**Fan-out.** No app is sent the person's email address: none keeps data a person may ask about by email. What each app answers is stored in `app_outcomes`, in the statement that marks the app done, for the email after the hard delete.

| App | Preview | Erasure | Kept |
|---|---|---|---|
| Pulse | One action per series with upcoming instances and one per other upcoming hosted event, soonest first; past 100, one `pulse:events:all`. Choices `cancel` (default: the event is cancelled, `host_left`, and kept 14 days for its guests, out of its series) and `delete` | An event's answer, else its series', else `pulse:events:all`'s, else `cancel`; under `deleteEverything`, `delete`. Each write checks the event when it runs: one a guest's visit marked finished since the read is deleted, one cancelled since keeps that cancellation | One item: the number of events kept and the date the last is deleted, read back from the events as written; no request page |
| Zap | None | As in stage 3 above; `choices` and `deleteEverything` change nothing | One item when end-to-end messages stay in chats with other members; no date, no request page |
| cire | One action per live wedding a profile of the account alone owns, `cire:wedding:<id>` (past 100, one `cire:weddings:all`): one choice, `delete`, no default, a link to the wedding's owners in the host portal. A wedding with another owner is not an action | Per wedding the account has an owner seat in, one batch: its seats and RSVP notice rows go, and the wedding is soft-deleted in that batch when no owner is left, whatever was answered. Then, once per account, the rest ([[#Cire (wedding-invite) data]]). At most three owned weddings a call; a call that leaves more answers 503 and the next pass goes on | Nothing |

#### Handle holds

A deleted account's handles cannot be taken while its deletion is pending, or for 30 days after the hard delete ([`lib/handle-hold.ts`](../../osn/api/src/lib/handle-hold.ts)). `handle_holds` stores an HMAC-SHA256 of each handle under the server pepper (`OSN_SESSION_IP_PEPPER`), never the handle itself. During the window the plain handle is only in the job's restore record, which the hard delete deletes with the job. Registration, sign-up finish, the handle check, profile creation and organisation creation refuse a held handle with the answer they give a taken one. Every check that creates or offers a handle, sign-up finish included, also refuses one that starts with `deleted_`, the form the soft delete gives a profile. Each row is pending (an account, no release) or released (a release, no account), and its handle is 64 characters: two CHECKs refuse any other row. Profile creation inserts from the account row only while no deletion is pending, so a profile made as the soft delete commits is refused ("Account not found") rather than left unredacted and unheld.

A cancel deletes the account's holds. The hard delete clears their account id and sets `release_at` 30 days ahead; from that second a hold refuses nothing, and the retention sweep deletes it. Rotating the pepper makes every hold stop matching its handle, so each held handle comes free early. With no pepper (local dev and tests) the key is random for the life of the process. Tests: `osn/api/tests/routes/account-erasure.test.ts` ("a handle held through the erasure routes"), `osn/api/tests/lib/handle-hold.test.ts`.

#### Hard-delete sweep isolation

Each pass reads up to 100 due jobs: those that have never failed first (`hard_delete_failed_at` NULL), then the least recently failed, each group by `hard_delete_at`. One account's failure, a defect included, is caught: it is logged as `account.deletion hard delete failed` with the error's tag and no ids, counted as `osn.account.deletion.completed` with `result` `hard_failed`, and stamped on the job's `hard_delete_failed_at`, so the next pass reads it last. The pass goes on to the next account until three fail in a row; it then stops and logs `account.deletion hard delete sweep stopped` once, at warning, with no ids, since three in a row point at the database (an outage, or the Worker's per-invocation query cap) rather than at the accounts. A failed stamp is logged and changes nothing else. Test: `osn/api/tests/services/account-erasure.test.ts` ("account-erasure: hard-delete sweep isolation").

#### Cire (wedding-invite) data

Cire runs its **own** Cloudflare D1 + R2, separate from `osn/db` (see
[[cire]], [[cire-auth]]). The wedding and its guest data are linked to the
organiser's OSN account only by their seat, `wedding_hosts.osn_profile_id` — an
opaque profile-id string with **no cross-DB FK**. A wedding can have several
owners, each with an `owner` seat. Two consequences:

- **DSAR reachability (Art. 15 / 17 / 20).** A DSAR from the *organiser*
  reaches their cire data via their `wedding_hosts` seats. The account export
  lists every seat (`cire.weddings`, [[#Art. 15 — Right of access]]), and an
  owner downloads a whole wedding they own from the host portal as one ZIP
  (`POST /api/organiser/weddings/:weddingId/archive`, the page
  `#/w/<weddingId>/settings/export`; [[cire-development#CSV exports]]): every
  CSV the portal offers, households, vendors, the gift list, every seating
  plan, the wedding's settings and the invitation's words and questions, the
  schedule and guest list as the import reads them, and the pictures and
  uploaded spreadsheets in R2 (`cire-assets`, and the `cire-sheets` uploads
  the couple applied or reverted), with a `manifest.json` naming anything a
  limit kept out. It is owner-only, never locked by tier, and refuses a
  soft-deleted wedding as every organiser read does: an owner restores it
  first. Erasure reaches the `families` / `guests` / `rsvps` /
  `seating_plans` / `seating_tables` / `seating_assignments` / `imports` rows
  under the weddings they own, and the R2 `cire-sheets` CSVs. On a
  wedding with another owner, erasing one owner removes their seat and leaves
  the wedding to the others. **A wedding never exists without an owner**
  (owner decision, 2026-11-16): an OSN account cannot be deleted while it is
  the only owner of a live wedding, and a wedding it alone owns when the
  deletion reaches cire is deleted. An owner can also delete a wedding
  themselves: `DELETE /api/organiser/weddings/:weddingId` soft-deletes it at
  once (hidden from every guest, vendor and co-host), any owner can restore it
  for 7 days, and the daily purge then hard-deletes it with every child row and
  its R2 objects — 7 to 8 days after the delete, later if the purge's daily cap
  or a payment still settling defers it ([[cire-auth#Soft-deleted weddings]],
  [[retention]]).
- **OSN account deletion reaches cire** over ARC
  (`cire/api/src/routes/internal-account-deletion.ts`,
  `cire/api/src/services/account-erasure.ts`), audience `cire-api`
  ([[#The apps' open actions and the app contract]]):
  - *Preview.* Each live wedding a profile of the account alone owns is an
    open action, `cire:wedding:<id>`, with one choice, `delete`, and no
    default, so `DELETE /account` answers 409 `open_actions` until the person
    answers it, chooses "delete everything", adds another owner (the action's
    link opens the wedding's owners in the host portal, and the action is then
    gone) or deletes the wedding. A wedding with another owner is not an
    action.
  - *Soft delete.* Only the person's organiser sessions end. The weddings and
    seats are untouched, so a cancel loses nothing.
  - *Erasure,* per wedding the account has an owner seat in, one D1 batch:
    the seats and their `host_rsvp_notices` rows go, and the wedding is
    soft-deleted in that batch when no owner is left, whatever was answered,
    since the rules run on the rows as they stand. The purge takes a deleted
    wedding with no owner at once, money holds still applying
    ([[retention]]). Then, once per account: seats below owner and the notice
    rows left; organiser sessions; guest account links (by the account or a
    profile); `registry_stripe_oauth_states`, `realtime_subscribe_budget` and
    the `actor:` rows of `owner_notice_budget`; an enquiry the person opened
    that never reached a chat; and every column that names a profile, cleared
    as the entries below say (`'deleted'` where the column cannot be NULL, or
    beside a time that stays or where NULL would say the guest or household
    wrote it). cire answers that it keeps nothing.
  - Leaving cire while keeping the account is not built (account-deletion
    design, phase 6). An operator handles such a request by hand, as an
    erasure request from an organiser.
- **Co-owners in an owner's export (Art. 15(4)).** An owner's own data
  includes the seats on their weddings, and those name other people: every
  other owner's and co-host's profile id, who added each seat
  (`wedding_hosts.added_by_osn_profile_id`), who deleted a wedding
  (`weddings.deleted_by_osn_profile_id`), and who redeemed an unlock code for
  it (`unlock_code_redemptions.redeemed_by_osn_profile_id`). An access answer
  gives the requester their own seat and role, and for each wedding the fact
  that it has other owners and how many, but not their profile ids, handles or
  roles, and not who deleted the wedding or redeemed its code unless that was
  the requester. Those identify a
  co-owner, whose rights Art. 15(4) protects; the co-owner can ask for their
  own. Who added the requester's seat **is** included: it is the source of
  the requester's data (Art. 15(1)(g)), and the portal already shows it to
  every member. The account export's `cire.weddings` section answers the
  seats this way on its own. Guest data under the wedding is not the
  owner's personal data, so it is not part of this answer at all: an owner
  reads and exports it in the portal, as a joint controller, the whole
  wedding at once from its archive download. The rest of an organiser's
  answer in the entries below — the replies and changes they wrote or
  attested, the addresses they attested, the Stripe account they connected,
  the codes they redeemed, the tasks they hold — is not in the account export
  yet: an operator answers it by hand with the queries each entry gives
  (englishstreetventures/osn#2330).
- **Who connected a wedding's Stripe account (migration
  `20261104040827_registry_stripe_connected_by`).**
  `registry_settings.stripe_connected_by_osn_profile_id` names the owner who
  ran Stripe onboarding, and so the one owner cire hands the account's
  onboarding links. An access answer includes it for each wedding where it
  names the requester, found by profile id rather than by seat, so an owner
  who has since left is answered too: `SELECT wedding_id FROM registry_settings
  WHERE stripe_connected_by_osn_profile_id = ?`. Where it names someone else it
  identifies a co-owner (Art. 15(4)), and the answer says only that the
  wedding has a connected account. An erasure request from the connector sets
  it to NULL in the same pass that removes their seats: `UPDATE
  registry_settings SET stripe_connected_by_osn_profile_id = NULL WHERE
  stripe_connected_by_osn_profile_id = ?`, which reaches every wedding they
  gave the account to as well. NULL beside an account matches no owner, so
  the account's links stay closed rather than opening to the other owners; the account itself, with the requester's identity and bank details,
  is Stripe's and theirs ([[retention]]), and an operator forwards the request
  to Stripe as that row says.
- **Guest DSARs.** Guests are not OSN account holders; a guest exercising a
  right is the responsibility of the wedding's owners as **joint
  controllers** (cire is their processor — see [[data-map]]). Route guest
  requests to an owner and assist as processor. An owner meets a guest's
  access request from the wedding's archive download, which holds every row
  about the guest the portal shows (their guest row, household, invitations,
  replies, seats and gifts).
- **Plus-ones (migration 0066).** A plus-one's `guests` row — their name, their
  replies and the link to the guest who brought them
  (`plus_one_of_guest_id`) — holds data another guest supplied, and the
  plus-one never holds the household's code. Their requests go to the
  organiser like any guest's. Access: the row, its `rsvps`, its
  `guest_events` and its `seating_assignments`, found by `plus_one_of_guest_id`
  or by name within the household. Erasure has three ready paths, each deleting
  the row with its replies, invitations and seats by cascade: the household removes them on the invite
  (`DELETE /api/plus-one/:guestId`) until the RSVP deadline; an editor turns
  the inviting guest's permission off, confirming the plus-one by id and
  stored name (`PUT …/guests/:guestId/plus-one`,
  `removePlusOnes: [{ guestId, firstName, lastName }]` as `GET …/guests`
  served them — a stale name is refused with `409 plus_one_named`); or the inviting
  guest is removed. The round-trip export and the change history's
  before-images leave plus-ones out, so no before-image has to be reached for
  them. **Rectification** (Art. 16): the household can rename them until the
  deadline — a rename clears the plus-one's dietary answers and consent
  record, since a new name may be a different person; an editor can correct
  the name at any time, keeping them
  (`PUT …/guests/:guestId/plus-one/name`, `:guestId` being the guest who
  brought them). See [[cire-plus-ones]].
- **Guest free text in the gift registry (migration 0057).** A guest's claim
  can carry `registry_claims.note` + `display_name`, and a contribution can
  carry `registry_contributions.message` + `display_name` — text the guest
  wrote about themselves. A guest asking to erase *what they wrote* while
  keeping the gift itself does **not** need the row deleted: null the free-text
  columns and leave `quantity` / `status` / the amount, which are facts about
  the gift rather than about the guest. Deleting a contribution row instead is
  the wrong move — it destroys the couple's record of money actually sent, and
  the registry's whole design keeps that record even when the listing goes
  (`item_id` is `ON DELETE SET NULL`). Full erasure of the household still
  works through the normal path: delete the `families` row and all three
  registry tables cascade. A note a host has **hidden** (`note_hidden_at` set,
  migration 0062) is still in the row and still the guest's data: an access
  request returns it, and an erasure nulls it the same way. The hide only
  keeps it off the couple's gift log and CSV ([[cire-registry#Hiding a note]]).
  An access answer includes `note_hidden_at`, which is a fact about the
  guest's own note, and leaves out `note_hidden_by_osn_profile_id`, which
  identifies a co-host (Art. 15(4)). An erasure that nulls the note leaves the
  pair in place; with no text they say nothing about the guest.
  The registry comes with the Gold plan tier, which is sold self-serve, so
  production can hold these rows. Tracked alongside the rest of the missing cire ARC bridge.
- **The gift record kept after the sweep.** A year after the last event the
  sweep deletes the gift rows but keeps, on
  `registry_settings.gift_summary_json`, each money gift's amount, currency
  and day, with no name ([[data-map]], [[retention]]). cire cannot tell who
  gave a line (Art. 11(1)), so a guest's access, objection or erasure request
  is answered under Art. 11(2): ask for the wedding, the amount and the day
  they gave, and find the line. The owner runs this query; an agent never does ([[agent-tooling#The guard hook]]).

  ```bash
  cd cire/api
  bunx wrangler d1 execute cire-db --env production --remote --command \
    "SELECT g.key AS idx, json_extract(g.value, '$.on') AS day, json_extract(g.value, '$.amountMinor') AS amount, json_extract(g.value, '$.currency') AS currency FROM registry_settings, json_each(registry_settings.gift_summary_json, '$.contributions.gifts') AS g WHERE registry_settings.wedding_id = '<wedding id>'"
  ```

  An **access** request is answered with the matching line. An **objection**
  (Art. 21) or **erasure** (Art. 17) that identifies a line removes it, and
  takes its amount and one gift off the record's totals with it — a total
  left holding the amount would keep the guest's figure inside it. Read the
  JSON out with the query `SELECT gift_summary_json FROM registry_settings
  WHERE wedding_id = '<wedding id>'`, edit it by hand: delete the entry from
  `contributions.gifts`, subtract its `amountMinor` from its currency's
  `totals` entry and 1 from that entry's `count` (where it has one) and from
  `contributions.count`. Write it back with `UPDATE registry_settings SET
  gift_summary_json = '<edited JSON>' WHERE wedding_id = '<wedding id>'`.
  Leave `gift_summary_at` alone. Where two lines match the same wedding,
  amount and day, ask the guest for nothing more — remove one; they are the
  same fact.
- **RSVP change log and organiser read state (migration 0068).** A household's
  `rsvp_changes` rows (which guest changed which reply, and when — no content)
  are part of that household's data: an access request returns them, and
  deleting the `families` row cascades them. That includes the
  `host_status_set` rows an organiser's status-only save writes under the
  household; an access answer returns them without `actor_osn_profile_id`
  (see the organiser attribution entry below). An organiser's
  `host_rsvp_notices` rows (their read marker and digest switch, per wedding)
  are part of the organiser's cire data; removing their seat deletes the row,
  and so does an OSN account deletion, with a row that outlived its seat
  ([[#Cire (wedding-invite) data]]). See [[cire-rsvp-changes]].
- **Organiser attribution on RSVPs (migrations 0080, 0084).** `rsvps.recorded_by_osn_profile_id`
  and `rsvps.dietary_attested_by_osn_profile_id` name the co-host who last
  wrote a guest's reply and who attested its dietary consent, and
  `rsvp_changes.actor_osn_profile_id` names the co-host on each status-only
  save's change-log row. An access request from the household leaves all
  three out, as it leaves out
  `note_hidden_by_osn_profile_id`: they identify a co-host (Art. 15(4)), and
  the household sees only that a host wrote. They are the organiser's data in
  an organiser's access request. Erasing the household deletes the rows; an
  OSN account deletion clears the ids, as an erasure request does (below).
  Removing a co-host's seat keeps the ids: they are
  the record of who changed a guest's reply and who attested its consent
  (Art. 5(2), 7(1)), held as long as the row they sit on — the reply, or the
  change-log row's 90 days — and swept with it. An erasure request from that
  organiser replaces them instead, in the same pass that removes the seat:
  `UPDATE rsvps SET recorded_by_osn_profile_id = 'deleted' WHERE recorded_by_osn_profile_id = ?`,
  the same for `dietary_attested_by_osn_profile_id`, and
  `UPDATE rsvp_changes SET actor_osn_profile_id = '' WHERE actor_osn_profile_id = ?`
  — never NULL, because a null writer or attester is what marks the
  household's own reply or consent, and a null actor its own change, which
  the organisers' feed and digest would then show. The consent record itself stays, as evidence an organiser attested;
  an emptied change-log row still says an organiser set the status, by its kind.
  An organiser's access request finds these by profile id, not by seat, so a
  co-host whose seat was removed is answered too:
  `SELECT wedding_id, kind, created_at FROM rsvp_changes WHERE actor_osn_profile_id = ?`,
  and `SELECT … FROM rsvps WHERE recorded_by_osn_profile_id = ? OR dietary_attested_by_osn_profile_id = ?`.
  The answer gives, per wedding, the time and kind of each save and which
  replies they last wrote or attested; guest, household and event ids or names
  go in only for a wedding where the requester still holds a seat, since
  outside it they are other people's data (Art. 15(4)).
- **Guest email addresses (migration `20261026144244_guest_emails`).** A guest's `guests.email` and its
  consent record (`email_source`, `email_consent_at`, `email_consent_version`,
  `email_attested_by_osn_profile_id`) are the guest's data, and their requests
  go to an owner like any guest's. Access: the six columns on their row
  (`email_hash` included); any `email_suppressions` row whose `email_hash`
  equals the SHA-256 of `wedding_id + ":" + address` (the list holds no
  address, so it is found only by hashing the requester's); and the copies in
  the wedding's change history — read the `Guest Email` column of each object
  its `imports` rows name in `cire-sheets` (uploads, editor drafts, previews,
  before-images). The attester's profile id identifies a co-host:
  an access answer says the hosts added the address, not which host
  (Art. 15(4)). Rectification (Art. 16): the guest replaces the address on
  the invite; an address the hosts added that it replaces is recorded as the
  seat's opt-out (`reason = 'guest_corrected'`), so a later sheet or revert
  does not put it back unseen. Erasure: the guest removes the address on the
  invite at once, which also records their opt-out — for the wedding when the
  hosts added it, for their own seat alone when they gave it themselves
  (`reason = 'guest_removed_own'`); an owner or editor removes
  it in the guest editor; deleting the guest deletes the row. A guest asking never to be
  emailed again keeps their suppression row, which is the record of that
  objection (Art. 21(3)); deleting it as well is erasure of the objection, and
  an operator does it by hand on request. The same hand delete — by
  `(wedding_id, email_hash, guest_id)` — clears an opt-out another household
  made against someone's address the hosts had put on its seat, when the person whose address it is asks. An erasure request from the
  attesting **organiser** replaces their id in the same pass that removes their
  seat: `UPDATE guests SET email_attested_by_osn_profile_id = 'deleted' WHERE email_attested_by_osn_profile_id = ?`
  (never NULL, which would read as the guest's own consent);
  the address and the rest of its record stay, as evidence an organiser
  attested. A revert never writes the id back: a restored record names its
  attester only while they hold a seat on the wedding.
- **Unlock-code redemptions.** `unlock_code_redemptions.redeemed_by_osn_profile_id`
  names the owner who redeemed a code for a wedding. It is the organiser's data
  in an organiser's access request. An erasure request from that organiser nulls
  it, in the same pass that removes their seat:
  `UPDATE unlock_code_redemptions SET redeemed_by_osn_profile_id = NULL WHERE redeemed_by_osn_profile_id = ?`.
  The row stays, so the code's use and the wedding's tier keep their record; it
  goes with the wedding when the purge deletes it ([[retention]]).
- **Checklist assignments (migration 0091).** Each `task_assignees` row names
  a `wedding_hosts` seat holding a task and when it was put on it, so which
  tasks an organiser holds is part of their cire data. An access request finds
  them through the requester's seats:
  `SELECT a.wedding_id, t.title, t.status, a.assigned_at FROM task_assignees a JOIN wedding_hosts h ON h.id = a.host_id AND h.wedding_id = a.wedding_id JOIN tasks t ON t.id = a.task_id WHERE h.osn_profile_id = ?`.
  The other seats on the same tasks are their co-holders, other people's data
  (Art. 15(4)), so the export leaves them out. Removing the seat — an erasure,
  an owner removing them, or their own leave — deletes every one of its rows
  through the foreign key (ON DELETE CASCADE) and keeps the tasks, which are the
  wedding's planning record, with their other holders, so no separate step is
  needed. An OSN account deletion removes the seat, so its assignments go
  with it. Until the first
  cire-api release after the one shipping 0091 reaches production drops it
  (englishstreetventures/osn#1636), `tasks.assigned_host_id` (migration 0087)
  also holds, per task, the seat that held it when 0091 copied it onto
  `task_assignees`, read and written only by the Worker before 0091 if it
  serves again; an access request reads it too,
  `SELECT t.wedding_id, t.title FROM tasks t JOIN wedding_hosts h ON h.id = t.assigned_host_id WHERE h.osn_profile_id = ?`,
  and removing the seat clears it (ON DELETE SET NULL). See
  [[cire-checklist-tasks#Assignees]].

**OSN account deletion and cire — decision: refuse until the person acts**
(owner, 2026-11-16: "weddings shouldn't exist without owners"; "Refuse until
they act"). A wedding belongs to its owners together, so one owner's account
deletion takes only their seat while another owner remains. A wedding the
person alone owns is theirs to settle before they go: add another owner, delete
it, or answer `delete` (or "delete everything"); nothing of it, or of them,
outlives the account in cire. The organiser attribution ids
(`rsvps.recorded_by_osn_profile_id`, `rsvps.dietary_attested_by_osn_profile_id`,
`rsvp_changes.actor_osn_profile_id`, `guests.email_attested_by_osn_profile_id`
and the rest) are cleared by the erasure as an organiser's erasure request
clears them; the replies and consent records they sat on stay, as evidence an
organiser attested ([[dpia/cire-guest-data]]).

**Refusals permitted** under Art. 17(3):

- Legal-obligation retention (e.g. Pulse ticketing receipts under tax law — once paid Pulse ticketing lands).
- Establishment / exercise / defence of legal claims (open dispute, abuse-report under investigation).
- Public-interest archiving (N/A here).

Document refusals in the response with the specific exemption.

### Art. 18 — Restriction of processing

Sets `accounts.processing_restricted_at`. The column exists and `findAccountById` reads it, but **nothing writes it and no route enforces it yet** — an operator sets it by hand in the DB, and the intended effect (account cannot post events, send messages, accept connections, while data is preserved) is not enforced in code. Used pending dispute.

### Art. 20 — Portability

Same `GET /account/export` JSON bundle. Format is machine-readable + commonly used. Per Art. 20(2), where technically feasible, we will offer direct transmission to another controller — defer this until requested in practice; not mandatory under "technically feasible" if no industry-standard receiver exists.

### Art. 21 — Right to object

Today: no marketing email, no LI-based processing of individuals beyond
fraud detection and security. Objection to fraud detection / security =
account suspension (we cannot serve the user without those). Document.

If a marketing channel ever lands (e.g. event-host newsletter from
Pulse), this becomes operational: object → flag account → exclude from
future sends.

## Refusals

When refusing in whole or part, the response must:

- Identify the request and the refused part.
- State the exemption with the article reference.
- Inform of right to complain to the supervisory authority (list relevant DPA with contact link).
- Inform of right to a judicial remedy.
- Be sent within the same 30 / 45 day deadline as a positive response.

Refusals get logged in `dsar_requests` with `decision: refused` + `exemption: <article>`.

## Verification thresholds for "manifestly unfounded or excessive"

Per GDPR Art. 12(5), we may charge a reasonable fee or refuse if a request is manifestly unfounded or excessive. In practice:

- Repeated identical request <30 d after the prior — refuse OR charge.
- Request that requires disproportionate effort relative to benefit — limited grounds; document carefully.
- Request submitted to harass (threats, automation) — refuse.

Default position: do the work. Refusals are exceptional and have to survive a DPA challenge.

## Escalation

| Trigger | Action |
|---|---|
| Request from a minor's parent | Treat as legitimate; verify per COPPA process. |
| Request invokes "right to be forgotten" against indexed search engines | Out of scope (we are not the search engine); inform requester. |
| Request claims breach has occurred | Treat as breach notification; trigger [[breach-response]]. |
| Authority subpoena vs DSAR | Different flow; route to legal counsel. |

## Project changes required

Tracked with `C-` IDs, all rolled up under  (DSAR runbook):

1. `dsar_requests` table for audit log.
2. `dsar@osn.example` email alias + automated acknowledgement.
3. Postal address published on `@musubi/landing` legal page.
4. Internal triage doc with the team rotation.
5. SLA monitoring (alert when a request is >25 d unresponded).
6. **Cire DSAR export** — built: the `cire.weddings` section of
   `GET /account/export` and the owner's whole-wedding archive
   ([[#Cire (wedding-invite) data]]). The organiser attribution records listed
   there are still answered by hand (englishstreetventures/osn#2330).
