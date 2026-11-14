# Account deletion: Musubi, and leaving one app (cire first) — design

Date: 2026-11-14 · Status: owner decisions 1 to 9 settled; calls marked *my call* await review · Issues: englishstreetventures/osn#519, #1332, #2226

## Goal

A person can delete their Musubi account from Settings. Before they do, they see what each connected app still holds that needs an answer, can take a copy of their data, and can settle each item or choose to delete everything. They can change their mind for seven days. The deletion reaches every product. Where app data outlives the account, an email says exactly what is kept, until when, how to get a copy and how to have it deleted sooner. A person can also remove their data from one app and keep the account; cire is the first app built this way after Pulse. The code, the wiki and the privacy notices must agree.

## Where things stand

Checked on `origin/main` `90cfe9315`.

Built:

- `DELETE /account`, `POST /account/restore` and `GET /account/deletion-status` (`osn/api/src/routes/account-erasure.ts`). The delete needs the typed handle and a step-up token with purpose `account_delete`.
- The service (`osn/api/src/services/account-erasure.ts`): a soft delete that sets `accounts.deleted_at`, replaces each profile's handle with `deleted_<id>`, clears display name and avatar, deletes passkeys, recovery codes and TOTP, deletes every session but the one that can cancel, closes app enrolments, and writes a `deletion_jobs` row due in seven days. After seven days the six-hourly cron calls enrolled apps at `/internal/account-deleted` over ARC, then hard-deletes.
- `GET /account/export`, with Pulse and Zap sections fetched over ARC.
- The client methods `deleteAccount`, `cancelAccountDeletion` and `getAccountDeletionStatus` (`osn/client/src/account.ts`).
- Pulse's receiver (`pulse/api/src/routes/internal.ts:126`) and its own "leave Pulse" route.

Missing or wrong:

| # | Gap | Where |
|---|---|---|
| a | No screen deletes an account. The Settings button is disabled. No screen shows or cancels a pending deletion. The terms say deletion is in Settings. | `musubi/social/src/pages/SettingsPage.tsx:173`, `TermsPage.tsx:73` |
| b | Cancelling does not undo the soft delete. The handle stays `deleted_<id>`; display name and avatar stay empty; passkeys, recovery codes and TOTP are gone; app enrolments stay closed, so a second delete skips Pulse. Only the device holding the cancel session can cancel at all. | `cancelErasure`, `account-erasure.ts:324`; `:233-235`, `:280-283` |
| c | The handle is free for anyone the moment the soft delete runs. The privacy notice promises a 30-day hold. | `PrivacyPage.tsx:131` |
| d | Hard delete fails on D1 for an account that owns an organisation, and the failure stops the sweep for every account behind it. | #519 |
| e | Two deletes at once answer 500; a repeat never answers `already_pending`. | #2226 |
| f | `app_enrollments.account_id` references `accounts.id`, and hard delete keeps those rows. Whether D1 refuses the `accounts` delete is not tested. | `osn/db/src/schema/index.ts:704` |
| g | Fan-out reaches no app on a deployed tier: osn-api sets neither `PULSE_API_URL` nor `ZAP_API_URL` and falls back to localhost. Zap has no receiver, and never enrols anyone, so it would not be called anyway. | `musubi/infra/tests/reads.test.ts:38,44`; `account-erasure.ts:72-77`, `:293`; `zap/api/src/routes/internal.ts` |
| h | Nothing tells cire. Seats, organiser sessions, guest account links and attribution ids stay. | `git grep account-deleted -- cire` finds nothing |
| i | No email says a deletion was scheduled, cancelled or finished. | `shared/email/src/templates/index.ts` |
| j | `security_events` (12 months) and `email_changes` (90 days) have stated retention periods and no sweep. | `wiki/compliance/retention.md:31-32` |
| k | No E2E flow deletes an account. | `tools/e2e` |
| l | Compliance pages contradict each other and the code; list in §7. | `wiki/compliance/` |
| m | Cire has no data export, and its retention sweep erases guest data only: the wedding, its events and the published invite stay for ever. | `cire/api/src/services/retention.ts:41-47` |

## Decisions (owner, 2026-11-14)

1. **Organisations the person owns.** The delete flow shows them and lets the person deal with each one. An organisation they leave alone passes to its longest-standing admin.
2. **A cire wedding whose only owner is erased, with no editor.** By default the seat is removed and the wedding is kept until its retention date. With an editor present, the longest-standing editor becomes owner and is emailed (multi-owner design, decision 12; #1332).
3. **The handle hold is built.** A deleted account's handles cannot be taken for 30 days.
4. **Leaving cire covers hosts, under the same rules as erasure.** Vendor listings are later work.
5. **Open actions.** Deleting an account shows what each connected app holds that needs an answer. The person settles each, or chooses to delete everything and accept the loss.
6. **A copy of the data** is offered before deletion, by download or by email.
7. **What outlives the account is app data only.** Identity is erased when the seven-day window ends. App data that other people rely on can stay until its own retention date.
8. **Leftover data can be requested, or deleted early.** The app keeps the person's email address beside the leftover data until that data is erased, and proves a request by sending a code to it.
9. **An exact email after deletion:** how to re-enable the account and until when, what is kept and until when, how to request it, how to have it deleted sooner.

The window stays seven days.

## Non-goals

- A leave action for Zap, or for cire vendors.
- The DSAR mailbox, the `dsar_requests` log, and the under-13 operator runbook.
- Erasing data held by Stripe as an independent controller; `retention.md:91` already states that limit.
- Telling other products that an organisation was deleted (cire `directory_vendors.owner_org_id`, Pulse venues). `deleteOrganisation` has the same gap today; it gets an issue.
- Changing the step-up factors.

## Anti-goals

- An erasure that fails for one account and blocks others.
- A deletion the person cannot fully undo inside the window.
- One person's erasure destroying data other people still use, where a successor exists.
- A notice, email or wiki page that promises what the code does not do.
- A tier where a deletion finishes without having reached every app.

## Approaches

**How apps take part.**

- *A, chosen: one ARC contract every app implements,* with two calls. `POST /internal/account-deletion-preview` lists open actions. `POST /internal/account-deleted` carries the person's answers, does the work, and reports what it kept. osn-api calls every app for every account, with no enrolment check. `deletion_jobs` gains `cire_done_at`. Cost: cire-api has no inbound ARC verifier today, and Zap needs a receiver.
- *B: a second endpoint on the shared-secret channel* that today revokes cire organiser sessions. Less code, but a long-lived bearer secret would guard a destructive call, and the hard delete would have no record that cire finished.
- *C: replace the per-app columns with one row per app* in a child table. Cleaner once a fourth app exists. Not now: it rewrites the sweep queries and their D1 tests for no change a person can see. Recorded as follow-up.

**How the undo works.**

- *A, chosen: keep sign-in credentials through the window, and keep a restore record.* The soft delete no longer deletes passkeys, recovery codes or TOTP. A tombstoned account that signs in gets a session that can do three things only: see the deletion status, download its data, and cancel. The job row stores each profile's handle, display name and avatar, and which app enrolments were open; cancel puts all of it back. Anyone who can still sign in can cancel, from any device. *(My call. It reverses today's delete-credentials-at-once rule; the account still cannot be used for anything else during the window.)*
- *B: keep today's cancel session as the only way back.* Rejected: a person who loses that one device cannot recover the account, and the email could give no instruction that always works.
- *C: stop redacting profiles at soft delete* and hide tombstoned profiles in every read. Rejected: every profile read in four products would need the filter.

## Design

### 1. OSN erasure, made correct (gaps b to f, j)

- **Restore record** on `deletion_jobs`: per profile, the handle, display name and avatar key; and the list of enrolments the soft delete closed. `cancelErasure` writes them back in its one batch. A job row with no record (made before this change) cancels as it does today.
- **Credentials stay** until hard delete. Sign-in on a tombstoned account issues the limited session described above; every other route refuses it. `POST /account/restore` accepts that session or today's cancel session.
- **`handle_holds`.** Columns: the normalised handle, or its keyed hash once the account is erased; the account id (cleared at hard delete); `release_at` (null while a job is pending; hard delete sets it 30 days ahead). Registration, new-profile creation and organisation-handle creation refuse a held handle with the same answer as a taken one. The existing cron deletes rows past `release_at`.
- **Owned organisations** are OSN's own open actions (§2). The person names a successor, chooses `delete`, or leaves it. At hard delete, in the same batch and before `users` rows go:
  1. a named successor who is still a member becomes owner;
  2. otherwise the longest-standing other admin;
  3. otherwise the longest-standing other member *(my call: the owner's answer covers admins only)*;
  4. otherwise, or where the person chose `delete`, the organisation and its memberships are deleted.
  A successor is emailed after the batch commits.
- **Sweep isolation.** One account's failure is caught, counted and logged; the pass goes on to the next.
- **`app_enrollments`.** A D1 test first shows what the foreign key does. Hard delete then removes the account's rows. *(My call: `retention.md:24` keeps them "indefinitely (audit)", which an erasure cannot honour; the page changes.)*
- **#2226** as its Done when states.
- **Retention sweeps** for `security_events` older than 12 months and `email_changes` older than 90 days, on the existing cron, in bounded batches.

### 2. Open actions and the app contract (decision 5; gap g)

- **Preview.** `GET /account/deletion-preview` on osn-api gathers OSN's own open actions (owned organisations) and calls each app's `POST /internal/account-deletion-preview` with `{accountId, profileIds}`. Each open action has: an id, the app, a kind, a plain label, the choices allowed, the default choice, what each choice does, the date any kept data is erased, and a link to where the person can deal with it in that app. An app that does not answer in time is shown as "could not check", and the delete is refused until it answers.
- **Delete.** `DELETE /account` carries one choice per open action, or `deleteEverything: true`. The server runs the preview again; an open action with no choice is refused with 409 `open_actions`. Choices are stored on the job. `deleteEverything` picks, for every action, the choice that erases the person's data soonest; it never overrides a successor rule that exists to keep other people's data (organisations still pass to a successor where one exists; a wedding with another owner or an editor still passes to them). *(My reading of "force delete of everything if you don't care about data loss": the loss accepted is the person's own.)*
- **Fan-out.** At the end of the window osn-api calls every app's `POST /internal/account-deleted` with `{accountId, profileIds, choices, email}`. Each app answers with what it kept: a list of `{what, erasedOn, requestUrl}`. osn-api stores that on the job for the final email. `deletion_jobs` gains `cire_done_at`; the "not enrolled" marker is no longer written, and a row made before this change is sent to every app.
- **Every tier is wired.** The Alchemy stacks set the Pulse, Zap and cire URLs for osn-api, and a stack test fails when one is missing. With no URL set (local runs without that app), the job records that app as skipped and logs it; a deployed tier never takes that path.
- **Pulse** implements preview (events the person hosts that have not ended; its existing 14-day cancellation rule is the default) and accepts choices.
- **Zap** gains both calls. It has no open actions. On deletion it removes the person's chat memberships, replaces their sender id on kept end-to-end messages with a deletion sentinel (`dsar.md:105`), wipes the body of plain-text messages they wrote *(my call: that text is their personal data and we can read it)*, and deletes a chat left with no members.

### 3. Cire: receiver, kept data, export (gaps h, m; #1332; decisions 2, 7, 8)

- **Inbound ARC verifier** on cire-api.
- **At soft delete:** osn-api calls cire's existing organiser-session revoke for each profile, best effort. No seat changes yet.
- **Preview.** One open action per wedding where a profile of the account is the only owner and no editor exists. Choices: *hand over* (link to the host portal's owner invite; not a stored choice, it removes the action), *keep until `<date>`* (default), *delete now*. Weddings with another owner or an editor are listed for information: who takes over.
- **`account-deleted`, per wedding the account has a seat in:**
  1. Only owner, editor exists: promote the longest-standing editor, email them.
  2. Remove the seat and its `host_rsvp_notices` row.
  3. No owner left, choice *keep*: the wedding stays live with no owner. A `retained_weddings` row records the wedding, the person's email address and the erase date: one year after the final dated event, or one year after the seat was removed where no event has a date *(my call)*. On that date the wedding goes through the existing soft-delete and purge path, so the invite and events go too, not guest data alone *(my call; closes gap m for ownerless weddings)*.
  4. No owner left, choice *delete now*: the wedding is soft-deleted and purged on the next pass, with the existing money holds.
  The rule that every wedding keeps an owner (`cire/db/src/schema.ts:157-160`, `LastOwner` in `hosts.ts`) gains this one exception; the phase plan lists every reader that assumes an owner and what each does without one.
- **Also, once per account:** delete organiser sessions, `guest_account_links`, `registry_stripe_oauth_states` and `realtime_subscribe_budget` rows; clear every attribution column that names one of the profile ids (`rsvps`, `guests`, `registry_claims`, `registry_contributions`, `registry_settings`, `unlock_code_redemptions`, `weddings`, `rsvp_changes`, `directory_vendors.claimed_by_profile_id`, and on other people's seats `wedding_hosts.added_by_osn_profile_id`). Nullable columns become null; `NOT NULL` ones (`vendor_enquiries.created_by`, `wedding_upgrade_purchases.created_by_osn_profile_id`, `wedding_hosts.added_by_osn_profile_id`) take a fixed sentinel, with no table rebuild. `platform_sales` holds no person and stays. A vendor listing itself stays.
- **Safe to repeat,** one D1 batch per wedding, bounded so one call stays inside Worker limits; a call that runs out of budget answers "not finished" and the sweep calls again.
- **Wedding export.** An owner can download a whole wedding (guests, households, RSVPs, events, seating, registry, budget, vendors) as one archive from the host portal; owner-only, as the multi-owner design's decision 8 says. `POST /internal/account-export` on cire-api adds a cire section to `GET /account/export`: the weddings the person owns, each with its export.
- **Requests for kept data.** A public page on the cire site: enter the email address, receive a code, see the weddings kept under it and each erase date; for each, download the export or delete it now. Delete now sends the wedding to the purge path at once. The `retained_weddings` row, with the email address, goes when the wedding does. Rate-limited, and it answers the same whether or not the address is known.

### 4. Musubi screens and emails (gaps a, i, k; decisions 5, 6, 9)

- **Settings → Account → Danger zone.** The button opens a flow:
  1. what is deleted, what is kept, the seven-day window;
  2. "Download my data", and "email me a link" *(my call: the email carries a sign-in link to the download, never the data)*;
  3. open actions grouped by app, each with its choices and a link into the app; one "Delete everything" switch;
  4. type the handle; step-up; done.
- **During the window.** Signing in shows one screen: the date, "Keep my account", and "Download my data".
- **Emails:**
  - *Scheduled:* the date; how to keep the account (sign in before the date); how to download the data; what will be kept after the date and until when.
  - *Cancelled.*
  - *Deleted,* sent just before the hard delete, best effort: the account is gone and cannot be re-enabled; each kept item with its erase date and its request link; how to have it deleted sooner; that the handle is held for 30 days.
  - *"You now own `<organisation>`".*
- **Connected apps.** Each app shows a "Remove my data from `<app>`" link to that app's own leave screen.
- **E2E flow:** register, create a cire wedding as sole owner, open the delete flow, see the open action, download the export, delete with *keep*, see the window screen, cancel, check handle, passkey and enrolments are back; delete again, advance the clock, run the sweep; check the account is gone, the handle is held, the wedding is ownerless with its retained row, and the deleted email lists it; request it by email code and delete it early.
- A `designer` builds the screens against the Musubi `DESIGN.md`.

### 5. Leaving cire (decision 4)

- **Route:** `DELETE /api/organiser/account` on cire-api: organiser session plus an OSN step-up token with a new purpose `cire_app_delete`, verified over ARC at `/internal/step-up/verify`. That call returns an account id; cire checks it against the session's profile with its profile-to-account lookup (`cire/api/src/app.ts:576`). It covers every profile of the account *(my call)*, takes the same per-wedding choices as §3, and runs the same handler at once, with no window.
- **Screen:** host portal, account menu → "Remove my Cire data": the same list and choices as the Musubi flow shows for cire, and the export download.
- **Emails:** to the other owners of each wedding, as seat removal sends today; and to the person, listing anything kept, as the deleted email does.

### 6. Tiers and operations

A dashboard panel and an alert on the age of the oldest unfinished job, per app, so a stuck fan-out is seen within a day. The seven-day window plus fan-out must finish inside one month of the request.

### 7. Documentation and notices (gap l)

Each phase fixes the pages it makes stale. The last phase fixes what is left:

- `wiki/compliance/index.md:41`, `gdpr.md:33,40,63`, `scope-matrix.md:92`, `retention.md:119`: say built.
- `dsar.md:97,102,105,109,115,353-381,445-455`, `retention.md:23-25,62,153`, `data-map.md:43,276-287`, `dpia/cire-guest-data.md:473,538`: fan-out timing, credentials and the limited session, the handle hold, the app contract, cire's kept weddings and the email address kept beside them, the request page.
- Notices: Musubi (`PrivacyPage.tsx`, `TermsPage.tsx`) gains the seven-day window, the hold, and that app data can outlive the account; cire hosts (`hosts.astro`) gains what account deletion and leaving do to a wedding, that an ownerless wedding is kept until its date with the former owner's email address, and how to request or delete it. Notice wording is the owner's to approve; those pull requests open as drafts.
- New page `wiki/osn/account-deletion.md`: the one description of the flow and the app contract, linked from each product's page.

## Phases

One branch and one pull request each, merged in this order, in two runs (1 to 4, then 5 to 8). Phases 1, 2 and 3 all change `account-erasure.ts` and `deletion_jobs`.

| # | Phase | Covers | Agent |
|---|---|---|---|
| 1 | OSN erasure correctness | §1; #519, #2226 | implementer, full tier |
| 2 | App contract, wiring, Pulse and Zap | §2, §6 | implementer, full tier |
| 3 | Cire receiver and kept weddings | §3 up to "Safe to repeat"; #1332 | implementer, full tier |
| 4 | Cire wedding export and request page | §3 export and requests | implementer for routes, designer for screens |
| 5 | Musubi screens and emails | §4 | designer |
| 6 | Leaving cire | §5 | implementer for the route, designer for the screen |
| 7 | Documentation and notices | §7 | implementer; draft for the owner |

Each phase plan takes the open private tracker items on its path as constraints, by bare reference.

## Left to the builder

Column and route names beyond those given; the keyed-hash construction for a held handle; the sentinel value; the export archive's format; batch sizes; metric names; email wording (the owner approves notices, not emails); the order of statements inside each batch, subject to D1's foreign keys.
