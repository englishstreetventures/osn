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
last-reviewed: 2026-11-11
---

# Emailed links

An emailed link proves that someone holds a mailbox. It never signs anyone in:
the link's page confirms the address, and the tab that began the flow gets
the result. Sign-up and account recovery use one today; step-up and email
change join them as their flows move off emailed codes.

The shared challenge is [`email-link.ts`](../../osn/api/src/services/auth/email-link.ts).
A flow may keep its own pending state beside it (sign-up's is
`pendingRegistrations`, keyed by address); recovery keeps none.

## What one request holds

`begin` opens a request and answers the tab that began with four things:

| Value | Where it lives | What it is for |
|---|---|---|
| Request id | The link's path, the tab, both routes' paths | `signup_` or `recovery_` + 12 hex. The prefix tells the link's page which flow it is, without a read |
| Link secret | The email only, in the link's **fragment** | 256 random bits. A fragment is never sent to a server, so it reaches no log and no referrer |
| Claim secret | The tab that began | 256 random bits. Whoever holds it gets the flow's result (sign-up: the account's session) |
| Pairing number | The tab that began shows it | Two digits. The confirm step requires the number shown on the waiting screen (see Pairing below) |

The store entry (`email_link` ceremony store, keyed by request id) holds only
SHA-256 hashes of the secrets, a keyed digest of the pairing number
(`serverMac.pairingDigest`), the flow, its subject (sign-up's pending-entry
key; recovery's account id), `pending`, `confirmed`, `claimed` or `declined`,
the expiry and, where the flow sets one, `bound` — a keyed digest the flow's
claim checks again (recovery: the address the link went to). A claimed
request also holds its claim: the account and profile ids its finish writes
(for recovery, also the id of the audit row it writes), and how long the poll
finishing it holds it ([[#Rules every flow keeps]]). A sign-up request also
holds the sign-up it parks (address, handle, display name; see [[#Sign-up]]).
The entry carries `v: 1`; any other shape, a status no write gives, or a
claimed entry without its claim, is refused.

## Pairing: pick or type

Each flow has a pairing mode (`EMAIL_LINK_PAIRING_MODE`):

| Mode | Flows | The number | The confirm page | A blind guess is right |
|---|---|---|---|---|
| `pick` | sign-up | `10`–`99`, one of five candidates derived from the request id (`serverMac.pairingCandidates`), drawn at random | reads the candidates with the link secret; the reader picks one | 1 time in 5 |
| `type` | recovery | `00`–`99`, derived from the request id (`serverMac.typedPairing`) | reads nothing; the reader types the number | 1 time in 100 |

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
`type` flow it reads nothing and shows `ConfirmLinkPage` with `typeNumber`.
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

There is no `GET` on any of them: mail scanners open links before people do.

## Rules every flow keeps

- **Every refusal reads the same.** An unknown request, a wrong secret, a spent
  or expired request, a wrong pick and another flow's request all answer
  `expired`. A poll with a wrong claim secret answers `expired` too.
- **Wrong secrets are counted** on the request against `MAX_OTP_ATTEMPTS` (5),
  by the store's `guess`, on the candidates read and the confirm alike. The
  fifth wipes the request and frees the flow's pending entry. A right secret's
  read counts nothing, so a reload, or a scanner that runs the page's script,
  spends nothing. Confirm and Resend rewrite the entry, which restarts the
  count: the cap is per link sent. A wrong secret counts nowhere else:
  whoever began a request holds its id, and a 256-bit secret needs no wider
  count.
- **A wrong number ends the request at once**, confirmed or not, and counts a
  strike against the flow's subject — only the holder of a link can make one.
  Only the number whose delete ended the request counts (or one whose delete
  the store did not answer): of two wrong numbers at once one counts, and one
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
  it — a number, a poll, a Resend and a read all answer `expired` — and the
  flow's pending entry is freed at once.
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
- **Begin, the poll and Resend answer a taken address and a free one alike
  while nobody acts on the free one's link.** Begin writes the request and
  swaps the pending entry in every branch (same calls, same answer shape, a
  plausible pairing number) and mails after the answer. A taken address's
  request is never mailed, and its poll stays `pending` until it expires, as a
  free one's does while its link goes unanswered.

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
- **A begin's first link** does not count against that cap, so the newest
  sign-up always gets its first link. It is bounded by begin's own limits —
  Turnstile, and five begins a minute per IP — and by one live sign-up per
  address, which the tab that began can end at once with `previous`. No
  per-mailbox count applies to it; the strike lockout stops it as it stops a
  Resend.
- **The wait survives a reload.** `Register` keeps the request, claim secret,
  address and handle (no birthdate) in this tab's `sessionStorage`, and the
  auth dialogs and `/authorize` reopen it. The pairing number is never stored:
  `Register` holds it in memory, and a reloaded tab polls at once and shows the
  number the `pending` answer carries, which the server recovers from the
  stored digest. It polls one call at a time, from two seconds growing to ten,
  and at once when the tab comes back into view. A full ten-minute wait is about
  62 polls: one Worker request each, plus at most one CORS preflight per ten
  minutes (`maxAge: 600`).
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
  nothing, and writes a `recovery_link_declined` event once.
- **Limits on recovery mail**, all checked in the send after the answer, so
  begin answers the same whatever they say:

  | Limit | Counts | Key |
  |---|---|---|
  | 3 a day per account and client address (`recoveryLinkAddressCap`) | every link | `serverMac.recoverySendKey(accountId, ip)` |
  | 3 Resends a day per account (`recoveryResendCap`) | Resend links only | account id |
  | 20 a day per account (`recoveryLinkCeiling`) | every link | `serverMac.probeKey(accountId)` |
  | 5 begins an hour per client address (`recoveryEmailBegin`), Turnstile | begins | client address |

  A begin's first link never spends the account's Resends, and each client
  address has its own allowance; the ceiling bounds what one mailbox can be
  sent, 20 links a day, however many addresses ask.
- **The odds.** A blind typed number is right 1 time in 100 per request; a
  wrong one ends the request; five wrong numbers in 15 minutes lock email
  recovery for the account; the reader can always decline.
- **The wait survives a reload**: `RecoveryLoginForm` keeps the request, claim
  secret and address (never the number) in this tab's `sessionStorage`
  (`osn.recovery.pending`); `SignIn` opens on its recovery view and Musubi's
  dialogs reopen sign-in. Resend unlocks after two minutes.

## Adding a flow

1. Add it to `EmailLinkFlow` (`stores.ts` and `@shared/observability`), to
   `EMAIL_LINK_ID_PREFIX`, `EMAIL_LINK_PAIRING_MODE`, and to
   `emailLinkPurpose` in `@osn/client`.
2. Give its pending entry a `requestId` and add its store to `pendingStoreOf`
   (or answer `null` there for none), and its strike counter to `strikesOf` in
   `email-link.ts`; `admits` is where a flow refuses a right number.
3. Give it its own begin, status and resend routes; the candidates and confirm
   routes and the `/verify` page are shared. `poll` checks the entry's flow, so
   one flow's status route cannot finish another's request.

## Observability

- Spans: `auth.email_link.confirm`, `auth.email_link.candidates`,
  `auth.register.{begin,resend,complete}`, `auth.register.status`,
  `auth.recovery.{email_begin,email_resend,email_complete}`,
  `auth.recovery.email_status`, `auth.recovery.link_send` (no counter on
  either status: polls would bury the funnel).
- `osn.auth.email_link.confirmations{outcome}` — `confirmed`, `repeat` (an
  accepted confirm or decline sent again), `refused`, `wiped`, `wrong_pick`,
  `declined`.
- `osn.auth.email_link.sends{flow, result}` — `sent`, `capped` (a lockout or a
  limit held it back), `taken` (an account has the address or the handle by
  the time the sign-up link would go), `failed` (the transport, or the send's
  account probe).
- `osn.auth.recovery.email_begin{result}` — `resolved`, `unknown_identifier`;
  `osn.auth.recovery.lockout{result}` — `recorded`, `locked`, `unavailable`.
- `linkSecret`, `claimSecret`, `pairingCode`, `pairingCandidates` and
  `pairingPick` are on the log redaction list. The local-only debug line
  `[dev-link] registration <url>` (or `recovery`) prints the link when
  `OSN_ENV` is unset or `local`.

## Debugging

Symptoms and fixes are in [[auth-failure]], under Registration and Email
recovery.
