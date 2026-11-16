# Account deletion: Musubi, and leaving one app (cire first) — design

Date: 2026-11-14 · Status: approved by the owner 2026-11-14; amended by the owner 2026-11-16 (a wedding never exists without an owner: decision 2, §3, §5) · Issues: englishstreetventures/osn#519, #1332, #2226, #2305

## Goal

A person can delete their Musubi account from Settings. Before they do, they see what each connected app still holds that needs an answer, can take a copy of their data, and can settle each item or choose to delete everything. They can change their mind for seven days. The deletion reaches every product. Where app data outlives the account, an email says exactly what is kept and until when. A person can also remove their data from one app and keep the account; cire is the first app built this way after Pulse. The code, the wiki and the privacy notices must agree.

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

1. **Organisations the person owns.** The delete flow shows them and lets the person deal with each one. An organisation they leave alone passes to its longest-standing admin. Where no other admin exists, it passes to a member or is deleted only after the person confirms that in the flow.
2. **A cire wedding the person alone owns** (owner, 2026-11-16: "weddings shouldn't exist without owners"; "Refuse until they act"). A wedding never passes to an editor and never exists without an owner. The account cannot be deleted while the person is the only owner of a live wedding: they add another owner, or delete the wedding, first; "delete everything" deletes it. A wedding they come to own alone before the hard delete is deleted then. Cire keeps nothing about the person afterwards. This replaces decision 12 of the multi-owner design and the promotion #1332 describes.
3. **The handle hold is built.** A deleted account's handles cannot be taken for 30 days.
4. **Leaving cire covers hosts, under the same rules as erasure.** Vendor listings are later work.
5. **Open actions.** Deleting an account shows what each connected app holds that needs an answer. The person settles each, or chooses to delete everything and accept the loss.
6. **A copy of the data** is offered before deletion, by download or by email.
7. **What outlives the account is app data only.** Identity is erased when the seven-day window ends. App data that other people rely on can stay until its own retention date.
8. **No app keeps the person's email address** (owner, 2026-11-16): cire keeps nothing about the person, so no app needs to prove a later request, and none is sent the address.
9. **An exact email after deletion:** how to re-enable the account and until when, and what each app keeps and until when.
10. **Credentials last the seven days.** Passkeys, recovery codes and TOTP stay until the hard delete, so the person can sign in from any device to keep the account.
11. **Settled as proposed:** "delete everything" erases the person's own data soonest and never overrides a successor; Zap plain-text messages the person wrote are wiped; "email me my data" sends a sign-in link, never the data; leaving cire covers every profile of the account; `app_enrollments` rows go with the account.

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

- *A, chosen: keep sign-in credentials through the window, and keep a restore record.* The soft delete no longer deletes passkeys, recovery codes or TOTP. A tombstoned account that signs in gets a session that can do three things only: see the deletion status, download its data, and cancel. The job row stores each profile's handle, display name and avatar, and which app enrolments were open; cancel puts all of it back. Anyone who can still sign in can cancel, from any device. It reverses today's delete-credentials-at-once rule; the account still cannot be used for anything else during the window.
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
  3. otherwise the longest-standing other member;
  4. otherwise, or where the person chose `delete`, the organisation and its memberships are deleted.
  An organisation with another admin has rule 2 as its default and needs no answer. One with no other admin is an open action with no default: the flow shows what rule 3 or 4 would do and the person must confirm it, name someone else, or choose `delete`.
  A successor is emailed after the batch commits.
- **Sweep isolation.** One account's failure is caught, counted and logged; the pass goes on to the next.
- **`app_enrollments`.** A D1 test first shows what the foreign key does. Hard delete then removes the account's rows. `retention.md:24` keeps them "indefinitely (audit)" today; the page changes.
- **#2226** as its Done when states.
- **Retention sweeps** for `security_events` older than 12 months and `email_changes` older than 90 days, on the existing cron, in bounded batches.

### 2. Open actions and the app contract (decision 5; gap g)

- **Preview.** `GET /account/deletion-preview` on osn-api gathers OSN's own open actions (owned organisations) and calls each app's `POST /internal/account-deletion-preview` with `{accountId, profileIds}`. Each open action has: an id, the app, a kind, a plain label, the choices allowed, the default choice, what each choice does, the date any kept data is erased, and a link to where the person can deal with it in that app. An app that does not answer in time is shown as "could not check", and the delete is refused until it answers.
- **Delete.** `DELETE /account` carries one choice per open action, or `deleteEverything: true`. The server runs the preview again; an open action with no choice is refused with 409 `open_actions`. Choices are stored on the job. `deleteEverything` picks, for every action, the choice that erases the person's data soonest; it never overrides a rule that exists to keep other people's data: an organisation still passes to a successor where one exists, and a wedding with another owner stays with that owner. The loss accepted is the person's own.
- **Fan-out.** At the end of the window osn-api calls every app's `POST /internal/account-deleted` with `{accountId, profileIds, choices, deleteEverything}`. Each app answers with what it kept: a list of `{what, erasedOn, requestUrl}`. osn-api stores that on the job for the final email. `deletion_jobs` gains `cire_done_at`; the "not enrolled" marker is no longer written, and a row made before this change is sent to every app.
- **Every tier is wired.** The Alchemy stacks set the Pulse, Zap and cire URLs for osn-api, and a stack test fails when one is missing. With no URL set (local runs without that app), the job records that app as skipped and logs it; a deployed tier never takes that path.
- **Pulse** implements preview (events the person hosts that have not ended; its existing 14-day cancellation rule is the default) and accepts choices.
- **Zap** gains both calls. It has no open actions. On deletion it removes the person's chat memberships, replaces their sender id on kept end-to-end messages with a deletion sentinel (`dsar.md:105`), wipes the body of plain-text messages they wrote, and deletes a chat left with no members.

### 3. Cire: receiver and export (gap h; replaces #1332; decision 2 as amended 2026-11-16)

- **Inbound ARC verifier** on cire-api.
- **At soft delete:** osn-api calls cire's existing organiser-session revoke for each profile, best effort. Nothing else changes in cire during the window, so a cancel restores everything.
- **Preview.** One open action per live wedding where the account is the only owner: one choice, *delete*, and no default, so the deletion is refused until the person answers it or chooses "delete everything". Its link opens the wedding's owners in the host portal: adding another owner there removes the action. The text says plainly: add another owner, or the wedding and its guest data are deleted with the account; download its exports first; a wedding they come to own alone before the date is deleted too. Weddings with another owner are not actions.
- **`account-deleted`, per wedding the account has an owner seat in,** one D1 batch: remove the seats and their `host_rsvp_notices` rows; if no owner is left, soft-delete the wedding in the same batch, whatever was answered (the rules run on the rows as they stand; an erasure always finishes). The purge takes a deleted wedding with no owner at once, with the existing money holds. No one is promoted.
- **Also, once per account:** remove seats below owner; delete organiser sessions, `guest_account_links`, `registry_stripe_oauth_states`, `realtime_subscribe_budget` and the person's `owner_notice_budget` rows; clear every attribution column that names one of the profile ids. Nullable columns become null; `NOT NULL` ones take a fixed sentinel, with no table rebuild. `platform_sales` holds no person and stays. A vendor listing itself stays. Cire answers `kept: []`.
- **Safe to repeat,** one D1 batch per owned wedding, bounded so one call stays inside Worker limits; a call that runs out of budget answers "not finished" and the sweep calls again.
- **Wedding export.** An owner can download a whole wedding (guests, households, RSVPs, events, seating, registry, budget, vendors) as one archive from the host portal; owner-only, as the multi-owner design's decision 8 says. `POST /internal/account-export` on cire-api adds a cire section to `GET /account/export`: the weddings the person owns, each with its export.

### 4. Musubi screens and emails (gaps a, i, k; decisions 5, 6, 9)

- **Settings → Account → Danger zone.** The button opens a flow:
  1. what is deleted, what is kept, the seven-day window;
  2. "Download my data", and "email me a link" (the email carries a sign-in link to the download, never the data);
  3. open actions grouped by app, each with its choices and a link into the app; one "Delete everything" switch;
  4. type the handle; step-up; done.
- **During the window.** Signing in shows one screen: the date, "Keep my account", and "Download my data".
- **Emails:**
  - *Scheduled:* the date; how to keep the account (sign in before the date); how to download the data; what will be kept after the date and until when.
  - *Cancelled.*
  - *Deleted,* sent just before the hard delete, best effort: the account is gone and cannot be re-enabled; each kept item with its erase date; that the handle is held for 30 days.
  - *"You now own `<organisation>`".*
- **Connected apps.** Each app shows a "Remove my data from `<app>`" link to that app's own leave screen.
- **E2E flow:** register, create a cire wedding as sole owner, open the delete flow, see the open action, download the export, answer *delete*, see the window screen, cancel, check handle, passkey and enrolments are back; delete again, advance the clock, run the sweep; check the account is gone, the handle is held and the wedding is deleted.
- A `designer` builds the screens against the Musubi `DESIGN.md`.

### 5. Leaving cire (decision 4)

- **Route:** `DELETE /api/organiser/account` on cire-api: organiser session plus an OSN step-up token with a new purpose `cire_app_delete`, verified over ARC at `/internal/step-up/verify`. That call returns an account id; cire checks it against the session's profile with its profile-to-account lookup (`cire/api/src/app.ts:576`). It covers every profile of the account, is refused on the same rule as §3 (owner, 2026-11-16) while the person alone owns a live wedding they have not answered *delete* for, and runs the same handler at once, with no window.
- **Screen:** host portal, account menu → "Remove my Cire data": the same list and choices as the Musubi flow shows for cire, and the export download.
- **Emails:** to the other owners of each wedding, as seat removal sends today.

### 6. Tiers and operations

A dashboard panel and an alert on the age of the oldest unfinished job, per app, so a stuck fan-out is seen within a day. The seven-day window plus fan-out must finish inside one month of the request.

### 7. Documentation and notices (gap l)

Each phase fixes the pages it makes stale. The last phase fixes what is left:

- `wiki/compliance/index.md:41`, `gdpr.md:33,40,63`, `scope-matrix.md:92`, `retention.md:119`: say built.
- `dsar.md:97,102,105,109,115,353-381,445-455`, `retention.md:23-25,62,153`, `data-map.md:43,276-287`, `dpia/cire-guest-data.md:473,538`: fan-out timing, credentials and the limited session, the handle hold, the app contract, cire's refusal while the person alone owns a wedding, and what the erasure deletes.
- Notices: Musubi (`PrivacyPage.tsx`, `TermsPage.tsx`) gains the seven-day window, the hold, and that app data can outlive the account; cire hosts (`hosts.astro`) gains what account deletion and leaving do to a wedding: refused while the person alone owns it, and deleted with them if they choose. Notice wording is the owner's to approve; those pull requests open as drafts.
- New page `wiki/osn/account-deletion.md`: the one description of the flow and the app contract, linked from each product's page.

## Phases

One branch and one pull request each, merged in this order, in two runs (1 to 4, then 5 to 8). Phases 1, 2 and 3 all change `account-erasure.ts` and `deletion_jobs`.

| # | Phase | Covers | Agent |
|---|---|---|---|
| 1 | OSN erasure correctness | §1; #519, #2226 | implementer, full tier |
| 2 | App contract, wiring, Pulse and Zap | §2, §6 | implementer, full tier |
| 3 | Cire receiver | §3 up to "Safe to repeat"; replaces #1332 | implementer, full tier |
| 4 | Cire wedding export | §3 wedding export, and the cire section of the account export | implementer for routes, designer for screens |
| 5 | Musubi screens and emails | §4 | designer |
| 6 | Leaving cire | §5 | implementer for the route, designer for the screen |
| 7 | Documentation and notices | §7 | implementer; draft for the owner |

Each phase plan takes the open private tracker items on its path as constraints, by bare reference.

## Left to the builder

Column and route names beyond those given; the keyed-hash construction for a held handle; the sentinel value; the export archive's format; batch sizes; metric names; email wording (the owner approves notices, not emails); the order of statements inside each batch, subject to D1's foreign keys.
