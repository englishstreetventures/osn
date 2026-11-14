---
title: Session introspection + revocation
tags: [systems, auth, security]
related:
  - "[[identity-model]]"
  - "[[step-up]]"
  - "[[passkey-primary]]"
  - "[[oidc-provider]]"
  - "[[account-recovery-factors]]"
  - "[[cire-auth]]"
  - "[[coordination-store]]"
last-reviewed: 2026-11-14
---

# Session introspection + revocation

Per-device session management, exposed to users in Settings. Builds on the server-side session store introduced in Copenhagen Book C1/C2/C3.

## Refresh-token rotation chain (C2)

```mermaid
sequenceDiagram
  participant Client
  participant API as @osn/api /token
  participant DB as D1: sessions + rotated_sessions

  Client->>API: POST /token (refresh cookie)
  API->>DB: lookup hash(token) in sessions
  alt token not in sessions, or expired
    API->>DB: live rotated_sessions record for hash(token)?
    alt no record
      API-->>Client: 400 invalid_grant (force re-auth)
    else replay within ROTATION_GRACE_MS (benign concurrency)
      API-->>Client: 400 invalid_grant (family PRESERVED — rotation_race)
    else replay outside grace (genuine reuse)
      API->>DB: batch: DELETE sessions + rotated_sessions WHERE family_id = ?
      API-->>Client: 400 invalid_grant (family revoked)
    end
  else token current
    API->>API: mint new session token (same family)
    API->>DB: batch: INSERT new row FROM old row (if old stands) + INSERT rotated_sessions(old hash → family) (if new stands) + DELETE old row (if new stands — the compare-and-swap)
    alt swap deleted the old row
      API-->>Client: 200 + new HttpOnly cookie + access token
    else swap deleted nothing (concurrent grant, or a revoke mid-grant)
      API->>DB: DELETE this grant's new row (and its record, if it wrote one)
      API-->>Client: 400 invalid_grant (rotation_race; marker kept)
    end
  end
```

### The session marker cookie (`osn_has_session`)

Every route that establishes or clears a session sets **two** cookies, via `buildSessionCookies` / `buildClearSessionCookies` in `osn/api/src/lib/cookie-session.ts`:

| Cookie | Flags | Holds |
|---|---|---|
| `__Host-osn_session` (`osn_session` locally) | HttpOnly, Secure, SameSite=Lax, Path=/, host-only | the opaque `ses_*` refresh token |
| `osn_has_session` | Secure, SameSite=Lax, Path=/, `Domain=` from `OSN_COOKIE_DOMAIN` | the single bit `1` |

The marker exists so the client can tell "never signed in" from "signed in, cookie not yet replayed" **without a request**. Before this, every cold page load with no stored account fired a bootstrap `POST /token`. A bot fleet loading a `*.pages.dev` copy of the app turned that into ~33k requests a day at the issuer — half the free-tier Worker budget — and rotating IPs defeated the per-IP limiters. `loadSession` now skips the grant when the marker is absent. The marker's domain is `musubi.social`, so it would also reach the app on any other `*.musubi.social` host ([[social#Deployment]]); the session cookie, host-only on `id.musubi.social`, would not, and osn-api's CORS refuses any origin but the apex its `/token` call.

Design points worth keeping:

- **The server sets it, not the client.** It stays atomic with the cookie it describes, and it carries the right `Domain` — `id.musubi.social` issues, `musubi.social` reads, so a host-only marker would be invisible. The session cookie stays `__Host-` (a prefix forbids `Domain=`); the marker takes no prefix for the same reason.
- **It holds no secret.** A forged marker buys one 400. It is advisory only: no server-side decision may branch on it, and none does — the API reads it nowhere, it is write-only from the issuer's side.
- **The server retracts it only when the failure proves the cookie is dead.** The `/token` 400 paths are not equal: no cookie sent at all retracts; a rejected grant retracts only if the rejection was a real verification failure. A `DatabaseError` and the benign concurrent-rotation race (`ROTATION_RACE_MESSAGE`, see PR #289) both arrive with a live cookie, and retracting on either would strand a cold-start browser — the exact population the marker serves — signed out until the user signs in by hand. The predicate is `sessionStatusUnknown` in `osn/api/src/lib/grant-failure.ts`; it fails *toward* retraction on anything unrecognised, and the response-header contract is pinned in `tests/routes/token-marker-retraction.test.ts`. The proof is about the cookie the grant was sent with, not the jar: a grant that reads its cookie after a sign-in has ended that cookie's family retracts the marker although the jar now holds the sign-in's live cookie, and the next renewal sets it again ([[#Endpoints]]). The client can't delete the marker itself: from the apex it can't reproduce the `Domain` attribute, so a JS delete would only shadow it with a host-only cookie.
- **A rejected grant never clears the session cookie.** That branch also covers a storage blip; clearing would harden a transient failure into a permanent logout. A client that still holds local account state retries the grant without consulting the marker, which is the way back from a false negative.
- **No `document` ⇒ no gate.** iOS (Keychain transport) and SSR keep the old behaviour.
- **One-off migration cost:** a user holding a live cookie but no local account at deploy time is bounced to sign-in once, since no marker exists yet.

Local dev leaves `OSN_COOKIE_DOMAIN` unset — localhost is one host, so a host-only marker works. Dev sets the dev musubi social host, `musubi.<DEV_DOMAIN>`, which the musubi stack derives from the `DEV_DOMAIN` variable ([[infrastructure-as-code#Dev hosts]]); the dev domain is never a production zone, so a marker set by the dev issuer cannot reach production hosts. The value is validated against a bare-hostname pattern before it reaches the header and drops to host-only if it fails, so a bad var costs a cold-start sign-in rather than a spliced `Set-Cookie`.

**Standing constraint:** the marker is readable by every host under `OSN_COOKIE_DOMAIN`. That is accepted — the bit is not a secret — but it means a `*.musubi.social` subdomain must never be delegated to a party that shouldn't learn whether a visitor holds an OSN session. Keep subdomain delegation in-house.

Per-account hard cap: `MAX_SESSIONS_PER_ACCOUNT = 50`. Every insert of a new session — `issueTokens` and a restricted recovery session — first evicts the least recently used rows once the cap is reached (`makeRoomForSession`), so an attacker can't inflate the revocation surface. The row a cross-device approval reserves is the exception: the approval evicts nothing until its `swap` has landed, then evicts down to the cap (`makeRoomForReservation`), so a lost race or a failed store call signs no device out. Until then the account holds one row over the cap for each approval in flight. Every reservation for one request shares a family, the request's id, and the winner's eviction leaves that family out of its count, since a racing loser releases its own row. The public revocation handle (first 16 hex of the SHA-256) is collision-safe inside that bounded population.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /sessions` | List the caller's active sessions with coarse UA labels + timestamps, flagging the caller's device: every session in the family of the session the cookie names, live or rotated out |
| `DELETE /sessions/:id` | Revoke a device by the 16-hex public handle (first 16 chars of SHA-256 hash) of one of its sessions: every session of that session's family |
| `POST /sessions/revoke-all-other` | Revoke every session EXCEPT the caller's own device (the family of the live session its cookie names, or, when there is no cookie or it names none, the one its access token's `osn_sid` names; `409 session_stale` when neither names one), delete the account's OIDC authorization codes in flight, then end the account's cire organiser sessions |

All endpoints authenticate via `Authorization: Bearer <access_token>` and resolve `accountId` server-side. A session handle from account A's log cannot be replayed to revoke a session in account B — the DELETE is scoped to the caller's own account.

**A revoke holds against a refresh in flight.** A family is a device's refresh chain, or the reservations of one cross-device request. `DELETE /sessions/:id` deletes every session of the account in the family its handle names in one statement, so no refresh can land between finding the family and deleting it. The handle is looked up among the live sessions and the rotation records, so a handle from a Settings list the device has since refreshed past still finds its family. Each lookup reads its table's primary key by range (`tests/services/sessions-management.test.ts` pins the query plan). A rotation never leaves its family empty (see [[#Rotation grace window (concurrency tolerance)]]), so this delete, a reuse revoke, and every account-wide delete — sign out everywhere else, email change, erasure — leave no session behind them, wherever in a rotation they land.

**The caller's device survives its own refresh in flight.** The account-wide deletes that spare the caller — sign out everywhere else, passkey add and delete, email change — spare the caller's *family*, not the one row id the request named (`outsideFamilyOf` in [`sessions.ts`](../../osn/api/src/services/auth/sessions.ts)). The family is read from the live session the caller's hash names. A rotation inserts the new row before it deletes the old one and keeps the family, so a refresh of the caller's session in another tab, wherever it is when the delete runs, completes and keeps the device; every other device goes. Only a live session spares anything: a hash already rotated out by the time the delete runs, revoked or never issued spares nothing, so a stale token cannot shield the family someone else's refresh has moved on (a request whose own tab finished refreshing first signs that device out, and it signs in again). Erasure's soft delete keeps the rotation records of the same family. Tests: `osn/api/tests/services/sessions-management.test.ts` (each of the four, with the caller's refresh held at each of its three statements, and with a hash rotated out before the delete). Account deletion is the one exception: it spares the family the route's live-session check found, not the family its hash names when the delete runs, because a tombstoned account cannot sign in again, and a renewal in another tab between the check and the delete would otherwise leave no session that could cancel the deletion (`requestErasure`'s `cancel.familyId`; test: `tests/services/account-erasure.test.ts`, "keeps the cancel handle's device when its session was renewed after the route's check").

**Logout and the revoke's answer follow the caller's device too.** `POST /logout` deletes every session in the family of the session the cookie names, in one statement. The family is found from the live session, or from the token's rotation record while that record is live (`expires_at`, as reuse detection reads it). So a refresh of the same token in another tab, whether it finished before the delete or is in flight when it runs, leaves no session of the device. `DELETE /sessions/:id` finds the cookie's family the same way, before its delete (in the same batch on D1), and answers `revokedSelf: true` when that family was among those revoked, so the route clears the cookie whichever of the device's sessions the cookie holds. `GET /sessions` marks `isCurrent` on the same family, in the list's own statement, but counts a rotation record only while it is younger than `ROTATION_GRACE_MS`: a cookie the device refreshed past a moment ago (a second tab) still marks the device, and a cookie rotated past longer ago, such as a thief's later rotation, marks nothing. The marker grants nothing on the server. One rule decides which lookup each write takes: a hash may end its family or report the caller's device ended, whether it is live or rotated out, and may mark it in the list while live or rotated out within the grace window; only a live session spares or lifts anything ([[#The restricted recovery session]]). Tests: `osn/api/tests/services/sessions-management.test.ts` (each with the caller's refresh held at each of its three statements, and finished before the write) and `osn/api/tests/d1/rotated-sessions.test.ts` (the revoke's batch on D1).

**A logout with a token rotated out past the grace window is reuse.** Before its delete, `POST /logout` reads the token's live rotation record when no live session holds the hash (in the same batch on D1). A record written more than `ROTATION_GRACE_MS` ago means the device moved on from this token, so the logout counts it as `/token` does: `family_revoked` and the warning `Session token reuse detected at logout — family revoked` when its delete removed a session. It then deletes the family's rotation records, and the request whose delete removes them counts `reuse_detected` (logging `… no session of the family was left` at info when its own delete found none), so one token counts as reuse once, whichever routes replay it, at once or one after another. A records delete that fails logs `Session token reuse: the family's rotation records could not be removed` at error, and the logout or sign-in still succeeds: the family's sessions are gone, and a later replay of the token counts the reuse. Inside the window it is the device's own race with its refresh, and nothing is counted. A sign-in that carries such a token counts it the same way, with `at sign-in` in both lines (below). Tests: `osn/api/tests/services/sessions-management.test.ts` ("logout of a rotated-out token") and `osn/api/tests/d1/rotated-sessions.test.ts`.

**A sign-in ends the session its cookie named.** Every route that sets a new session cookie — `POST /login/passkey/complete`, `/login/recovery/complete`, `/register/:requestId/status`, `/login/recovery/email/:requestId/status`, `/login/recovery/totp/complete`, `/login/cross-device/:requestId/status` and the dev tiers' `/dev/login` and `/dev/login/form` — first issues the new session, then ends the family of the session the request's own cookie names, live or rotated out, and only then answers with the new cookie (`replaceSession` in [`lib/replace-session.ts`](../../osn/api/src/lib/replace-session.ts), over `endReplacedSession` in [`sessions.ts`](../../osn/api/src/services/auth/sessions.ts)). That cookie may be the same account's or another account's (a shared device); the browser drops it when the new one lands either way. `POST /token` is not one of these routes: it sets the same family's rotated cookie. The reason is the order in which answers land. A `/token` grant sent with the old cookie can answer after the sign-in, and the browser keeps whichever `Set-Cookie` lands last. Ending the old family means no timing of that grant leaves a live old session in the jar:

| The grant, when the sign-in ends the family | Its late answer | Then |
|---|---|---|
| had already rotated the cookie | sets the rotated cookie, whose session is gone | the next renewal with it is refused and the page is signed out, never swapped to the old account |
| was mid-rotation | `400` `rotation_race`, no cookie, marker kept | the jar keeps the new cookie |
| had not yet read the cookie | `400` `Invalid or expired session`, no session cookie, and it clears `osn_has_session` | the jar keeps the new cookie but loses the marker until the next renewal sets it again; the page that signed in holds a stored account and does not read the marker |

A sign-in with no session cookie ends nothing, and so does one that is refused or not finished (a wrong code, a poll still `pending`): the end runs only once the new session exists. A failure to end the old family is the error `Sign-in could not end the session its cookie named`, with no cause, since a database error's text carries the token's hash; the sign-in still answers with its cookie, because three of these routes (the sign-up, email-recovery and cross-device polls) hand their session out once and failing them would lose it. A sign-in whose answer never arrives (a dropped connection, a closed tab) leaves the browser holding the ended old cookie and no new one, so it is signed out of both. **The cancel handle of an account scheduled for deletion is spared.** A tombstoned account cannot sign in again, so the session its deletion kept is the only way to cancel within the grace window (the account-deletion exception above), and a sign-in leaves that account's family live. A token of it rotated out past the grace window is still a replay, and the sign-in ends the family as reuse, as `/token` would. Its rotated cookie can still land after the sign-in's, so `POST /token` refuses a session of an account scheduled for deletion a grant that names a profile the account does not own (`Invalid or expired session`, the session untouched): the page that signed in renews naming its own profile, and is signed out, never swapped to the account being deleted. The handle renews as before for its own profiles, or naming none. Every new session has a family of its own (`issueSession` and `claimReservation` mint one), so the end never reaches the session the request issued. Tests: [`tests/routes/sign-in-replaces-session.test.ts`](../../osn/api/tests/routes/sign-in-replaces-session.test.ts) — each route, succeeding and refused; `/token` held at each statement it runs while a passkey sign-in lands; the failed end.

### Sign out everywhere else reaches cire

cire's organiser portal keeps its own 7-day session, minted from an OSN sign-in and keyed on the OSN profile id ([[cire-auth]]). Once `POST /sessions/revoke-all-other` has deleted the OSN sessions, it deletes every OIDC authorization code in flight for the account: a code is bound to the account, not to the session that minted it, so one held from a revoked session would otherwise still open a cire session in the minute it lives. Then osn-api asks cire-api to end the organiser sessions of every live profile on the account: one `POST <CIRE_INTERNAL_REVOKE_URL>/internal/revoke-organiser-sessions` per profile, body `{ "osnProfileId": … }`, `Authorization: Bearer <CIRE_INTERNAL_REVOKE_SECRET>`. That includes the session on the device that asked, since cire cannot tell devices apart; the portal then sends the organiser to its sign-in page. Revoking cire's connection does the same ([[oidc-provider]]).

- **Only accounts that have signed in to cire.** cire's sign-in always records a consent row for cire's client before it issues the code that opens a cire session, and only account erasure deletes that row, so the profile lookup sends nothing for an account with none. A revoked consent still counts: a session can outlive it.
- **In the background.** The route forks the calls with `forkBackground` ([source](../../osn/api/src/routes/auth/context.ts)), so the response never waits for cire-api; on workerd the request's `waitUntil` keeps the isolate alive for them.
- **Best effort.** Each call has a 5-second timeout and does not follow a redirect; nothing retries it. A refused, redirected, failed or timed-out call is an `Effect.logError` and a counted result; signing out everywhere else again sends every call again.
- **Off until configured.** All three settings must be usable: `CIRE_INTERNAL_REVOKE_URL` an `https:` origin (plain `http:` only to a loopback host, for the local and E2E stacks), `CIRE_INTERNAL_REVOKE_SECRET` at least 32 characters, and `CIRE_OIDC_CLIENT_ID` set. Otherwise each request that would reach cire logs `cire organiser sessions not revoked: back-channel unconfigured` with the unusable names under `missing`, and sends nothing. cire-api answers 503 until it holds the same secret. A client id that is set but differs from cire-api's own sends nothing and logs nothing; `cire/infra/tests/cross-stack.test.ts` holds the committed values equal. Setting it up: [[production-deploy]].
- **Only these two requests reach cire.** Every other path that ends OSN sessions leaves cire's organiser sessions to their 7-day lifetime.

The code is [`services/cire-organiser-revoke.ts`](../../osn/api/src/services/cire-organiser-revoke.ts); route tests are in [`tests/routes/cire-organiser-revoke.test.ts`](../../osn/api/tests/routes/cire-organiser-revoke.test.ts), and the E2E flow `cire-registry-money` ends by driving it against the real cire-api ([[testing-patterns#The end-to-end suite]]).

`GET /sessions` sets `Cache-Control: private, no-store` as the first statement of the handler, so even a rejection carries it (tracker#468). See `[[shared/backend-patterns]]` §Cache-Control on Authenticated Routes for the rule and why it sits above the guards.

### Cross-device login

QR-code mediated session transfer — authenticate on a new device by scanning a code from an already-authenticated device.

| Route | Auth | Purpose |
|---|---|---|
| `POST /login/cross-device/begin` | None | Create a pending request; returns `requestId` + `cdlSecret` |
| `POST /login/cross-device/:requestId/status` | None | Poll for approval; on approval, mints device B's session and returns it once |
| `POST /login/cross-device/:requestId/approve` | Bearer, live session | Device A approves; device B's next poll gets the session. Refused `409 session_stale` when device A's session has ended ([[#Access-token session binding (`osn_sid`)]]) |
| `POST /login/cross-device/:requestId/reject` | Bearer | Device A explicitly rejects |

**Protocol:** Device B calls `begin`, renders a QR code encoding the `requestId` + `cdlSecret`, and polls `status` at ~2s intervals. Device A scans the QR, calls `approve` with its access token + the secret from the QR fragment. The server reserves a `sessions` row for device B (its token is never kept) and records the approval — the approving account, the profile device B signs in as and the reserved row's id, never a token — plus a `cross_device_login` security event + email notification. On an account at the cap, the approval evicts the least recently used session only after its `swap` lands; one that loses the `swap`, or whose `swap` fails, releases its reserved row and evicts nothing. The security event and the room-making run side by side once the `swap` lands, each to its end whatever the other does, and the notice goes out whenever the approval landed. Device B's next poll takes the approved entry and, in one D1 batch with the profile read, turns the reserved row into its session: an UPDATE gives the row a fresh token's id, a family of its own and a session's life, only while the row is live, the account stands and the profile is still in it; a DELETE in the same batch removes the reservation when the guard refused it. The row count does not change, so the poll evicts nothing. It mints the tokens from the profile and account as they are, and answers `expired`, with no token, when the reserved row is gone (any revocation of the account's sessions since the approval removes it, as it would a signed-in device's), the account is deleted or scheduled for deletion, or the profile is gone or now belongs to another account.

**Security properties:** 256-bit CSPRNG secret, SHA-256 hashed at rest, constant-time comparison, no token stored (the poll mints the session after it `take`s the approved entry, so one poll gets it; a revocation between approval and poll is honoured through the reserved row), one decision per request (approve and reject each replace the pending entry they read in one `swap`, so of two at once one lands), 5-minute TTL, rate-limited on all endpoints. The secret never appears in URL query strings (all endpoints use POST bodies). Pending requests live in the `cross_device` ceremony store, which a deployed Worker keeps on the coordination store, one object per request, gone when its TTL ends ([[coordination-store]]); the Bun dev server keeps them in memory.

## Metadata captured at issue time

Added to the `sessions` table in migration `0005_sessions_metadata_and_email_change.sql`:

| Column | What it stores | Source |
|---|---|---|
| `ua_label` | Coarse `"Firefox on macOS"` label | `deriveUaLabel(headers["user-agent"])` — bounded cardinality |
| `ip_hash` | `HMAC-SHA256(sessionIpPepper, ip)` | `getClientIp()` + peppered HMAC |
| `last_used_at` | Unix seconds | Updated on every successful refresh/verify |

**Why HMAC-peppered, not raw SHA-256 for IPs?** Plain SHA-256 over the v4 address space (2^32) is trivially rainbow-tableable. A server-side secret pepper makes offline correlation impossible without pepper access. Pepper rotation is cheap — only display continuity is affected, not session validity.

**Configuration:** `OSN_SESSION_IP_PEPPER` (≥32 bytes). Startup fails in non-local environments if unset — silent IP-hash degradation would cost users a security signal without anyone noticing.

## Public revocation handle

The public `id` field is the first 16 hex chars of the session-token SHA-256. Chosen over exposing the full hash because:

- **64 bits of collision resistance** is more than enough inside a single account's handful of sessions.
- A full SHA-256 accidentally logged gives an attacker a forge-able DELETE URL. A 16-hex prefix does not.

The server re-scans its sessions table by accountId and finds the row whose hash prefix matches. This maps handle → internal hash at request time.

## Access-token session binding (`osn_sid`)

Some endpoints must revoke every session on the account *except the caller's own* — passkey add and passkey delete both do. Until now the caller's own session was read only from the HttpOnly cookie. A request that authenticated with a Bearer access token but carried no cookie — a cross-origin call, a proxy that strips cookies, a native client — looked sessionless, so both paths took the "there is no self to preserve" branch and deleted **every** session on the account. Removing a passkey signed you out of every device, including the one you were on.

Access tokens now carry `osn_sid`: `sha256(session_hash + ":" + profile_id)` truncated to the first 32 hex chars (128 bits). Two properties matter:

- **One-way.** The session hash is itself a SHA-256 of a 160-bit random token, so `osn_sid` leaks nothing usable; a stolen `osn_sid` cannot be turned back into a session token.
- **Per-profile.** Sessions are account-scoped and shared across profile switches, so a plain session id in the token would let an observer tie two profiles of one account together — exactly what the rule that no two profiles of one account can be linked forbids ([[identity-model#Privacy Rules]]). Mixing the profile id in means each profile sees a different value for the same session.

Recognition is by recomputation: `resolveSessionByBinding(accountId, profileId, osn_sid)` reads the account's session rows — `ORDER BY last_used_at DESC LIMIT MAX_SESSIONS_PER_ACCOUNT` (50), so the caller's own row, recently used by definition, is inside the window even when a concurrent-login race leaves the account a row or two over the cap — derives the binding for each and returns the hash that matches, else `null`. The comparison is constant-time. No new secret, no schema change, no reverse lookup.

`issueTokens` and `refreshTokens` generate the session token before signing the JWT so the token binds to the session it ships with — on refresh, that is the rotated-**in** session, not the one being retired. `POST /profiles/switch` binds the new token to the session its live-session gate found (the cookie's, else the one the old profile's `osn_sid` names) and re-derives the binding for the new profile, so the binding survives a switch. `switchProfile` takes that session's hash and mints no unbound token; a caller holding no live session is refused before the switch, as below.

Passkey registration's complete never reads the cookie and the binding itself; it calls `classifyCallerSession(accountId, profileId, { cookieSessionHash, sessionBinding })`. Sign out everywhere else, passkey deletion, erasure and email change pass the session their live-session check found, so a caller admitted by its `osn_sid` alone keeps its own device. The cookie wins when it names a session that is still live, but **not merely by being present**: a revoked or rotated-out cookie hashes to a value matching no row (a row past its `expires_at` that nothing has deleted yet still matches here), and handing an unmatched hash to `invalidateOtherAccountSessions` would delete everything — the same sign-you-out-everywhere failure reached through a stale cookie instead of a missing one. The membership test is free, since the fallback already reads those rows.

With neither a live cookie nor a resolvable `osn_sid` there is genuinely no self to preserve, and the account-wide revocation stands — a token minted before this claim existed degrades to the old behaviour rather than failing.

**A route that calls `liveSession` or `liveSessionGate` refuses a caller with no live session.** An access token outlives the session it came from by up to one token lifetime. Every Bearer route that mints a step-up token, an access token, a session, an authenticator-app factor or a relying party's client secret calls the gate, and so does each route that writes or spends what the owner's own ceremonies depend on: a parked passkey challenge (step-up's, and registration's for an ordinary caller), the pending authenticator-app secret, a link mailed to the owner, the account's daily link ceiling and its Resends, the account's pending email change and its begins, its client caps. Every route that spends a step-up token calls it too, before the token is read — `DELETE /account`, `GET /account/export`, both security-event acknowledgements, `DELETE /totp`, `PATCH /passkeys/:id` and `DELETE /passkeys/:id` — and so do `POST /account/restore`, `DELETE /sessions/:id`, `POST /sessions/revoke-all-other` and `DELETE /oidc/connections/:clientId`. Passkey registration's complete checks the session through `classifyCallerSession` instead, as above, because enrolment must admit the restricted recovery session; its begin refuses a restricted caller whose session that lookup does not resolve. Each route calls the check once it has resolved the profile, before it reads, spends, writes or revokes anything ([`lib/live-session.ts`](../../osn/api/src/lib/live-session.ts)). `POST /internal/step-up/verify`, which Pulse calls over ARC to spend a token for its own deletion, sees no user session and does not check one. The gate runs `resolveLiveOrdinarySession(accountId, profileId, { cookieSessionHash, sessionBinding })`: at most one read of the account's sessions that are unrestricted (`restricted_until IS NULL`) and unexpired (`expires_at > now`), most recently used first and capped at `MAX_SESSIONS_PER_ACCOUNT`, and none when the caller sends neither input; it answers the cookie's session when the cookie names one of them, else the one the token's `osn_sid` matches. `liveSession` hands that session to the route: a profile switch binds its new token to it; an email change, a passkey deletion and sign-out-everywhere spare its device from their sweeps; an account deletion keeps it as the cancel handle. Anything else answers `409 { error: "session_stale", message: "Re-authenticate and try again." }` and spends nothing: a session logged out, revoked or swept, a restricted recovery session's cookie, a row past its `expires_at`, another account's cookie, or a token with no `osn_sid` sent with no cookie. It is stricter than `classifyCallerSession`, which counts every row of the account because passkey enrolment must resolve a restricted session. The cookie counts as well as the binding because each tab keeps its own access token while sharing the cookie: a renewal in one tab deletes the row another tab's token is bound to, and the cookie names the row that replaced it. `git grep -n "liveSession" osn/api/src/routes` lists the routes that call it. The check is on the caller's session, not on the session that minted the step-up token: a token minted by a session that has ended cannot be spent with that session's own access token, only by a caller holding another live session of the account. Tests: [`tests/routes/live-session-gate.test.ts`](../../osn/api/tests/routes/live-session-gate.test.ts).

## Rotation preserves metadata

Refresh-token rotation (Copenhagen Book C2) inserts a new session row with a rotated session token while the old row stands, writes the rotation record while the new row stands, then deletes the old row while the new one stands; on D1 the three run as one batch, so the family always holds a session mid-rotation. We copy the old row's `ua_label` and `ip_hash` onto the new row so Settings continues to show the same "Firefox on macOS" entry instead of flipping to a new device. The `last_used_at` timestamp is set to the rotation moment.

## The restricted recovery session

Account recovery has to end in something that lets the user enrol a fresh passkey and do **nothing else**. That session exists as of `sessions.restricted_until`, and the restriction is carried by a **distinct token audience**, not by a flag.

The obvious design — a `restricted` boolean checked in "the access-token guard" — has no place to live. There is no single guard: four entry points in `@osn/api` verify access tokens, and three services outside this repo (`pulse/api`, `zap/api`, `cire/api`, all through `@shared/osn-auth-client`) verify the same token over JWKS with no access to OSN's D1. A column is invisible to those three, so a "restricted" session would still read and write Pulse events and Zap chats.

So the access token is minted with `aud: "osn-recovery"` instead of `"osn-access"`. Every one of those seven verifiers **already** pins `osn-access`, so all seven reject it with no change to any of them. That is the whole argument for an audience over a claim: it is fail-closed by construction, and it does not wait on three other services deploying anything. `osn-recovery` is also on the reserved OIDC client-id deny-list, so no relying party can ever register under a name that collides with the pin.

| Property | Ordinary session | Restricted recovery session |
|---|---|---|
| Access-token `aud` | `osn-access` | `osn-recovery` |
| `sessions.restricted_until` | `NULL` | Unix seconds, = `expires_at` |
| `sessions.restricted_amr` | `NULL` | the factor that minted it — `otp`, `totp` or `webauthn` |
| Lifetime | 30 days, sliding | **15 minutes, absolute — never slides** |
| Accepted by | every verifier | `resolvePasskeyEnrollPrincipal` only |
| Counts against `MAX_SESSIONS_PER_ACCOUNT` | yes | yes |

**`restricted_until` is the source of truth for rotation, not for request-time authorisation.** Request-time is the audience's job. The column exists because `refreshTokens` deletes the old row and inserts a new one: without it the restriction would die on the first silent refresh, five minutes in. Rotation copies the value forward, re-mints on the recovery audience while it is set, and pins the new row's `expires_at` to the **original** deadline rather than `now + TTL`.

Two guards are load-bearing and neither is emergent:

- **The sliding window is switched off explicitly.** `shouldExtend` is `expires_at - now < halfTtl`, and a restricted session's whole 15-minute life sits far inside half of a 30-day TTL — so the comparison alone is *always* true, and without a `restricted_until === null` term the one session that must expire on schedule is the one that gets extended to a month.
- **`verifyRefreshToken` rejects a restricted session by default**, and `refreshTokens` is the only caller that opts in. This matters because `GET /authorize` resolves the signed-in user from the **session cookie**, not from an access token — see [[oidc-provider]]. A restricted session sets that cookie (it must; see below), so without the default it would complete an OIDC authorization and sign the user into every relying party: full access at a different service, from a session that has none here.

**The enrolment gate is bypassed on purpose, and the bypass is priced.** `beginPasskeyRegistration` refuses without a `passkey_register` step-up once the account holds ≥1 passkey — and losing a phone does not delete its passkey row, so that is the *common* recovery case, not an edge. A recovery-audience caller can therefore pass that gate. The alternative — letting a restricted session mint step-up tokens — would hand it `/recovery/generate`, `DELETE /account`, `GET /account/export` and `/account/email/:requestId/complete` along with it, which is everything the restriction exists to prevent.

The argument for skipping it is that the OTP or TOTP code which minted the session already **was** a ceremony, at a strength `passkeyRegisterAllowedAmr` accepts — so that is a precondition the code enforces rather than a claim it makes:

- `issueRecoverySession` takes a **required** `amr` (`otp` / `totp` / `webauthn`), refuses at mint time anything the allow-list does not admit, and stores it in `sessions.restricted_amr`. There is no way to mint a session whose factor the gate would have refused.
- The gate reads that column back off the caller's own session row — named from the cookie or the token's `osn_sid`, exactly as `/complete` names it — and admits the bypass only for a row that is this account's, still restricted, inside its deadline, and recording an admitted factor. Four fail-closed answers; an unresolvable session simply needs a step-up token like anyone else.
- Narrowing `passkeyRegisterAllowedAmr` therefore withdraws the bypass from sessions **already issued**, not just from future ones.

The per-account passkey cap does not refuse this enrolment, at any count — an account at the cap that had lost every device could not otherwise recover at all, and that was `englishstreetventures/osn#970`. What bounds the count instead is a reclaim above `RECOVERY_ENROLMENT_PASSKEY_CEILING`, one credential over the cap, and it can only take back the slots **this same recovery episode lent**: `recovery` provenance *and* created at or after `accounts.last_recovered_at`. Nothing that predates the recovery is ever taken, because `provenance_amr` is never updated after insert and a `recovery` row that has matured into the owner's daily device still carries that value. Where there is nothing of its own to reclaim the threshold gives way, and the account ends a credential above it rather than a credential down. Every other enrolment is refused at the cap unchanged. The rule, its argument and the recovery-code path it does not cover are in [[account-recovery-factors#E. The passkey ceiling, and the slot it lends]] (`wiki/osn/account-recovery-factors.md`).

**Whatever issues one must set the session cookie**, exactly as `POST /login/recovery/complete` does. `completePasskeyRegistration`'s other-session sweep derives the caller from that cookie (or from the token's `osn_sid`) and answers `session_stale` (409) when it can do neither — so a recovery route that forgets `buildSessionCookies` produces a session that cannot finish the one thing it exists for.

**Enrolling the passkey lifts the restriction.** `completePasskeyRegistration` clears `restricted_until` and `restricted_amr` and replaces the absolute deadline with an ordinary sliding TTL, so the user is not signed out minutes after recovering. From the next `/token` grant the access token carries `osn-access` again.

That `UPDATE` is the one write that turns a restricted session into a full one, so all four of its predicates earn their place:

| Predicate | What it stops |
|---|---|
| `family_id IN (family of the caller's live session)` | Lifting a session of any device but the one that just enrolled |
| `account_id = <caller's account>` | A hash from another account being lifted through a caller who does not own it. Its two siblings over this table (`invalidateOtherAccountSessions`, `revokeAccountSession`) scope the same way, and `completePasskeyRegistration` takes the hash as a plain parameter |
| `restricted_until IS NOT NULL` | An everyday passkey add quietly resetting the caller's session clock |
| `expires_at > now` | Reviving a session past its 15-minute deadline. `liveSessionIds` has no expiry term, so an expired restricted row still classifies as the caller's own, and expiry is otherwise enforced only in `verifyRefreshToken` — which this path never calls. Without it the real bound was the deadline plus one access-token TTL |

**No restricted session of the enrolling device outlives the enrolment.** The lift names the device by the family of the caller's live session, so it follows a refresh of that session in another tab. If the session is live when the lift runs, every restricted row of the family is lifted: the new row of a refresh in flight (which copied the old row, restricted, before the lift) included. A refresh that inserts after the lift copies the lifted row. If a refresh has already replaced the session, the lift changes nothing: a lift is a grant, and a rotated-out hash grants nothing. The sweep that follows takes the same hash and spares only a live session's family, so it deletes every session on the account, the replacement included. So each restricted row is lifted, or deleted with every other session on the account; when a refresh finishes before the sweep, the user signs in again. On D1 a refresh is one batch, so the in-flight row exists only on the statement-at-a-time bun:sqlite driver. Tests: `osn/api/tests/services/recovery-session.test.ts` (the refresh held at its insert, its record and its swap, and finished before the enrolment).

**The access token is capped to the row, not just to `accessTokenTtl`.** `sessionBoundTtl` gives a restricted session `min(accessTokenTtl, restricted_until − now)`, at both issuance sites. Without it a grant late in the window mints a full-length token that outlives the row authorising it: harmless server-side, because the enrolment bypass reads the row, but it tells the browser a deadline the server will not honour — and the post-recovery enrolment screen counts on that value to know when the window ends. An ordinary session (`restricted_until` null) is untouched. This bounds the token, not the session: `verifyJwt` allows 30 s of clock skew, so a capped token still verifies for a moment after its row is gone, granting nothing.

**Refreshing one from the browser.** `@osn/client` exposes `refreshHeldSession` alongside `refreshSession`, and the difference is the whole reason it exists: it redeems the refresh cookie and returns the token set **without adopting it** — no storage write, no cached account, no session resource refetched. It is for a flow that deliberately holds a session rather than publishing one, which is every flow whose token the rest of the app would reject. Post-recovery passkey enrolment is the caller; holding the session is what puts it outside `authFetch`, so this is its only refresh path. Both share one single-flight `/token` grant, so a component refreshing while the provider bootstraps produces one request — two would replay a rotated cookie, which is what reuse detection revokes a family for.

**Two routes mint one:** the email recovery status poll, `POST /login/recovery/email/:requestId/status` (for the tab holding the claim secret, once the emailed link is confirmed — [[email-links]]), and `POST /login/recovery/totp/complete` — see `wiki/osn/account-recovery-factors.md` §B.

## Rotation grace window (concurrency tolerance)

Rotation is single-use, but legitimate clients produce concurrent or retried grants of the **same current token**: two browser tabs bootstrapping on reload, a cold-start bootstrap racing a 401-refresh in one tab, or a grant retried after a lost response. Treating every such replay as C2 reuse revoked the whole family and logged the user out across every device — the "logs out sometimes" bug. Two guards now distinguish benign concurrency from genuine reuse, WITHOUT weakening detection of a real replay:

- **CAS-0-rows is never reuse.** A rotation inserts the new row only while the old one stands, then the old token's record only while the new row stands, then deletes the old row only while the new one stands — the compare-and-swap. At every moment the family holds the old row, the new row or both. A 0-rows swap means the old row was present at verify but gone by the swap, or the new one gone: a concurrent grant rotated it in the gap, or a delete took the family or the account mid-grant. A replay of an *already*-rotated token can't reach here (it fails `verifyRefreshToken`, whose row is absent, and goes down `detectReuse`). So a 0-rows CAS is never reuse: the losing grant deletes what it wrote (its new row, and its record when it wrote one) and fails, the family is **preserved** (no `revokeFamily`, no `reuse_detected`; a `rotation_race` metric fires instead), and the route keeps the marker cookie. After a revoke, the next grant answers `Invalid or expired session`, which retracts it.
- **`detectReuse` grace window.** When a rotated-out hash is replayed, `detectReuse` compares `now − rotatedAtMs` against `ROTATION_GRACE_MS` (10 s). Within the window it is benign concurrency/retry → family preserved (`rotation_race`). Outside it → genuine reuse → full family revocation (unchanged). The window is short: an attacker replaying a stolen rotated token seconds after the legitimate rotation gains nothing they couldn't do with the live token, and any replay after the window still revokes. Mirrors the "reuse leeway" interval standard in rotating-refresh-token implementations.

**Reading the CAS result.** The rows-affected field differs per driver — bun:sqlite gives `{ changes }`, libsql `{ rowsAffected }`, and Cloudflare D1 `{ success, meta: { changes } }`. The CAS reads it through `rowsChanged` in `@shared/db-utils`, which knows all three. This is not a detail: the gate once read only the top-level fields, which is correct on the bun:sqlite the tests run against and always `undefined` on the D1 production runs. Every production refresh therefore deleted its session, skipped the replacement INSERT, and answered `400 invalid_grant` — sessions died at the first refresh after five minutes, and no prod session row ever had `last_used_at` move past `created_at`. Any new rows-affected check must go through the same helper.

The client complements this with a shared single-flight (`osn/client`): the bootstrap and refresh paths dedupe the `/token` grant against each other so a bootstrap racing a refresh in one tab fires `/token` once. That holds across the whole page because the page builds one auth service (§Renewal in the browser). Cross-*tab* coordination (a Web Locks guard) is a possible follow-up; the server grace already prevents cross-tab races from revoking the family, and the client retries a grant that lost the race (below).

## Renewal in the browser

Every authenticated request a Musubi page makes goes through one `authFetch`, the one on the page's `createOsnAuthRuntime` (`osn/client/src/runtime.ts`). The runtime is a `ManagedRuntime` over a single `OsnAuth` service, so the session cache and every single-flight guard exist once per page; `AuthProvider` takes the same runtime and every `create*Client` is built with its `authFetch`. No component or client holds an access token.

What `authFetch` does with each request (`osn/client/src/service.ts`):

1. **Checks the URL.** The token goes only to the issuer's origin. Any other URL, a relative one included, is refused with a `TypeError` before anything is read or sent.
2. **Checks the stored account.** If it is gone (another tab signed out, or saw the session end), or carries another sign-in's id (another tab signed out and someone signed in since), the session ends here too, with no request; a new sign-in's stored account is left alone. The runtime runs the same check on every `storage` event for the key, so another tab's sign-out ends this page's session at once. Nothing else is taken from storage: tokens live only in each page's memory, so each tab renews for itself, and each acts as the profile its own screen shows ([[identity-model#Client Storage Model]]).
3. **Renews before sending.** A token within `min(30 s, half its lifetime)` of expiry (lifetime from its own `iat`/`exp`; 30 s when it has neither) is renewed first, so an expired token never leaves the page. The grant names the active profile (`profile_id` on `POST /token`), and the issuer mints for it while the cookie session's account owns it, bound to the rotated session — one request, no `/profiles/switch`. A renewal joins a grant already in flight and keeps its token when that grant minted for the same profile; otherwise it sends its own once that one settles, so two grants of one cookie never overlap. A profile switch that lands while a renewal is out stays: the renewal's token is stored for the profile it named, and the request that needed it goes out as that profile, the one it was made as.
4. **Sets `Authorization` itself**, whatever the caller passed, and sends.
5. **On a 401, renews once and retries.** A second 401 ends the session.

How a failed renewal ends:

| What happened | Result |
|---|---|
| `/token` refused the grant (any 4xx but 429, except the case below) | session ended: cache and stored account cleared, `AuthProvider` set to signed out, the host told through `onSessionChange` (`ended`), the call rejects with `AuthExpiredError`. Musubi says so: "You've been signed out." with Sign in, once however many calls failed ([[social#Auth]]) |
| `/token` answered `400 invalid_grant` and the body's `message` names the rotation race or a `DatabaseError` (the two failures `osn/api/src/lib/grant-failure.ts` reads as "status unknown") | one retry after 250 ms; a second such answer counts as transient. The `osn_has_session` marker plays no part: other origins can write it |
| `/token` answered 429 | no retry; transient, as below, with the pause set from `Retry-After` when it gives whole seconds (at most 60 s) |
| `/token` 5xx after the backoff ladder (3 attempts), or unreachable (2 attempts) | session kept; transient, as below |
| `/token` minted for the default profile although another was named | the account does not own the named profile: the default profile becomes active, `AuthProvider` refetches the session from cache, the call rejects with `ActiveProfileResetError`; nothing is sent as the wrong profile. If the page switched to another profile while the grant was out, that profile stays active and nothing is reset. A session of an account scheduled for deletion is refused instead, as in the first row ([[#Endpoints]]) |
| `/token` answered a token that names no profile (`sub`) | transient; the token is not stored |
| any answer, once the session the renewal was for was replaced or ended on this page (a sign-in adopted, a log out, the session ended) | nothing stored, reset or ended, no listener told; the call rejects with `AuthExpiredError`. The session the page holds now is untouched, and so is its renewal pause |
| any answer, once another tab has stored another sign-in, or none, and this page has not yet heard of it | nothing stored; this page's session ends as that tab's storage event would end it (`ended` told, the other sign-in's stored account kept); the call rejects with `AuthExpiredError` |

A transient failure keeps the session and the active profile. If the token in hand has not expired yet, the request goes out with it; otherwise the call rejects with `TokenRefreshError`. Renewal then pauses: until the pause ends, a call that needs a renewal sends no grant. The pause is the 429's `Retry-After`, or else 2 s doubling to 30 s across failures in a row, and a renewal that gets a token ends it.

The runtime tells `onSessionChange` listeners `ended` before the call that asked for the renewal rejects, and it tells them the same when another tab's sign-out or sign-in ends this page's session (step 2). `AuthProvider` therefore drops any profile list that settles after the end, success or failure, so neither the old account's list nor an error about it lands on a signed-out page. A log out from the page itself tells no listener.

`authFetch` rejects with what `fetch` rejected with when the request itself fails or is aborted, as a bare `fetch` does. The REST clients turn that failure into their own `OsnApiError` at status `0`, and pass an abort and the session rejections above (`AuthExpiredError`, `TokenRefreshError`, `ActiveProfileResetError`, `StorageError`) through unchanged (`reach` in `osn/client/src/auth-fetch.ts`). Ending a session never calls `/logout`: a refusal means the issuer has let the session go already, and the marker is the issuer's to retract.

**A session that changes while a request is out.** An answer is applied only for the session it was asked for. The service counts every time the page's session is replaced or ended (`setSession`, `logout` once `/logout` has answered, every `endSession`, another tab's sign-out or sign-in among them once this page hears of it), and each request notes the count when it leaves. When the answer arrives after the count has moved, it changes nothing and reaches no caller: the request is not renewed or sent again, a second 401 ends nothing, and the call rejects with `AuthExpiredError`. A renewal, bootstrap or grant started for the old session is never joined by a caller for the new one, which waits it out and sends its own grant; a grant whose session has gone sends no retry, and a renewal for it neither sets nor clears the renewal pause. Every write an answer makes to the session — a save, or the end on a second 401 — first reads the stored account, and if another tab has stored another sign-in or none since, ends this page's session as the storage event would, rather than write over or remove that tab's account (`superseded` in `osn/client/src/service.ts`). A held session's renewal (`refreshHeldSession`) belongs to no count: the page's session changing does not stop it.

Held sessions stay outside all of this: `Register` and `RecoveryLoginForm` send their tokens through `RegistrationClient` themselves, and the recovery flow renews through `refreshHeldSession` (above).

## Reuse detection across isolates

The C2 reuse detector has to remember, for as long as a session can live
(`refreshTokenTtl`, 30 days unless `OSN_REFRESH_TOKEN_TTL` says otherwise),
which session tokens were rotated out, and every isolate has to see the same
memory. It lives in D1, in `rotated_sessions` (`osn/db/src/schema/index.ts`):

| Column | Holds |
|---|---|
| `token_hash` (primary key) | SHA-256 of the rotated-out token: the `sessions.id` it had |
| `family_id` | The family a replay revokes |
| `account_id` | The account, for erasure (foreign key to `accounts`) |
| `rotated_at` | Unix **milliseconds**, unlike the seconds the rest of the schema uses: whole seconds would shorten the 10-second grace window by up to one |
| `expires_at` | Unix milliseconds, `rotated_at` + the session lifetime. Past it the row proves nothing |

Two indexes: `expires_at`, for the sweep, and `(account_id, family_id)`, for
erasure (by account) and a detected reuse (by account and family).

- **Write.** `refreshTokens` inserts the new session (copying the device and
  any restriction from the old row as it stands), then the old token's record,
  then deletes the old row with its compare-and-swap: one batch on D1, which
  commits whole or not at all, so a session never exists without the record
  that lets reuse detection see its predecessor replayed; one statement at a
  time on bun:sqlite. A failed write is a `DatabaseError`: the grant fails, the
  old row stays and can rotate again (a failed D1 batch rolls back; on
  bun:sqlite the grant deletes its own new row, and its own record when that
  landed before the failure, matched on the token's hash and the grant's
  `rotated_at`, so the device's next grant of the same token can write it
  again), and `POST /token` reads it as "session
  status unknown" and keeps the marker cookie. A clean-up delete that fails too
  is logged at error ([[#Observability]]). A second record for one token fails
  on the key, so of two grants of one token interleaved on bun:sqlite the
  second fails this way, and leaves the first grant's record alone.
- **Read.** `detectReuse` runs only for a token not in `sessions`, and reads its
  live record (`expires_at` later than now). No record: nothing more happens.
  A record inside the grace window: a benign race, family kept. Outside it: one
  batch deletes the family's sessions and its rotation records, so a further
  replay from that chain has nothing left to revoke, and the grant whose delete
  removed the records counts `reuse_detected`. A revoke by handle, and a
  logout with a live token or one rotated out inside the grace window, leave the
  family's records, so a stale replay can find a record whose family has no
  session left; that replay counts as reuse and revokes nothing. A logout with a
  token rotated out past the grace window deletes them, as a replay here does
  ([[#Endpoints]]). A failed read is a
  `DatabaseError` — the grant fails and nothing is revoked, so a storage error
  never passes for "not rotated" and never makes a revocation up.
- **Sweep.** `runRotatedSessionSweep` deletes expired records in chunks of 500,
  at most the tier's chunk count a run — `OSN_ROTATED_SESSION_SWEEP_MAX_CHUNKS`,
  100 on staging and production, 10 where unset (dev) — so a backlog drains over
  several runs, and a run that ends on a full chunk logs the warning
  `auth.session.rotated_sweep ended on a full chunk`. It waits 75 ms
  between two chunks (`ROTATED_SESSION_SWEEP_PAUSE_MS`), never after the last,
  so requests waiting to write run in between ([[retention#Sweeper design contract]]).
  The Worker's 6-hourly `scheduled` cron runs it, and so does the Bun dev
  server's sweeper.
  What it costs in D1 rows: [[free-tier-limits#Cloudflare D1]].
- **Erasure.** Soft delete removes the records of every family it revokes, and
  keeps those of the cancel handle's family, so reuse detection still guards the
  account's one live session through the grace period. Hard delete removes them
  all, before the `accounts` row they reference.
- **Never exported.** The records are security state, not account data
  ([[data-map]], [[retention]]).

## Observability

- `osn.auth.session.operations{action, result}` — one per `list` / `revoke` / `revoke_all` call
- `osn.auth.cire_session.revocations{trigger, result}` — one per request to cire-api's organiser-session revoke, and one per sign-out or connection revoke that sent none because the back-channel is unconfigured (`unconfigured`) or the profile lookup failed (`error`). `trigger` ∈ `sign_out_everywhere` / `connection_revoked`; `result` ∈ `ok` / `rejected` / `timeout` / `error` / `unconfigured`. Span `auth.cire_session.revoke`. Metric export on workerd is deferred, so on deployed tiers the error and warning log lines are the signal; none carries the secret, an account id or a profile id
- Spans: `auth.session.list`, `auth.session.revoke`, `auth.session.revoke_all`, `auth.session.resolve_binding` (the `osn_sid` lookup), `auth.session.classify_caller` (cookie-or-binding "who is calling"), `auth.session.lift_restriction` (a recovery session becoming an ordinary one), `auth.session.check_live` (the live-session gate's read), `auth.session.end_replaced` (a sign-in ending the session its cookie named)
- `Session token reuse: the family's rotation records could not be removed` (error, no cause and no ids) — a logout or sign-in ended a replayed token's family but could not delete its rotation records; a later replay of the token counts the reuse ([[#Endpoints]])
- `Sign-in could not end the session its cookie named` (error, no cause and no ids) — a route that set a new session cookie could not end the family of the one the request carried; the sign-in answered with its cookie all the same ([[#Endpoints]])
- `osn.auth.session.stale_refused{endpoint}` — one per `409 session_stale` from `liveSession` or `liveSessionGate` (passkey registration's complete does not count its own `session_stale`); `endpoint` names the route: its rate-limit name, or a name of its own where two routes share a limiter (`security_event_ack_all`, `session_revoke_others`) or the route has none in the auth set (`account_export`). No attribute names the account, the profile or the session. Metric export on workerd is deferred (englishstreetventures/osn#501) and the gate writes no log line, so on deployed tiers the signal is the route's 409 in Workers Logs, which captures every invocation
- `SecurityInvalidationTrigger` union extended with `session_revoke`, `session_revoke_all`, and `passkey_delete` so the security-invalidation dashboard picks up user-initiated revocations alongside passkey-register, passkey-delete, recovery-code, and email-change triggers
- `osn.auth.session.reuse_detected` / `osn.auth.session.family_revoked` — genuine C2 reuse caught (replay outside the grace window) and the resulting whole-family revocations. `family_revoked` and its warning log `Session token reuse detected — family revoked` count only a revoke that removed a session. `reuse_detected` is counted by the request whose delete removed the family's rotation records, so two requests replaying one token at once count it once; when that request's own delete found no session, it logs `Session token reuse detected — no session of the family was left` at info. Two consequences: such a pair can write both lines for one replay (the warning from the request that removed the sessions, the info line from the one that removed the records), and `family_revoked` can run ahead of `reuse_detected` when a records delete fails, until a later replay of the token counts it. A logout or a sign-in carrying a token rotated out past the grace window counts the same way, with `at logout` or `at sign-in` in both lines ([[#Endpoints]]). Neither counter carries an attribute, and no line names the account, the family or the token. A spike is a real security signal (token theft) — distinct from the benign metric below.
- `osn.auth.session.rotation_race` — benign concurrent/retried grants tolerated within `ROTATION_GRACE_MS` (CAS-0-rows or a rotated-token replay inside the window). The family is PRESERVED. Expected to be non-zero for normal multi-tab usage; it is NOT a security signal. Watch the ratio of `family_revoked` to `rotation_race` — a rise in the former relative to the latter is what matters.
- Spans: `auth.session.rotate` around a refresh, `auth.session.reuse_detect` around the record lookup and any revocation, `auth.session.rotated_sweep` around a sweep. A failed sweep logs `scheduled rotated-session sweep failed` on the Worker
- `osn.retention.rows_deleted{table}` and `osn.retention.cycle.duration{table}` (seconds) — one of each per sweep pass, `table` = `rotated_sessions`, a failed pass included with the rows its earlier chunks deleted
- A rotation record that cannot be written or read is a `DatabaseError` on the grant, in Workers Logs with the rest of osn-api's D1 errors
- `Refresh rotation could not remove its own new session after a failed write` (error, annotated `restricted` = `true` / `false`, never the cause, whose text carries the statement's parameters) — bun:sqlite only: a rotation whose write failed and whose delete of its own new row failed too, leaving a row no one holds until it expires
- `Refresh rotation could not remove its own rotation record after a failed write` (error, annotated the same way, never the cause) — bun:sqlite only: a rotation whose write failed after its record landed and whose delete of that record failed too. The device's token cannot rotate again until the record expires, a refresh lifetime later; deleting the row by `token_hash` frees it
- Redaction: `ipHash`, `uaLabel` (both spellings), `familyId` (already in the deny-list — correlates sessions across rotation events)

## UI

- `@osn/auth-ui/SessionsView` — a settings panel; no app mounts it (#2055). "(this device)" on the current row, each row's "Sign out" (named "Sign out {device}") disabled for current, "Sign out everywhere else" with a synchronous `confirm()` (toast-style undo would leave the stolen-session window open).

**Device / passkey management (#155).** The companion `@osn/auth-ui/PasskeysView` surfaces the *credential* side of device management — list / add / rename / remove passkeys, each destructive operation step-up-gated. It mounts in `@musubi/social`'s Settings Security section. Cire's organiser portal does not mount it: its `SecurityPanel` links to that section instead ([[passkey-primary]] §Surfaces that mount `<PasskeysView>`). New-device help (a backed-up/synced passkey, the cross-device QR ceremony above, or a recovery code) is covered on [[passkey-primary]].

## Threat model

Gives the user a fast lever to react to:

- Lost / stolen device → `Revoke` that specific session.
- Suspected compromise → `Sign out everywhere else` from a known-good device.
- Routine hygiene → surface all devices currently holding a valid cookie.

With 5-min access tokens and rotation-on-refresh, the attacker's window after revocation is under 5 minutes.
