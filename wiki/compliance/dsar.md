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
  - "[[account-deletion]]"
last-reviewed: 2026-11-27
---

# DSAR Runbook

How OSN handles a **Data Subject Access Request** (GDPR Arts. 15, 16, 17,
18, 20, 21) or a **Verifiable Consumer Request** (CCPA / state laws). One
runbook, two regimes, because the operational steps overlap.

## Endpoints and entry points

| Channel | Who uses it | Where it lands | SLA |
|---|---|---|---|
| `GET /account/export` | The account holder, self-service: Musubi's Settings → Account → "Download my data", and the screen shown while a deletion is pending | `@osn/api` — streams NDJSON | Immediate |
| `POST /account/data-link` | The account holder: Musubi's "Send me a link" | `@osn/api` — mails the account's own address a link to the download page, never the data ([[account-deletion#Emails]]) | Immediate |
| `DELETE /account` | The account holder, self-service: Musubi's Settings → Account → Danger zone ([[account-deletion#The person's side]]) | `@osn/api` — soft delete, then hard delete in 7 d | 7 d |
| `DELETE /account` (pulse-api, Flow B) | Leave Pulse without losing OSN | `@pulse/api` — soft delete + hosted-event 14-day cancellation window, after a passkey step-up (`pulse_app_delete`; a passkey added by an emailed link, an authenticator code or recovery counts once it is 72 hours old, [[account-deletion#Leaving one app takes a passkey]]) | 7 d (account) / 14 d (events) |
| `DELETE /api/organiser/account` (cire-api, Flow B) | A host removes their Cire data without losing OSN: "Remove my Cire data" in the portal's account menu | `@cire/api` — the account erasure's `host` scope, after a passkey step-up confirmed on Musubi, with the same 72-hour hold ([[cire-auth#A host removes their Cire data]]). Then refused, 409 `holds_payout_account`, while a profile of the account holds the Stripe account a live wedding's money gifts are paid into, as an owner beside another owner ([[#Art. 17 — Right of erasure]]) | Immediate once confirmed, unless refused for a payout account; the person clears that refusal themselves |
| `privacy@englishstventures.com`, named on every privacy notice (`LEGAL_ENTITY.privacyEmail`) | Anyone via email | The operator's privacy inbox, hosted by Hostinger ([[subprocessors]]) | 30 d (GDPR) / 45 d (CCPA) |
| Authorised agent | Third party with notarised authority | Same email + verification | Same; verification adds days, log it |
| Post | No one is pointed to it: the legal pages publish no postal address, by the owner's decision. A letter that arrives anyway is still a request | Whoever opens it forwards it to the privacy inbox, where it is handled as an email request | 30 d (GDPR) / 45 d (CCPA), from the day the letter arrived |

## Step-by-step for a written request

1. **Acknowledge within 72 hours** — automated reply confirming receipt and the response deadline.
2. **Identify the regime** — GDPR if EU/UK; CCPA + state laws if US-resident; treat unclear cases as both (apply the stricter rule).
3. **Verify identity** — for the account holder using the in-app endpoints, the bearer token + step-up token verifies them. For a request by email:
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
- `sessions[]` — `uaLabel`, `lastUsedAt`, `createdAt`. No session id and no IP hash: osn-api records no IP hash on a session. The one exception, a session the previous osn-api opens around a deploy, is in [[data-map]] (`sessions.ip_hash`).
- `security_events[]` — `kind`, `createdAt`, `acknowledgedAt`, `uaLabel`, `ipHash`. `ipHash` is an HMAC-SHA256 of the request's IP under the server pepper; it cannot be turned back into an address.
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
- `dsar_requests[]` — once the `dsar_requests` table ships.

**Wire format:**

- **NDJSON envelope** — one JSON object per line, prefixed by a header line `{"version":1,"sections":[...]}` and terminated by `{"end":true}`. This lets the response stream via `ReadableStream` without ever holding the full bundle in memory.
- **Per-section keyset pagination** — every multi-row section (`security_events`, `sessions`, `connections`, `pulse.rsvps`, `pulse.events_hosted`, `zap.chats`) is fetched in batches of `LIMIT 500` ordered by `id` with `WHERE id > :cursor`. No `OFFSET` (degrades on large tables).
- **ARC fan-out sub-bundles streamed** — `pulse.*`, `zap.*` and `cire.*` sections are fetched via ARC and re-serialised line-by-line into the outer NDJSON; the bridge call uses chunked transfer too.
- **Memory** — streamed: each osn section is read in keyset pages of 500 and each app's sub-bundle is piped through line by line, so the Worker never holds the whole bundle. There is no size cap and no truncation record.
- **Apps one after another** — osn-api asks each app in `DELETION_APPS` in turn, 10 s each ([`routes/account-export.ts`](../../osn/api/src/routes/account-export.ts)). An app that fails, or that the tier gives no address, becomes one `{"degraded":"pulse|zap|cire","reason":"..."}` line, so the person sees the gap and can ask again later.

Auth: bearer access token + step-up token. Rate-limit: 1 export per 24 h per account.

### Art. 16 — Rectification

Most fields are user-editable in `@musubi/social` (handle change, displayName, avatar, email change). For non-editable fields (security_events metadata, sessions ua_label) — these are observed facts, not user-supplied data; rectification right is narrower under GDPR Recital 65 ("inaccuracy" must be the data itself). Document the refusal under "Refusals" if challenged.

### Art. 17 — Right of erasure

Status: **shipped**. Two flows:

- **Flow A — full OSN account delete.** `DELETE /account` on osn-api, from Musubi's Settings. Soft-deletes the account at once; once the 7-day window has passed, the six-hourly cron calls every app over ARC with the person's answers, then hard-deletes the account ([[account-deletion]]).
- **Flow B — per-app delete.** The OSN account stays, and each app's removal takes a passkey step-up ([[account-deletion#Leaving one app takes a passkey]]). A host removes their Cire data with `DELETE /api/organiser/account` on cire-api, at once, unless they hold a wedding's payout account (below, and [[#Cire (wedding-invite) data]]); to leave Pulse, `DELETE /account` on pulse-api, whose hosted events are kept 14 days for their guests ([[account-deletion#Leaving one app]]).

How the flows work — the screens, the soft delete, the seven-day window and its limited session, the fan-out to every app, the hard delete, organisations, handle holds and emails — is in [[account-deletion]]. What a request needs from it:

- **What is erased.** At the hard delete: the account, its profiles, sessions, passkeys, recovery codes, TOTP, app enrolments, connections, blocks, organisation memberships, and OIDC consents and authorization codes; OIDC clients the account registered are disabled and unlinked; each organisation a profile owned passes to another member or is deleted ([[account-deletion#Organisations the person owns]]). In each app, what [[account-deletion#What each app does]] lists.
- **What is kept, and why.** `security_events` (12 months) and `email_changes` (90 days), with the account id they name, as security records (Art. 6(1)(c)+(f), [[data-map]]); handle holds, keyed hashes with no account id, for 30 days; and what each app reports keeping, which the `account-deleted` email repeats ([[account-deletion#What is kept after the deletion]]). The periods are in [[retention]].
- **When.** Seven days after the request, the fan-out reaches every app, and the hard delete follows once every app has finished. On a deployed tier that is 6 to 12 hours after the window ends (englishstreetventures/osn#2386), later while an app has not answered. So the person is shown the day the window ends on, never a clock time: the window screen and the scheduled email say the account is deleted "on or shortly after" that day, in the reader's own zone on the screen and in UTC, named, in the email ([[account-deletion#The end of the window]]). Musubi's privacy notice ([`PrivacyPage.tsx`](../../musubi/social/src/pages/PrivacyPage.tsx)) says "usually within a day of the date we show you".
- **Cancelling.** Until the window ends the person can keep the account: they sign in to Musubi by passkey or email and choose "Keep my account". osn-api refuses a keep from the moment the window ends (`hard_delete_at`), which can fall early in the day shown, so the screen and the email offer it before that day. Mailbox access alone is enough ([[account-deletion#What happens, in order]]).
- Backups: every production database is Cloudflare D1, whose Time Travel can restore it to any minute of the last 30 days on Workers Paid, the production account's plan, so erased rows stay restorable for up to 30 days ([[backup-dr]]). Musubi's privacy notice and Cire's host, guest and vendor notices say so.

  *Quoted 2026-11-19 from Cloudflare's [D1 Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/): "up to 30 days in the past (Workers Paid plan)".*
- Logs: the redacting logger keeps personal data out of log lines at write time ([[shared/observability/overview]]); Workers Logs and traces age out on Cloudflare's own retention ([[retention]]).

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
  ([[account-deletion#The app contract]]):
  - *Preview.* Each live wedding a profile of the account alone owns is an
    open action, `cire:wedding:<id>`, with one choice, `delete`, and no
    default, so `DELETE /account` answers 409 `open_actions` until the person
    answers it, chooses "delete everything", adds another owner (the action's
    link opens the wedding's download page in the host portal, which also
    offers to add another owner, and the action is then gone) or deletes the
    wedding. Each live wedding where a profile of the account holds, from an
    owner seat, the Stripe account its money gifts are paid into, beside
    another owner, is an action too, `cire:payout:<id>` (past 20, one
    `cire:payouts:rest`), whose one choice, `close`, is its default, so it
    never blocks: it tells the person that guests cannot give money there
    until another owner connects an account, and links the wedding's Money
    gifts so they can hand over first. Any other wedding with another owner
    is not an action.
  - *Soft delete.* Only the person's organiser sessions end. The weddings and
    seats are untouched, so a cancel loses nothing.
  - *Erasure.* First, on every call, the person's organiser sessions end.
    Then, per wedding the account has an owner seat in, one D1 batch:
    the seats the call's first read found there and those seats'
    `host_rsvp_notices` rows go (a seat added since goes in a later step), and the wedding is
    soft-deleted in that batch when no owner is left, whatever was answered,
    since the rules run on the rows as they stand, naming as its deleter the
    profile whose owner seat went. The purge takes a deleted wedding with no
    owner at once, money holds still applying ([[retention]]); its log names
    a wedding's deleter only while they hold a seat on it. A batch that took
    the seat of the profile holding a live wedding's payout account mails
    each remaining owner once, as it commits, that money gifts there need a
    new Stripe account (`registry-payout-holder-erased`): the wedding's name
    and a portal link, naming no one. Then, once per
    account:
    seats below owner, at most 200 a call (a call that leaves more answers not
    finished, and the next call goes on), and the notice rows left; guest
    account links (by the account or a
    profile); `registry_stripe_oauth_states`, `realtime_subscribe_budget` and
    the `actor:` rows of `owner_notice_budget`; an enquiry the person opened
    that never reached a chat; and every column that names a profile, cleared
    as the entries below say (`'deleted'` where the column cannot be NULL, or
    beside a time that stays or where NULL would say the guest or household
    wrote it), the deleter of every wedding the erasure deleted among them,
    once no seat of the profiles is left. A wedding the erasure deleted
    is hidden from every reader at once but stays in cire's database, with its
    guest data, until the daily purge takes it: at most three weddings a run,
    and none while an upgrade purchase or gift from the last 14 days is still
    pending, while any gift on it is disputed, however long that takes, or
    while a change to it is still writing (`purgeHeld`,
    `cire/api/src/services/maintenance-sweeps.ts`). So, just before it clears
    the deleters, the call that finishes counts the deleted weddings with no
    owner left whose deleter is one of the profiles and that `purgeHeld`
    holds, and answers them as one kept item, which the `account-deleted`
    email lists: "A deleted wedding you owned, kept until a payment or gift
    for it settles, then erased in Cire's daily clean-up." (or "<n> deleted
    weddings …"), with no date and no link. It names no wedding, since a
    wedding's name usually names the couple. Three limits: a repeat call
    after osn-api lost cire's done answer reports nothing kept, since the
    deleters are gone by then; a wedding someone else deleted and then left to
    the person alone names no profile of theirs, so it is not counted; nor is
    one an earlier "Remove my Cire data" deleted, which cleared its deleter
    then.
  - *A host removing their Cire data* and keeping the account
    ([[cire-auth#A host removes their Cire data]]): the same erasure, at once,
    for every profile of the account, after a passkey step-up the person
    confirms on Musubi (a passkey added by an emailed link, an authenticator
    code or recovery counts once it is 72 hours old,
    [[account-deletion#Leaving one app takes a passkey]]). After that
    confirmation it is refused, 409 `holds_payout_account`, while a profile of
    the account holds the Stripe account a live wedding's money gifts are paid
    into, as an owner beside another owner
    ([`organiser-account.ts`](../../cire/api/src/routes/organiser-account.ts));
    the screen marks such weddings from its first step, and the hosts'
    privacy notice states the refusal. Then it runs only once each wedding they alone own
    is answered `delete`.
    It runs with the `host` scope, which leaves their vendor listing claims and
    their guest account links as they are; everything else above goes, their
    organiser sessions included, and the other owners of each wedding they
    leave are emailed. Their organiser sessions end only once no seat of
    theirs is left, so a call that answers not finished leaves them signed
    in to call again. A wedding left with no owner is deleted at once and the
    purge takes it, later while a payment for it settles; the removal clears
    its deleter, counts nothing and answers no kept item, since the removal
    screen says this before the person confirms. They can sign in
    to cire again later and start with no weddings.
  - A host who cannot sign in to the organiser portal can still ask by email.
    An operator handles that request by hand, as an erasure request from an
    organiser, by the sole-owner rules of the removal above, which the hosts'
    privacy notice
    ([`hosts.astro`](../../cire/landing/src/pages/privacy/hosts.astro), "How
    long we keep it") promises: tell the person which live weddings they
    alone own and point them to each one's download; delete none of those
    until they have added another owner or agreed to its deletion in writing;
    then remove their seats and notice rows, soft-delete each wedding left
    with no owner, and clear every column that names one of their profiles as
    a host. The payout-account refusal is the portal's, and the notice states
    it for Remove my Cire data alone. A request by email from a person who
    holds a wedding's payout account is answered as the payout-account
    paragraph under [[#Art. 17 — Right of erasure]] says.
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
  to Stripe as that row says. Each money gift also records the account it
  was paid into (`registry_contributions.stripe_account_id`, migration
  `20261118180052`), so a refund or dispute on it still reaches the gift. An
  erasure leaves that column, as it leaves the account on the settings row:
  it is the couple's record of where each gift's money went, and it goes with
  the gift when the guest-data sweep deletes it ([[retention]]). A retired
  account's record (`registry_retired_accounts`, migration `20261119132712`)
  holds no profile id, so no access or erasure request reaches it; it goes
  with the wedding.
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
  production can hold these rows.
- **The gift record kept after the sweep.** When it deletes the guest data
  ([[retention]] says when), the sweep deletes the gift rows but keeps, on
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

**Not an Art. 17(3) refusal: a payout account the person holds.** "Remove my
Cire data" is refused, 409 `holds_payout_account`, while a profile of the
account holds the Stripe account a live wedding's money gifts are paid into, as
an owner beside another owner ([[account-deletion#Leaving one app]]). The owner
chose it, weighing that it holds up a request to erase, so that no couple's
money gifts are paid into the account of someone who has left. It is none of
the exemptions above, and the person can clear it: they hand money gifts to
another owner or disconnect the account in that wedding's Money gifts, or
another owner replaces the account ([[cire-registry#Retiring an account]]);
then the removal runs. It holds back the whole removal, not only the seat the
account is tied to. Deleting the Musubi account is never refused on it: that
erasure takes the seat, which closes the wedding's money gifts. A person who
asks by email to erase their Cire data alone while they hold such an account is
told these ways on. If the account is not handed on before the month to answer
ends (Art. 12(3)), everything of theirs in Cire is erased except the one owner
seat that holds the payout account, and the answer tells them how to clear that
seat (the owner's decision, 2026-11-27). No route does that yet: Remove my Cire
data refuses, the erasure's `host` scope keeps the seat but then stops before
the rest of the person's data, and the account erasure takes the seat. Until
englishstreetventures/osn#2576 lands, bring each such case to the owner before
the month ends.

### Art. 18 — Restriction of processing

Sets `accounts.processing_restricted_at`. The column exists and `findAccountById` reads it, but **nothing writes it and no route enforces it yet** — an operator sets it by hand in the DB, and the intended effect (account cannot post events, send messages, accept connections, while data is preserved) is not enforced in code. Used pending dispute.

The change-notice run skips a restricted account ([[change-notices#Who gets it]]), while Musubi's privacy notice and terms promise the email to every account holder. When you set the column, tell the person that change notices stop until the restriction is lifted.

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
| A request by email to erase Cire data from a person who holds a wedding's payout account, not handed on as the month ends | Erase everything of theirs in Cire but the held seat, and tell them how to clear it. No route does this until englishstreetventures/osn#2576 lands: until then, bring the case to the owner before the month ends ([[#Art. 17 — Right of erasure]]). |

## Project changes required

Not built yet:

1. `dsar_requests` table for audit log.
2. Automated acknowledgement of mail to `privacy@englishstventures.com`.
3. Postal address on the legal pages — not to be built: they publish no postal address, by the owner's decision.
4. Internal triage doc with the team rotation.
5. SLA monitoring (alert when a request is >25 d unresponded).
6. **Cire DSAR export** — built: the `cire.weddings` section of
   `GET /account/export` and the owner's whole-wedding archive
   ([[#Cire (wedding-invite) data]]). The organiser attribution records listed
   there are still answered by hand (englishstreetventures/osn#2330).
