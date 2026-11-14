---
title: Emailed links
tags: [systems, auth, security, email]
related:
  - "[[passkey-primary]]"
  - "[[identity-model]]"
  - "[[auth-failure]]"
  - "[[coordination-store]]"
  - "[[email]]"
  - "[[component-library]]"
  - "[[account-recovery-factors]]"
  - "[[step-up]]"
  - "[[email-verification-api]]"
last-reviewed: 2026-11-13
---

# Emailed links

An emailed link proves that someone holds a mailbox. It never signs anyone in:
the link's page confirms the address, and the tab that began the flow gets
the result. Sign-up, account recovery, step-up and email change each use one;
no flow emails a code.

The shared challenge is [`email-link.ts`](../../osn/api/src/services/auth/email-link.ts).
A flow may keep its own pending state beside it (sign-up's is
`pendingRegistrations`, keyed by address; email change's is
`pendingEmailChanges`, keyed by account); recovery and step-up keep none.

## What one request holds

`begin` opens a request and answers the tab that began with four things:

| Value | Where it lives | What it is for |
|---|---|---|
| Request id | The link's path, the tab, both routes' paths | `signup_`, `recovery_`, `stepup_` or `emailchange_` + 12 hex. The prefix tells the link's page which flow it is, without a read |
| Link secret | The email only, in the link's **fragment** | 256 random bits. A fragment is never sent to a server, so it reaches no log and no referrer |
| Claim secret | The tab that began, in memory or this tab's `sessionStorage`, never a cookie | 256 random bits. Whoever holds it gets the flow's result (sign-up: the account's session; step-up: a step-up token) |
| Pairing number | The tab that began shows it | Two digits. The confirm step requires the number shown on the waiting screen (see Pairing below) |

The store entry (`email_link` ceremony store, keyed by request id) holds only
SHA-256 hashes of the secrets, a keyed digest of the pairing number
(`serverMac.pairingDigest`), the flow, its subject (sign-up's pending-entry
key; recovery's account id; step-up's and email change's account id, which
every later call must be signed in as), `pending`, `confirmed`, `claimed` or
`declined`, the expiry and, where the flow sets one, `bound` — a keyed digest
of the address the link went to, which the flow's claim checks again — and,
for step-up, `purpose`, the purpose the token will name. A claimed request
also holds its claim: the account and profile ids its finish writes (for
recovery, also the id of the audit row it writes; for email change, the id
its change is recorded under), and how long the poll finishing it holds it
([[#Rules every flow keeps]]). A sign-up request also holds the sign-up it
parks (address, handle, display name; see [[#Sign-up]]). The entry carries
`v: 1`; any other shape, a status no write gives, or a claimed entry without
its claim, is refused.

## Pairing: pick or type

Each flow has a pairing mode (`EMAIL_LINK_PAIRING_MODE`):

| Mode | Flows | The number | The confirm page | A blind guess is right |
|---|---|---|---|---|
| `pick` | sign-up, email change | `10`–`99`, one of five candidates derived from the request id (`serverMac.pairingCandidates`), drawn at random | reads the candidates with the link secret; the reader picks one | 1 time in 5 |
| `type` | recovery, step-up | `00`–`99`, derived from the request id (`serverMac.typedPairing`) | reads nothing; the reader types the number | 1 time in 100 |

Recovery and step-up type: their links go to an account's own address at the
asking of someone who may not be the owner (a stranger who knows the address,
or a stolen session), so a blind guess must be rare. Sign-up's and email
change's links go to an address the asker typed.

A `pick` request's candidates come sorted ascending, and `begin` draws the
number uniformly from them, so it is equally likely to sit at any place in the
list and the order says nothing about which is right; hosts pass the list to
`ConfirmLinkPage` as given, and no host reorders it.

Either way the number is never stored in clear and a wrong one ends the
request at once. A `type` request's candidates read answers `expired` after
the one read an unknown request makes. A typed `7`, `07` or `007` is the
number `07`. A `pairingPick` that is neither `none` nor digits in the flow's
form (two for `pick`, one to six for `type`) answers `expired` like any other
refusal, before any store call.

## The link: `<frontend origin>/verify/<request id>#<link secret>`

The origin comes from `frontendOrigin(config)` in
[`helpers.ts`](../../osn/api/src/services/auth/helpers.ts): `authorizeUiUrl`'s
origin, else the first WebAuthn origin. The recovery notice's "this wasn't me"
link uses the same helper. Deployed, that is Musubi (`OSN_AUTHORIZE_UI_URL`).

Musubi's `/verify/:requestId` is a bare route. `index.tsx` takes the secret off
the address bar with `history.replaceState` before anything renders, and keeps
it in memory only, so a reload loses it (the email's link still works). For a
`pick` flow the page reads the candidates with it, then shows
`ConfirmLinkPage` with them; a read that answers `confirmed` or `expired`
opens the page on that answer (`initialOutcome`) with nothing to pick. For a
`type` flow (recovery, step-up) it reads nothing and shows `ConfirmLinkPage`
with `typeNumber`.
The page sends the number tapped or typed, or `null` for "I didn't ask for
this", which the client posts as `pairingPick: "none"`. It offers no Continue:
the tab that began finishes, on this device or another.

## Routes

| Route | Body | Answers |
|---|---|---|
| `POST /register/begin` | details, Turnstile token, optional `previous` | `{ requestId, claimSecret, pairingCode, expiresAt }` |
| `POST /email-link/:requestId/candidates` | `{ linkSecret }` | `ready` with `pairingCandidates`, `confirmed`, or `expired` |
| `POST /email-link/:requestId/confirm` | `{ linkSecret, pairingPick }` | `confirmed`, `declined` or `expired` — never a cookie or token |
| `POST /register/:requestId/status` | `{ claimSecret }` | `pending` with the `pairingCode`, `expired`, `conflict`, or 201 with the session (cookie + access token) |
| `POST /register/:requestId/resend` | `{ claimSecret }` | `sent`, `limit` or `expired` |
| `POST /login/recovery/email/begin` | `{ identifier, turnstileToken? }` | 202 `{ requestId, claimSecret, pairingCode, expiresAt }` |
| `POST /login/recovery/email/:requestId/status` | `{ claimSecret }` | `pending` with the `pairingCode`, `expired`, or 201 with the restricted recovery session (cookie + access token) |
| `POST /login/recovery/email/:requestId/resend` | `{ claimSecret }` | `sent`, `limit` or `expired` |
| `POST /step-up/email/begin` (Bearer) | `{ purpose }` | `{ requestId, claimSecret, pairingCode, expiresAt }` |
| `POST /step-up/email/:requestId/status` (Bearer) | `{ claimSecret }` | `pending` with the `pairingCode`, `expired`, or `complete` with `step_up_token` and `expires_in` — never a session |
| `POST /step-up/email/:requestId/resend` (Bearer) | `{ claimSecret }` | `sent`, `limit` or `expired` |
| `POST /account/email/begin` (Bearer) | `{ new_email }` | `{ requestId, claimSecret, pairingCode, expiresAt }` |
| `POST /account/email/:requestId/status` (Bearer) | `{ claimSecret }` | `pending` with the `pairingCode`, `confirmed` (claims nothing), or `expired` |
| `POST /account/email/:requestId/resend` (Bearer) | `{ claimSecret }` | `sent`, `limit` or `expired` |
| `POST /account/email/:requestId/complete` (Bearer) | `{ claimSecret, step_up_token }` | `{ email }`; 400 for every refusal of the request or the step-up token |

There is no `GET` on any of them: mail scanners open links before people do.

Every Bearer route above but `POST /account/email/:requestId/status` also
answers `409 { error: "session_stale" }` to a caller whose session has ended,
before it mails, reads, replaces or spends anything
([[sessions#Access-token session binding (`osn_sid`)]]).

## Rules every flow keeps

- **Every refusal reads the same.** An unknown request, a wrong secret, a spent
  or expired request, a wrong pick and another flow's request all answer
  `expired`. A poll with a wrong claim secret answers `expired` too. The one
  answer apart is the `409 session_stale` above, which says nothing about the
  request: it is refused before the request is read.
- **Wrong secrets are counted** on the request against `MAX_OTP_ATTEMPTS` (5),
  by the store's `guess`, on the candidates read and the confirm alike. Every
  guess past the fifth is refused without the secret being compared, the
  right one included. In step-up the fifth also wipes the request. In a quiet
  flow (below) it ends nothing: the reader's own confirm counts as a guess
  and its write restarts the count, so the point where a wipe fell would show
  the tab that began whether the reader acted. Each wrong secret there costs
  the one `guess` call, and the request lives to its expiry. A right secret's
  read counts nothing, so a reload, or a scanner that runs the page's script,
  spends nothing. Confirm and Resend rewrite the entry, which restarts the
  count: the cap is per link sent. A wrong secret counts nowhere else:
  whoever began a request holds its id, and a 256-bit secret needs no wider
  count.
- **A wrong number ends the request at once**, confirmed or not, and counts a
  strike against the flow's subject — only the holder of a link can make one.
  The entry stays, marked `ended`, until it expires; nothing confirms, claims
  or resends it after, and the flow's pending entry is freed at once. Only
  the number whose write ended the request counts (or one whose write and
  delete the store did not answer): of two wrong numbers at once one counts, and one
  that finds the tab's claim took the request counts none. Sign-up counts a
  wrong pick (`registration_link_lockout`) under the probe key of the address
  exactly as typed, lowercased: three in 24 hours and no more sign-up links go
  to that address until the window passes, while begin answers as ever.
  Another `+tag` variant, or another of Gmail's forms, keeps its own count.
  Recovery counts per account ([[#Recovery]]).
- **"I didn't ask for this"** (`pairingPick: "none"`) ends the request too,
  confirmed or not, counts nothing against the reader, and answers
  `declined`. The entry stays, marked `declined`, until it expires, so the same
  decline sent again answers `declined` again; nothing else gets anything from
  it — a number and a read answer `expired` — and the flow's pending entry is
  freed at once. A right number the account's lockout refuses (recovery,
  step-up) ends the request as `ended` too.
- **Quiet flows answer the tab that began alike, whatever the reader does.**
  Sign-up, recovery and email change (`EMAIL_LINK_QUIET`) can mail an address
  the tab has not proven: one with no account, or another person's. So for an
  ended or declined request their poll answers `pending` with the number, and
  their Resend answers `sent` (or `limit` after three sends) and mails
  nothing, until the request expires, exactly as for a request that was never
  mailed; each makes the store calls and statements that one makes. A person
  who mis-picks or declines on their own phone sees the link's page say it no
  longer works, or "Cancelled", which sends them back to the waiting screen's
  "Start again"; the waiting screen keeps reading "Check your email".
  Step-up's link goes to the signed-in account's own address, so its poll
  answers `expired` at once.
- **An ending never leaves a request confirmable.** A close tries its write up
  to four times (the tab's two Resends and the reader's confirm are the only
  writes that can beat it), and a store fault on it is tried once more. When
  no mark lands, the request is deleted instead, so a quiet flow's tab may
  then read `expired` early: the price of a store fault, never of a guess.
  When the delete is not answered either, the process that took the pick
  refuses the request at every later confirm and claim until it expires, and
  answers the pick (or the decline) as a refusal.
- **A right secret and pick on a confirmed request answers `confirmed` again**,
  so a confirm whose answer was lost does not read as a failure.
- **Single delivery.** The poll that finds the request confirmed claims it: a
  `swap` naming the entry it read, to `claimed`, which fixes the account and
  profile ids (for recovery, also the id of its `account_recovered` row) and
  holds the request for that poll for five seconds
  (`EMAIL_LINK_CLAIM_HOLD_MS`). Of two polls at once one claims it and the
  other answers `expired`, as does any poll that finds the request held. The
  claiming poll finishes the flow — sign-up inserts the account and profile;
  recovery commits the wipe, the audit row and the cooldown — issues the
  session, then removes the entry (`consume` naming the claimed entry), and
  answers 201 only when that removal was its own; a poll after it answers
  `expired`.
- **A fault after the claim is finished by the next poll, on the same
  account.** Any failure before the removal — a database write, the
  session's write, a store call — leaves the request claimed, and the poll
  lets go of its hold, so the tab's next poll takes it over at once; a poll
  that died without letting go is taken over once the hold passes. The next
  poll writes with the same ids. For sign-up, a UNIQUE clash on rows an
  earlier try committed (a batch whose answer was lost) goes on to the
  session; a clash with someone else's account answers `conflict`, ends the
  request and frees the address. For recovery, a poll that meets the
  cooldown, finds the claim's own audit row, and finds the account's last
  recovery still at that row's instant goes on to the session from that
  recovery, and sends the notice with a disown link again; any other cooldown
  refusal, a later recovery included, ends the request. Of all the polls that ever hold a
  request, one delivers its session; a slower one that lost the request
  answers `expired`, and the session row it wrote is never handed out.
- **Nothing else ends a claimed request.** A decline and a wrong pick answer
  `expired` and count nothing; wrong secrets reaching the cap wipe nothing;
  `previous` retires nothing; a right pick and a candidates read answer
  `confirmed`; a Resend answers `sent` and mails nothing. The finish does not
  need the flow's pending entry once the request is claimed. A claimed
  request still ends at its own expiry.
- **Begin, the poll and Resend answer a taken address and a free one alike,
  whatever the free one's reader does.** Begin writes the request and swaps
  the pending entry in every branch (same calls, same answer shape, a
  plausible pairing number) and mails after the answer. A taken address's
  request is never mailed, and its poll stays `pending` until it expires, as a
  free one's does whether its link goes unanswered, declined or mis-picked.
  A free one's dead request parks its Resend's swap at the probe key of its
  address, never at the address, so it never holds a free address again.

## Sign-up

- **One live sign-up per address.** The pending entry is swapped in from
  nothing, so a second begin for the address parks nothing and sends nothing
  while the first lives. `previous` — the request and claim secret of a
  sign-up this tab began and left — retires that request first, so a person
  who goes back to fix the handle can begin again at once.
- **A request that did not park parks on a Resend.** Every sign-up request
  carries the sign-up it parks: the address, handle and display name, never
  the birthdate (a taken address's decoy carries none). Every Resend swaps
  that in at the address from nothing, then reads the pending entry and mails
  only when it names this request and holds an address. Once the sign-up that
  held it has ended — retired, declined, wiped, expired or completed — the
  swap wins and the link goes out under a Resend's limits, unless an account
  has the address or the handle by then (below); where another live sign-up
  holds it, the swap cannot win, nothing goes, and the answer is `sent` as
  ever. A free address's request, a taken one's and a held one's make the
  same four store calls.
- **Every send checks the address and handle again.** The send that runs
  after the answer, for begin and Resend alike, first runs begin's probe on
  `accounts.email` and `users.handle`, and sends nothing when either is taken
  (`sends{result="taken"}`): a held request can park after the sign-up that
  held it completed, so no account's address ever gets a sign-up link. A
  probe that fails sends nothing either (`failed`). The probe comes before
  the limits, so a link that does not go reads none of them. A request that
  parks at an address an account has taken stays parked until its own expiry,
  or until it is retired, declined or wiped: its entry blocks nobody, since
  every begin for an address with an account parks at the probe key, and it
  has no link to confirm.
- **Resend** sends another link for the same request; every link sent stays
  usable, three in all. A refused or failed send leaves the request live, and
  Resend is the retry.
- **Resent mail** is capped per mailbox: `registrationSendCap`, six Resend
  links an hour, keyed on the probe key of the address's mailbox key
  (`mailboxKey` in [`helpers.ts`](../../osn/api/src/services/auth/helpers.ts)),
  checked inside the send that runs after the answer. The mailbox key is the
  address lowercased with the local part's `+tag` cut, on every domain; at
  `gmail.com` and `googlemail.com` the local part's dots are dropped too and
  the domain reads as `gmail.com`. A different local part is a different key.
  On a domain where `+` names a different mailbox, one cap covers both, which
  can hold back a Resend for the second; that is accepted. The key feeds this
  cap and nothing else: the strike counter, the account, the pending sign-up
  and the mail keep the address as typed, lowercased.
- **A begin's first link** does not count against that cap, so a Resend
  never spends it. The strike lockout stops it as it stops a Resend.
- **First links count against a window of their own.** Every begin's first
  link counts against `registrationFirstLinkCap`, ten an hour per mailbox key
  (`REGISTRATION_FIRST_LINKS_MAX`; the same probe key as the Resend cap's, in
  the `auth.registration_first_link_cap` store), whatever form of the address
  was typed: every `+tag` variant and every Gmail form share it, though each
  has a pending entry of its own. The mailbox's first link of the hour is the
  window's first count, so it always goes; past ten, the link is not sent and
  begin answers as ever (`sends{result="capped"}`), its poll `pending` as a
  never-mailed request's. Two things free an address at once, `previous` on
  the next begin and the reader's decline; the begin after either is a first
  link like any other and counts the same. A stranger who spends a mailbox's
  window, with ten Turnstile-gated begins, holds back the owner's next begin
  for up to an hour; the owner accepted that cost. A decline with the link's
  secret goes through even once whoever began the request has spent its five
  guesses, so the reader can always free the address.
- **The wait survives a reload.** `Register` keeps the request, claim secret,
  address and handle (no birthdate) in this tab's `sessionStorage`, and the
  auth dialogs and `/authorize` reopen it. The pairing number is never stored:
  `Register` holds it in memory, and a reloaded tab polls at once and shows the
  number the `pending` answer carries, which the server recovers from the
  stored digest. It polls one call at a time, from two seconds growing to ten,
  and at once when the tab comes back into view. A full ten-minute wait is about
  62 polls: one Worker request each, plus at most one CORS preflight per ten
  minutes (`maxAge: 600`).
- **A browser token can stand in for the link.** With the Email Verification
  API flag on, a begin may carry a token the browser got from the address's
  mail provider. One that verifies confirms a free address's request at
  begin, so nothing is mailed and the tab's first poll makes the account; a
  taken or held address's request, and every token that fails a check,
  goes on as above. The flag, the checks and what they cost are in
  [[email-verification-api]].
- **A completing answer is never dropped.** `Register` holds the session for
  the passkey step and publishes it once a passkey is enrolled. When the answer
  lands after the dialog closed, there is no passkey step: `Register` publishes
  the session at once, as the cookie the answer set would on the next load, and
  clears `osn.signup.pending` and `osn.signup.previous`.

## Recovery

- **Begin answers every address alike.** One database query resolves the
  address, then one store write opens a request about the account, or about
  the typed address's probe key when it names none; that one is never mailed,
  and its poll stays `pending` until it expires. The link goes out after the
  answer.
- **Several requests may be live for one account**: a stranger's begin
  neither replaces nor blocks the owner's. There is no pending store.
- **The restricted session goes to the poll** of the tab holding the claim
  secret, once: `aud: "osn-recovery"`, 15 minutes, able only to enrol a
  passkey ([[account-recovery-factors]] §B). The device that confirms gets
  `{ status }` and nothing else. The claim checks the account still has the
  address the link went to (`bound`), and a fault after it is finished by the
  next poll ([[#Rules every flow keeps]]).
- **Lockout.** A wrong typed number counts on `recovery_otp_lockout`, keyed on
  the account: five in 15 minutes and, for the rest of the window, no recovery
  link is sent to it and a right number is refused (the request ends). A
  counter that cannot be read fails closed with a 503 and keeps the request.
  The fifth writes a `recovery_otp_lockout` security event. A decline counts
  nothing, and writes a `recovery_link_declined` event once. Neither shows on
  the tab that began: its poll stays `pending` ([[#Rules every flow keeps]]).
- **Limits on recovery mail**, all checked in the send after the answer, so
  begin answers the same whatever they say:

  | Limit | Counts | Key |
  |---|---|---|
  | 3 a day per account and client network (`recoveryLinkAddressCap`) | every link | `serverMac.recoverySendKey(accountId, ip)`: an IPv4 address as it is, an IPv6 address by its /64 (`clientNetwork` in `@shared/rate-limit`) |
  | 3 Resends a day per account (`recoveryResendCap`) | Resend links only | account id |
  | 20 a day per account (`recoveryLinkCeiling`) | every link | `serverMac.probeKey(accountId)` |
  | 5 begins an hour per client address (`recoveryEmailBegin`), Turnstile | begins | client address |

  A begin's first link never spends the account's Resends, and each client
  network has its own allowance (an IPv6 client rotating through its /64
  earns none); the ceiling bounds what one mailbox can be
  sent, 20 links a day, however many addresses ask.
- **The odds.** A blind typed number is right 1 time in 100 per request; a
  wrong one ends the request; five wrong numbers in 15 minutes lock email
  recovery for the account; the reader can always decline.
- **The wait survives a reload**: `RecoveryLoginForm` keeps the request, claim
  secret and address (never the number) in this tab's `sessionStorage`
  (`osn.recovery.pending`); `SignIn` opens on its recovery view and Musubi's
  dialogs reopen sign-in. Resend unlocks after two minutes.

## Step-up

- **One purpose, fixed at begin.** The tab names the `StepUpPurpose`; the
  request stores it; the token the claim mints names it, and the poll cannot
  ask for another. A token minted this way carries `amr: ["otp"]`, so it
  passes exactly the gates whose allow-list admits the emailed factor
  ([[step-up#When step-up is required]]): never `passkey_delete`, and
  `email_change` only outside a recovery's 72-hour window.
- **The link goes to the account's own address**, and names what confirming
  allows ("asked to download a copy of the account's data"). The claim checks
  the account still has that address (`bound`).
- **Only the account that began** can poll, resend or claim, and only while
  the caller's session is live: every call is Bearer-authenticated, a
  restricted recovery session is refused, a session that has ended gets
  `409 session_stale`, and another account's request reads as `expired`. The token goes to the poll, once;
  the device that confirms gets `{ status }` and nothing else.
- **Lockout.** A wrong typed number counts on `step_up_link_lockout`, per
  account, on recovery's numbers: five in 15 minutes, and for the rest of the
  window no step-up link is mailed and a right number is refused. A counter
  that cannot be read fails closed with a 503. The fifth writes a
  `step_up_link_lockout` security event, after the answer, and each count
  moves `osn.auth.step_up.lockout{result}`. A decline counts nothing and
  writes a `step_up_link_declined` event once, after the answer, which the
  owner's security banner shows; no notice is mailed.
- **Limits**: at most 10 step-up links a day per account
  (`stepUpLinkCeiling`, first links and Resends) — a first link is counted in
  begin, which past the ceiling answers 400 (`invalid_request`), so the tab
  says no link could go rather than waiting; a Resend is counted in the send — and 3
  Resends a day per mailbox (`linkResendCap`, counted apart from email
  change's, so neither flow's Resends spend the other's). Begin: 5 a minute
  per client address.
- **The UI** is `StepUpDialog`, a sheet: "Use email instead", under the
  passkey, swaps the factors for `CheckEmailView` in the sheet; the sheet
  polls and hands the token to `onToken`, unless the person closed the sheet
  or pressed "Use another method", or the sheet has gone, in which case a
  token that arrives is dropped. "Use another method" ends the wait on this
  side as closing does: the poll stops and the claim secret and number go, so
  choosing the link again sends a new one. The claim secret and number live in
  memory only, and without a `purpose` the sheet does not offer the factor.

## Email change

- **The link goes to the new address** and proves the new inbox; the
  account's address does not change until the tab completes.
- **Begin answers every address alike.** Past the checks that depend only on
  the caller (address syntax, three begins a day per account, the account's
  own address, two changes a week), a taken address and a free one make the
  same calls — one collision probe, one request opened, the pending change
  replaced — and only a free one is mailed. The taken one's link secret goes
  nowhere, so it can never be confirmed; its poll stays `pending` until it
  expires, and so does a free one's after its reader declines or picks a
  wrong number ([[#Rules every flow keeps]]): the signed-in caller learns
  nothing about who owns the new address.
- **Status answers `confirmed` without claiming.** The tab then steps up for
  `email_change` (a passkey, or a step-up link to the CURRENT address; never
  TOTP) and completes. Complete checks the request is this account's,
  confirmed, and still its pending change before it verifies the step-up
  token, so a stale request spends no token; then claims the request beside
  the preflight and commits the move, its record and the revocation of every
  other session in one batch. The pending entry is removed after the answer,
  only while it still names this request.
- **One live change per account**: a new begin replaces the pending change,
  and the older request can no longer complete.
- **Lockout.** A wrong pick counts against the new address on the same
  per-address counter as sign-up's links (`registration_link_lockout`, three in
  24 hours), so a mailbox that turns down links stops getting them. Resends:
  3 a day per mailbox (`linkResendCap`, counted apart from step-up's).
- **The UI** is `ChangeEmailForm`: the new address, `CheckEmailView` with
  "Use a different email", then `StepUpDialog` for `email_change`. A failed
  complete goes back to the wait, whose poll says whether the request can be
  completed again (step up again) or is spent (send a new link).

## Mailbox keys

Strikes and lockouts key on the exact lowercased address (or the account).
Only the Resend caps — sign-up's, and the step-up and email-change cap
`linkResendCap` — fold an address to its mailbox (`mailboxKey`, described
under [[#Sign-up]]).

## Adding a flow

1. Add it to `EmailLinkFlow` (`stores.ts` and `@shared/observability`), to
   `EMAIL_LINK_ID_PREFIX`, `EMAIL_LINK_PAIRING_MODE`, and to
   `emailLinkPurpose` in `@osn/client`.
2. Give its pending entry a `requestId` and add its store to `pendingStoreOf`
   (or answer `null` there for none), and its strike counter to `strikesOf` in
   `email-link.ts` (it takes the entry, so it can key on `bound`); `admits` is
   where a flow refuses a right number, and `declined` is what a first decline
   writes.
3. Give it its own begin, status and resend routes; the candidates and confirm
   routes and the `/verify` page are shared. `poll` checks the entry's flow, so
   one flow's status route cannot finish another's request; a signed-in flow
   passes the caller's account as `subject`, so another account's poll reads
   `expired`.

## Observability

- Spans: `auth.email_link.confirm`, `auth.email_link.candidates`,
  `auth.register.{begin,resend,complete}`, `auth.register.status`,
  `auth.recovery.{email_begin,email_resend,email_complete}`,
  `auth.recovery.email_status`, `auth.recovery.link_send`,
  `auth.step_up.{begin,resend,complete}`, `auth.step_up.email_status`,
  `auth.step_up.link_send`, `auth.account.email_change.{begin,resend,complete}`,
  `auth.account.email_change.status`, `auth.account.email_change.link_send`
  (no counter on any status: polls would bury the funnel).
- `osn.auth.email_link.confirmations{outcome}` — `confirmed`, `repeat` (an
  accepted confirm or decline sent again), `refused`, `wiped`, `wrong_pick`,
  `declined`.
- `osn.auth.email_link.sends{flow, result}` — flow `registration`,
  `recovery`, `step_up`, `email_change`; result `sent`, `capped` (a lockout or
  a limit held it back), `taken` (an account has the address or the handle by
  the time the sign-up link would go), `failed` (the transport, or the send's
  account probe).
- `osn.auth.recovery.email_begin{result}` — `resolved`, `unknown_identifier`;
  `osn.auth.recovery.lockout{result}` — `recorded`, `locked`, `unavailable`.
- `linkSecret`, `claimSecret`, `pairingCode`, `pairingCandidates` and
  `pairingPick` are on the log redaction list, and so is `step_up_token`. The
  local-only debug line `[dev-link] registration <url>` (or `recovery`,
  `step-up`, `email-change`) prints the link when `OSN_ENV` is unset or
  `local`.

## Debugging

Symptoms and fixes are in [[auth-failure]], under Registration and Email
recovery.
