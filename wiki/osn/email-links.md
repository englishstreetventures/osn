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
last-reviewed: 2026-11-07
---

# Emailed links

An emailed link proves that someone holds a mailbox. It never signs anyone in:
the link's page confirms the address, and the tab that began the flow gets
the result. Sign-up uses one today; recovery, step-up and email change join it
as their flows move off emailed codes.

The shared challenge is [`email-link.ts`](../../osn/api/src/services/auth/email-link.ts);
a flow keeps its own pending state beside it (sign-up's is
`pendingRegistrations`, keyed by address).

## What one request holds

`begin` opens a request and answers the tab that began with four things:

| Value | Where it lives | What it is for |
|---|---|---|
| Request id | The link's path, the tab, both routes' paths | `signup_` + 12 hex. The prefix tells the link's page which flow it is, without a read |
| Link secret | The email only, in the link's **fragment** | 256 random bits. A fragment is never sent to a server, so it reaches no log and no referrer |
| Claim secret | The tab that began | 256 random bits. Whoever holds it gets the flow's result (sign-up: the account's session) |
| Pairing number | The tab that began shows it | Two digits, `10`–`99`. The confirm step requires the number shown on the waiting screen |

The store entry (`email_link` ceremony store, keyed by request id) holds only
SHA-256 hashes of the secrets, a keyed digest of the pairing number
(`serverMac.pairingDigest`), the flow, the key of the flow's pending entry,
`pending` or `confirmed`, and the expiry. The candidates the page offers are
derived from the request id under the server key (`serverMac.pairingCandidates`),
never stored. The entry carries `v: 1`; any other shape is refused.

## The link: `<frontend origin>/verify/<request id>#<link secret>`

The origin comes from `frontendOrigin(config)` in
[`helpers.ts`](../../osn/api/src/services/auth/helpers.ts): `authorizeUiUrl`'s
origin, else the first WebAuthn origin. The recovery notice's "this wasn't me"
link uses the same helper. Deployed, that is Musubi (`OSN_AUTHORIZE_UI_URL`).

Musubi's `/verify/:requestId` is a bare route. `index.tsx` takes the secret off
the address bar with `history.replaceState` before anything renders, and keeps
it in memory only, so a reload loses it (the email's link still works). The
page reads the candidates with it, then shows `ConfirmLinkPage` with them. It
offers no Continue: the tab that began finishes, on this device or another.

## Routes

| Route | Body | Answers |
|---|---|---|
| `POST /register/begin` | details, Turnstile token, optional `previous` | `{ requestId, claimSecret, pairingCode, expiresAt }` |
| `POST /email-link/:requestId/candidates` | `{ linkSecret }` | `ready` with `pairingCandidates`, `confirmed`, or `expired` |
| `POST /email-link/:requestId/confirm` | `{ linkSecret, pairingPick }` | `confirmed` or `expired` — never a cookie or token |
| `POST /register/:requestId/status` | `{ claimSecret }` | `pending`, `expired`, `conflict`, or 201 with the session (cookie + access token) |
| `POST /register/:requestId/resend` | `{ claimSecret }` | `sent`, `limit` or `expired` |

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
  count: the cap is per link sent.
- **A wrong pick ends the request at once**, confirmed or not, and so does
  "none of these" (`pairingPick: "none"`). Five candidates, so a pick made
  without the waiting screen is right one time in five. A decline counts
  nothing against the reader. Sign-up counts a wrong pick as a strike per
  address (`registration_link_lockout`): three in 24 hours and no more sign-up
  links go to that address until the window passes, while begin answers as
  ever.
- **A right secret and pick on a confirmed request answers `confirmed` again**,
  so a confirm whose answer was lost does not read as a failure.
- **Single delivery.** The poll that finds the request confirmed claims it
  (`consume` naming the entry it read); of two polls at once one gets the
  result and the other `expired`. A database fault after the claim puts the
  request back for the next poll.
- **A taken address is told apart by nothing.** Begin writes the request and
  swaps the pending entry in every branch (same calls, same answer shape, a
  plausible pairing number), mails after the answer, and a taken address's
  request is never mailed, so its poll stays `pending` until it expires.

## Sign-up

- **One live sign-up per address.** The pending entry is swapped in from
  nothing, so a second begin for the address parks nothing and sends nothing.
  `previous` — the request and claim secret of a sign-up this tab began and
  left — retires that request first, so a person who goes back to fix the
  handle can begin again at once.
- **Resend** sends another link for the same request; every link sent stays
  usable, three in all. A refused or failed send leaves the request live, and
  Resend is the retry.
- **Resent mail per address** is capped: `registrationSendCap`, six Resend
  links an hour, keyed on the address's probe key, checked inside the send
  that runs after the answer. A begin's first link does not count, so the
  newest sign-up always gets its first link. The key is the address as typed,
  lowercased: `+tag` variants are separate addresses.
- **The wait survives a reload.** `Register` keeps the request, claim secret,
  pairing number, address and handle (no birthdate) in this tab's
  `sessionStorage`, and the auth dialogs and `/authorize` reopen it. It polls
  one call at a time, from two seconds growing to ten, and at once when the tab
  comes back into view.

## Adding a flow

1. Add it to `EmailLinkFlow` (`stores.ts` and `@shared/observability`), to
   `EMAIL_LINK_ID_PREFIX`, and to `emailLinkPurpose` in `@osn/client`.
2. Give its pending entry a `requestId`, and add its store to `pendingStoreOf`
   and its strike counter to `strikesOf` in `email-link.ts`.
3. Give it its own begin, status and resend routes; the candidates and confirm
   routes and the `/verify` page are shared. `poll` checks the entry's flow, so
   one flow's status route cannot finish another's request.

## Observability

- Spans: `auth.email_link.confirm`, `auth.email_link.candidates`,
  `auth.register.{begin,resend,complete}`, `auth.register.status` (no counter:
  polls would bury the funnel).
- `osn.auth.email_link.confirmations{outcome}` — `confirmed`, `repeat`,
  `refused`, `wiped`, `wrong_pick`, `declined`.
- `osn.auth.email_link.sends{flow, result}` — `sent`, `capped`, `failed`.
- `linkSecret`, `claimSecret`, `pairingCode`, `pairingCandidates` and
  `pairingPick` are on the log redaction list. The local-only debug line
  `[dev-link] registration <url>` prints the link when `OSN_ENV` is unset or
  `local`.

## Debugging

Symptoms and fixes are in [[auth-failure]], under Registration.
