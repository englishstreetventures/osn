# Household member identity in cire — design

Date: 2026-10-01 · Status: approved by the owner 2026-10-01

## Goal

A claim code proves a household, not a person. Today cire cannot tell which member of a household is at the keyboard: replies carry no author, and the musubi link box asks "Which guest are you?" without showing which musubi account it will bind. On a shared browser that lets one person link a seat to someone else's account without seeing whose it is.

This design adds a "Who are you?" step after the claim, makes the musubi link and every reply hang off that choice, and shows the signed-in musubi account (username and picture) with a "Not you?" control before anything is linked.

## Decisions (owner)

1. **Choose who you are after the claim.** Once a household has claimed, the guest control box asks each person to pick themselves from the household's members.
2. **The musubi link binds to that person.** No separate seat picker inside the link box.
3. **Replies record who sent them.** Every reply stores which household member submitted it.
4. **Returning guests see their account.** When the chosen member is linked and the browser is signed in to that musubi account, the box shows the musubi username and profile picture with "Not you?".
5. **Linking lets the guest choose the musubi account.** The sign-in leg never re-grants silently; musubi shows a screen where the guest confirms or changes the account.
6. **Flag first, then every multi-member household.** The member step ships behind `cire.account-linking`. Once attribution has run a few weeks, it reaches every household of two or more members, with or without musubi linking.
7. **"Not you?" ends both sign-ins.** The guest box and the host portal share one cire musubi sign-in on a browser, so "Not you?" ends the organiser's portal sign-in too. The organiser signs in again with a passkey.
8. **No new dietary step.** When one member enters dietary needs for another, cire asks nothing more. It records who ticked the consent box, and the DPIA says a household member relays that consent. Revisit if an organiser or guest asks.
9. **The household sees who answered.** The invite shows "Answered by {first name}" under each reply.
10. **Organisers see replies sent through a linked account.** A small mark beside "Answered by" in the portal, with no handle or account detail.

## Non-goals

- Proving identity inside a household. The member choice is the guest's word, backed only by the household's claim code. A musubi link makes it stronger, never certain.
- Per-member claim codes or per-member sessions minted by the organiser.
- Multiple musubi accounts signed in at once in one browser. Musubi holds one session per browser; "choosing an account" means confirming that one or signing in as another.
- Showing a linked member's musubi identity to anyone not signed in as them.
- Pulse-side use of the link (the feed), and any change to organiser sign-in.

## Data model

One migration, `0071_household_member_identity.sql`. All columns nullable, so existing rows need no back-fill.

| Table | Column | Shape | Meaning |
|---|---|---|---|
| `sessions` | `member_guest_id` | `text`, FK `guests.id` `ON DELETE SET NULL` | Who this browser's household session says it is. Null until chosen, and again after "Not you?". |
| `rsvps` | `submitted_by_guest_id` | `text`, FK `guests.id` `ON DELETE SET NULL` | The member whose session wrote this row last. Null for organiser-recorded rows and rows written before the migration. |
| `rsvps` | `submitted_via_link` | `integer` boolean, default `0` | True when the request also carried a musubi sign-in that matches the member's link. Lets the portal tell "picked from a list" from "signed in as". |
| `rsvp_changes` | `actor_guest_id` | `text`, no FK (same rule as `guest_id`) | The member who made the change. Ids only, as the table holds today. |

Notes:

- `SET NULL`, not cascade: removing one member must not delete replies they sent for others.
- A plus-one cannot be a session's member. Their row was typed in by another guest and they never hold the code (the same reason `POST /api/account/link` refuses a plus-one seat today).
- `guest_account_links` is unchanged. Its unique rules (one link per guest, one account per household) still hold.
- No musubi profile data is stored. Username, display name and picture come from the `organiser_sessions` row this browser already holds (`handle`, `display_name`, `avatar_url`, taken at sign-in).

## Flows

### 1. Claim, then "Who are you?"

1. Household claims as today (`POST /api/claim`).
2. If the household has two or more non-plus-one members and the session has no member, the control box shows "Who are you?" with one button per member. A one-member household is chosen for them by the server on claim.
3. The guest taps their name; the site sends `POST /api/claim/member { guestId }`. The server checks the guest belongs to the session's household and is not a plus-one, then sets `sessions.member_guest_id`.
4. The box now reads "Answering as {first name} · Not you?". The RSVP form, plus-one prompt and registry stay as they are; only the author changes.
5. Until a member is chosen, the RSVP submit button stays disabled with a line pointing at the box. The server enforces the same rule.

### 2. Linking a musubi account

1. With a member chosen and the link box enabled, the box offers "Link your musubi account".
2. If this browser has no cire musubi sign-in, the button starts sign-in with `prompt=select_account` (see "Account choice" below). On return, the restore reports the signed-in account.
3. Signed in, the box shows the account's picture, display name and `@handle`: "Link {first name} to @handle? · Not you?".
4. "Link" sends `POST /api/account/link` with no body. The server links the session's member. The `guestId` body field goes away.

### 3. Return visit

On restore (`GET /api/claim/session`) the server compares the session's member with this browser's musubi sign-in:

| Member linked? | musubi signed in? | Account matches link? | Box shows |
|---|---|---|---|
| no | — | — | "Answering as {name} · Not you?" and the link offer |
| yes | yes | yes | Picture, display name, `@handle`, "Not you?" |
| yes | yes | no | "{name} is linked to a different musubi account · Not you?" — no handle or picture of either account |
| yes | no | — | "{name} · linked to musubi · Not you?" — no handle or picture |

"Matches" means the session's `osn_profile_id` equals the link's, or, failing that, resolves over ARC to the link's `osn_account_id` (the existing resolver; one call, only when the flag is on and the profile ids differ).

### 4. "Not you?"

One control, two effects, both fire-and-forget:

1. `DELETE /api/claim/member` clears `sessions.member_guest_id`. The household stays claimed; the box returns to "Who are you?".
2. If this browser holds a cire musubi sign-in, `POST /api/auth/signout` ends it.

The next link always goes through musubi's account screen (flow 5), so the previous person cannot come back silently.

### 5. Account choice at musubi

What osn's `/authorize` supports today (`osn/api/src/services/auth/oidc.ts`):

- `prompt=select_account` forces a screen even when consent exists and the client is first-party. The screen (`musubi/social/src/pages/AuthorizePage.tsx`) is a **profile** picker for the one account signed in on that browser; it leads only when the account has two or more profiles.
- `prompt=login` forces a fresh sign-in; the browser's passkey sheet lists every account with a passkey on the device.
- No prompt and an existing consent returns a code with no screen at all. This is the silent re-grant the shared-browser risk relies on.

So "choose which signed-in musubi account to use" needs three small changes:

1. cire's start leg (`cire/api/src/routes/auth-oidc.ts`) allows `select_account` beside `create`. `none` and `login` stay off the allowlist; `login` is not needed because flow 5's screen offers it.
2. `@shared/rp-auth` `startSignIn` widens its `prompt` type to `"create" | "select_account"`.
3. musubi's authorize page, on `reason=select_account`, always shows the signed-in account (picture, display name, handle, its profiles if more than one) with **Continue** and **Use another account**. "Use another account" runs the existing in-page sign-in; `afterSignIn` already drops any held answer when the account changes.

Every link from the guest box sends `select_account`. Organiser sign-in is unchanged.

## API changes

| Route | Change |
|---|---|
| `POST /api/claim`, `GET /api/claim/session` | Payload gains `member: { guestId } \| null` and `members: { guestId, firstName, linked }[]` (non-plus-one only). `accountLink` gains `account?: { displayName, handle, avatarUrl, matchesMember }` — present only when signed in **and** the member is unlinked or the account matches the link. Never an account id. |
| Claim and restore `rsvps[]` | Each reply gains `submittedBy: { guestId, firstName } \| null`, for "Answered by" on the invite. |
| `POST /api/claim/member` | New. `sessionAuth`. Body `{ guestId }`. 204, or 403 `not_household_member` / 403 `plus_one_seat`. Shares the restore's limiter and `originGuard`. |
| `DELETE /api/claim/member` | New. `sessionAuth`. Always 204, idempotent. |
| `POST /api/rsvp` | Stamps `submitted_by_guest_id` from the session and `submitted_via_link` from the match check. 409 `member_required` when the household has two or more members and none is chosen. Body unchanged. |
| `PUT` / `DELETE /api/plus-one` | Writes `actor_guest_id` on its `rsvp_changes` row. |
| `POST /api/account/link` | Body removed; links the session's member. 409 `member_required` with none chosen. Session rotation on link stays. |
| `DELETE /api/account/link/:guestId` | Unchanged. |
| `GET /api/auth/oidc/start` | `prompt` allowlist: `create`, `select_account`. |
| Organiser RSVP reads | Each reply carries `submittedBy: { guestId, firstName, viaLink } \| null`. |

## The shared-browser risk, and how this closes it

The risk: on a shared browser, a guest could bind their seat to an OSN account they did not see. Two ways in:

- **An organiser's host-portal sign-in on the same browser.** The guest box reported only "signed in", so a guest linked to the organiser's account unaware.
  *Closed:* the box now shows that account's picture and `@handle` before "Link", and "Not you?" ends that sign-in.
- **musubi's silent re-grant.** With consent on file, `/authorize` returned a code with no screen, so "Sign in with musubi" could come back as the previous person.
  *Closed:* every guest-box link sends `prompt=select_account`, which always shows musubi's account screen with "Use another account".

The member step adds a third guard: a link binds to the member this browser chose, and the box names both the person and the account side by side.

What stays open: anyone holding the household code can still pick any member's name. That is the household trust model the claim code has always had, and the DPIA already accepts it.

## Privacy

New personal data and new disclosures:

- **Who sent each reply** (`rsvps.submitted_by_guest_id`, `rsvp_changes.actor_guest_id`, `sessions.member_guest_id`). A household member's name tied to an action. Basis Art. 6(1)(f), wedding administration, as for `rsvps.status`. Seen by the household and the wedding's organisers (every co-host role, as RSVP rows are today). Kept as long as the row it sits on: sessions 30 days, `rsvp_changes` 90 days, `rsvps` until the 1-year guest-data sweep.
- **musubi picture, display name and handle shown on the invite.** Public musubi profile fields, already held in `organiser_sessions`. Shown only to the browser that holds both the household cookie and that musubi sign-in, and never for a linked member unless the sign-in matches. Not stored anew. The picture loads from musubi's own avatar host; the guest site's CSP `img-src` must allow it.
- **Art. 9 dietary.** A household member often answers for others, and the consent tick is asked once per submission. Today the record says "a guest consented"; after this change it also says which member ticked the box for whom. That makes visible a gap that already exists: one adult relaying another adult's health or religious data. No change to the consent gate (decision 8); the DPIA records that a household member relays consent. The submitter column holds an id, never dietary content.
- **Erasure.** Deleting a member nulls their attribution on others' rows (`SET NULL`); the household and wedding cascades are unchanged.

Wiki updates in the build pull request:

- `wiki/compliance/data-map.md`: rows for the three new columns; the `guest_account_links` row notes the member binding; a note on the avatar display.
- `wiki/compliance/dpia/cire-guest-data.md`: §1 gains "member attribution"; §3 gains "a member's reply attributed to the wrong person on a shared device" (Low / Low, mitigated by "Not you?" and the household trust model) and the relayed-consent note above.
- `wiki/compliance/retention.md`: no new store; note the columns ride existing windows.
- `wiki/cire/cire-auth.md`: guest account linking section rewritten for the member step, `select_account` and the new routes.

## Observability

Per `wiki/shared/observability/overview.md`:

- `cire.household_member.chosen` counter, attribute `source` (`picked`, `auto_single`).
- `cire.household_member.cleared` counter (the "Not you?" tap).
- `cire.account_link.match` counter on restore, attribute `result` (`match`, `mismatch`, `signed_out`, `unlinked`).
- `cire.rsvp.member_required` counter for refused submits.
- Spans on the new routes. No guest, family, profile or account id in any attribute or log line.

## Testing

- **DB tier (`tests/db/`)**: migration applies; `SET NULL` on member delete for `sessions` and `rsvps`; household cascade still clears everything.
- **API**: member choose — own member, other household's guest (403), plus-one (403), no session (401); clear is idempotent; RSVP stamps submitter, refuses with no member in a two-person household, auto-chooses for one; link uses the session member, refuses with none; restore payload for all four rows of the return-visit table; `accountLink.account` absent on a mismatch; start leg passes `select_account` and drops `none` and `login`.
- **osn / musubi**: `/authorize` with `select_account`, one profile, existing consent shows the screen; "Use another account" switches account and clears any held answer.
- **Guest site (component)**: "Who are you?" renders for multi-member households only; "Answered by" shows under each reply; submit disabled until chosen; link box shows picture and handle; "Not you?" calls both routes and returns to the picker.
- **Browser tier**: shared-browser path end to end — organiser signed in to the portal, guest claims on the same browser, box shows the organiser's handle, "Not you?" signs it out, re-link reaches musubi's account screen.
- **Portal**: RSVP table shows "Answered by {name}", with a mark when sent via a linked account.

## Rollout

Behind `cire.account-linking` (default off). With the flag off, nothing changes: no member step, no new payload fields, `POST /api/rsvp` does not require a member. The migration ships unflagged since every column is nullable.

1. Migration, API routes and payload, guest-site member step, "Answered by" and link box, wiki and compliance pages. One pull request.
2. musubi authorize screen: always show the account on `select_account`, "Use another account". One pull request in `osn/` and `musubi/`, with a changeset.
3. Organiser portal "Answered by". One pull request.
4. Turn the flag on for one test wedding, then widely.
5. After a few weeks of attribution, take the member step and "Answered by" out from behind the flag for every household of two or more. The musubi link box stays behind it. One pull request.
