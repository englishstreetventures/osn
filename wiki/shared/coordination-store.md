---
title: Coordination store
aliases:
  - "@shared/coordination"
  - CoordinationStore
  - COORDINATION binding
tags:
  - systems
  - infrastructure
  - auth
  - durable-objects
status: current
related:
  - "[[rate-limiting]]"
  - "[[coordination-store-on-durable-objects]]"
  - "[[sessions]]"
  - "[[free-tier-limits]]"
  - "[[production-deploy]]"
  - "[[shared/observability/metrics]]"
packages:
  - "@shared/coordination"
  - "@osn/api"
last-reviewed: 2026-10-28
---
# Coordination store

osn-api keeps its short-lived shared state in one Durable Object class,
`CoordinationStore` from `@shared/coordination`, bound to the Worker as
`COORDINATION`. Every isolate of the deployed Worker sees the same state:

- the rate limiters no native binding carries: the hour-window auth limiters, the per-account export limiter, the per-IP deletion and restore limiters, and the per-account caps (on the Bun dev server, every limiter);
- the ceremony entries: identified passkey challenges, pending registrations, emailed codes, pending email changes and TOTP enrolments, cross-device requests, parked `/authorize` requests, recovery disown tokens;
- each code ceremony's guess count, kept on its entry;
- the step-up token ids already used, and the discoverable passkey challenges already used, by nonce;
- the three per-account lockout counters (recovery code, emailed recovery code, TOTP);
- the health probe's round trip.

Three things are not in it. Sessions and the record of rotated-out session
tokens live in D1 ([[sessions]]). On a deployed tier the one-minute per-IP auth
limiters and the graph, organisation, recommendation, profile, health-probe,
account-export IP and deletion-status limiters run on Cloudflare's native Rate
Limiting bindings, which need no store ([[rate-limiting]]). A discoverable
passkey challenge carries its own proof and is stored nowhere until it is used
([[#Refusals cost the same, and single use is atomic]]). Why a Durable Object,
one per key, and what it replaced: [[coordination-store-on-durable-objects]].

## The class

[`shared/coordination/src/store.ts`](../../shared/coordination/src/store.ts),
exported as `@shared/coordination/store`, is the only module in the package
that imports `cloudflare:workers`. Each object holds one record, `{ v?, n?, exp }`
— a value, a count, or both, live while `exp` is later than now — in the
synchronous key-value API (`ctx.storage.kv`). That API exists only on
SQLite-backed classes, so the class is declared with `new_sqlite_classes`.

| Method | What it does | Writes storage |
|---|---|---|
| `increment(windowMs)` | With no live entry, starts a window of `windowMs` at 1 and sets the alarm; with one, adds 1 and leaves the window's end where it was. Returns the count | Yes |
| `count()` | The live count, or 0 | No |
| `read()` | The live value, or `null` | No |
| `write(value, ttlMs)` | Replaces the entry for `ttlMs`. A TTL at or below zero removes the entry instead | Yes |
| `remove()` | Deletes the entry and its alarm. `true` only if a live entry was there | Only when an entry exists |
| `claim(ttlMs)` | Stores a marker for `ttlMs` if there is no live entry. `true` only for the caller that stored it | Only when it wins |
| `guess()` | With a live entry, adds 1 to its count and answers `{ value, n }`, the value and the count after this guess; the expiry stays. With none, counts nothing and answers `{ value: null, n: 0 }`. `write` starts the count again; `remove` and `take` clear it with the value | Only when an entry exists |
| `take()` | The live value, removed in the same call, or `null`. Of two takes at once, one gets the value | Only when an entry exists |
| `swap(expected, value, ttlMs)` | Replaces the live value with `value` for `ttlMs` only if it is `expected` (`null`: only if there is no live value), restarting the count; `true` only then. Of several swaps from one value, one wins. A swap that does not match rewrites a live entry unchanged — value, count and expiry — and leaves an empty object empty | Only when an entry exists or it wins |
| `alarm()` | Empties an expired object; if a later write replaced the entry, sets the alarm again for the new expiry | Only when it deletes |

Each method reads and writes the entry with no await between, and deletes it
before awaiting the alarm's removal, so every call is atomic against every
other call on the same object without relying on input gates. A window or TTL must be
a whole number of milliseconds from 1 to 31 days (`MAX_TTL_MS`); anything else
is refused with a `RangeError` and nothing is written. An error names the bad
argument, never the object.

**Windows are fixed.** A window starts at its first hit and ends `windowMs`
later, whatever happens in between. A burst at the boundary can reach twice the
limit, as with every limiter here ([[rate-limiting#Known Limitations]]).

**Expiry is exact on read.** Every method checks `exp` against the clock, so an
entry is gone the moment it expires. The alarm, set at `exp`, then deletes it so
the object stops holding storage. A later write moves the alarm; an alarm that
finds a newer entry sets itself again rather than deleting it.

## One object per key

[`shared/coordination/src/client.ts`](../../shared/coordination/src/client.ts)
names no Workers type, so Bun code imports it too. A caller builds a client for
one namespace:

```ts
const client = createCoordinationClient(env.COORDINATION, { namespace: "step_up_jti", onError });
await client.claim(jti, ttlMs); // calls the object named "step_up_jti:<jti>"
```

- **The object's name is `<namespace>:<key>`.** A namespace matches
  `/^[A-Za-z0-9_.-]{1,64}$/` and so never holds `:`, which means two
  (namespace, key) pairs never share an object. A bad namespace throws when the
  client is built.
- **A key longer than 256 characters is refused before any call** (`MAX_KEY_LENGTH`).
  The client throws a `RangeError`; a limiter denies.
- **One object per key, not per namespace.** A hot key loads only its own object,
  and no call spans two keys.
- **Every object is asked to live in Oceania.** The client gets every stub with
  `{ locationHint: "oc" }` (`COORDINATION_LOCATION_HINT`), retries included.
  Cloudflare honours a hint on a best effort, only when the object is first
  created, and never moves an object afterwards
  ([data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)).
  So every object, whoever creates it, is placed in a data centre Cloudflare
  chooses in its Oceania region, beside the D1 databases. A caller outside
  Oceania pays the trip there on every call, which is why the ceremonies keep
  their sequential calls few ([[#Cost]]). Why it is pinned:
  [[coordination-store-on-durable-objects#Where the objects live]].
- **The client caps every window and TTL at 31 days** before the call, so the
  store refuses only a duration that is not a whole number above zero. A `write`
  with a TTL at or below zero removes the entry instead.

osn-api's namespaces form a closed union, `CoordinationStoreName`, in
[`osn/api/src/lib/coordination/names.ts`](../../osn/api/src/lib/coordination/names.ts):
eleven ceremony stores (`reg_challenge`, `login_challenge`, `pending_registration`,
`step_up_challenge`, `step_up_otp`, `pending_email_change`, `cross_device`,
`pending_totp_enroll`, `pending_recovery_otp`, `recovery_disown`,
`oidc_authorize_request`); the three lockouts (`recovery_lockout`,
`recovery_otp_lockout`, `totp_lockout`); `step_up_jti`;
`passkey_challenge_claim`; `health_probe`; and one per limiter, named in the budget table
in `osn/api/src/routes/auth/limiters.ts` (`auth.<endpoint>` for the auth
limiters, `account.export`, `auth.profile_switch_cap` and the like for the rest).
The same name is the `store` attribute on every metric and log line, so a store
outside the union cannot be built, measured or logged.

## Retries

A call that fails is tried a second time only when all of these hold:

- it is a `read` or a `count`, the two calls that change nothing;
- the runtime marked the error `retryable`;
- the runtime did not mark it `overloaded`, where a retry adds to the load.

The second try takes a fresh stub, since one that has thrown may stay broken.
Every other failure reaches the caller at once: a write, claim, increment,
remove, guess, take or swap that failed may still have landed.

Each failed call, after any retry, reaches the client's `onError(store, op, { retried, durationMs, kind })`
once — the namespace, the operation and the failure's kind, never the key, a
value or the error's message. `kind` comes from the runtime's flags on the
error, then its class: `overloaded`, `reset` (the object restarted mid-call),
`retryable`, `invalid_input` (a `RangeError` from the object) or `other`.

## What each consumer does when a call fails

Every consumer fails closed. The mapping lives in
[`osn/api/src/lib/coordination/durable.ts`](../../osn/api/src/lib/coordination/durable.ts):

| Consumer | Calls | When the call fails |
|---|---|---|
| Rate limiters and per-account caps | `increment` | Denied, as if over the limit: the route refuses, with 429 where it answers one |
| Ceremony `set` / `get` / `delete` / `consume` | `write` (JSON) / `read` / `remove` / `remove` | The call rejects; `storeCall` turns it into a `CoordinationError`, which the route answers with a generic 503 (`osn/api/src/lib/public-error.ts`) |
| Ceremony `guess` / `take` / `swap` | `guess` / `take` / `swap` (JSON), on the entry's own object | The same 503 |
| Step-up token guard | `claim` | The token is refused as "could not be verified", and is not counted as a replay |
| Discoverable passkey challenge claims | `claim` | The same 503 |
| Lockouts, `status` / `recordFailure` | `count` / `increment` | Answers `"unknown"`. Every caller refuses with its generic error and writes no security event; a failure that could not be counted shows as `result="unavailable"` on the factor's lockout metric |
| Lockouts, `reset` | `remove`, only when the lookup on the way in counted a failure; on the recovery-code and TOTP routes it runs after the answer | Swallowed; the counter expires with its window |
| Health probe | `write`, `read`, `remove` | `GET /health/coordination` answers 503 |

A ceremony value that does not parse as JSON reads as absent, which sends the
user back to `begin`: this store is its only writer, so such a value is
truncated or foreign.

A key over 256 characters never reaches a call. The routes that key an entry
by what the caller typed — passkey sign-in by the identifier, registration by
the address — refuse one over 255 characters, longer than any account holds,
as bad input (400); a disown token whose lookup id is not the shape the server
mints is a wrong token, answered with that route's uniform 202.

## Refusals cost the same, and single use is atomic

- **Guesses are counted atomically.** Every code-checking ceremony — step-up
  OTP, the emailed recovery code, TOTP enrolment, email change, registration —
  reads its entry and counts the guess on it in one `guess` before it compares
  the code, so guesses sent at once each take their own number and no guess can
  read the entry and count from a number it no longer has. `begin`'s `write`
  (registration's `swap`) starts the count at 0. A right code claims its entry with `remove`, so of two
  right codes exactly one wins. The life of a count is set out in
  `osn/api/src/services/auth/attempts.ts`.
- **A WebAuthn challenge is used once.** Passkey sign-in with an identifier,
  passkey registration and step-up by passkey `take` their challenge, so of two
  presentations of one assertion sent at once only one reaches verification.
  A discoverable sign-in's challenge is 16 random bytes, an expiry and an
  HMAC-SHA256 over both (`osn/api/src/services/auth/server-mac.ts`): `begin`
  stores nothing, and `complete` requires the challenge in `clientDataJSON` to
  be the `challengeId` the client sent, opens it, verifies the signature, then
  `claim`s the nonce on `passkey_challenge_claim` for a challenge's whole life
  plus a minute (`CHALLENGE_TTL_MS` + `CHALLENGE_CLAIM_MARGIN_MS`, three
  minutes), counted from the claim. The claim so outlives every moment an
  isolate could still accept the challenge, whatever its clock or the store's
  says. A changed byte, another key's challenge, an expired one or a lost claim
  is refused.
- **Refusal paths make the same store calls whatever the identifier.** The
  unauthenticated routes that take an identifier pad a branch that names no
  account with the same operations, on the same store, at the caller's probe
  key: recovery by code, by emailed code and by TOTP
  ([[account-recovery-factors]], "The oracle moves to `complete`";
  [[recovery-codes]]), passkey sign-in `begin` (one `write`) and registration
  `begin` (one `swap` from nothing, which also keeps a pending code from being
  replaced by a second `begin`, however the two overlap). So the branches cost
  the same and, while the store fails, fail together. The probe key is `prb_` and 12 hex digits of
  an HMAC-SHA256, under `OSN_SESSION_IP_PEPPER`, of the normalised
  identifier — the length of an account id, and not something a list of
  addresses can be run through. A new unauthenticated route that takes an
  identifier, or a new store call on one of these routes, joins this list in
  the same pull request, with a case in `recovery-op-sequence.test.ts` or
  `begin-op-sequence.test.ts` that compares its branches, including the
  failing-store case.

## Wiring

| Runtime | Bundle | Built by |
|---|---|---|
| Deployed Worker (dev, staging, production) | `createDurableCoordination(env.COORDINATION, onError)` | `buildAll` in `osn/api/src/index.ts`, once per isolate |
| `wrangler dev` (local tier) | The same, on Miniflare's local Durable Objects | The same |
| Bun dev server, OpenAPI generator, tests | `createInMemoryCoordination()` — the same interfaces, in this process's memory, reset on restart | `osn/api/src/local.ts`, `scripts/generate-openapi.ts` |

- **The Worker's module is `osn/api/src/entry.ts`.** It exports the
  fetch/scheduled handler from `index.ts` and the `CoordinationStore` class, so
  Bun code that imports `index.ts` never loads `cloudflare:workers`.
  `osn/api/tsconfig.entry.json` checks it against the Workers types.
- **Every tier needs the binding.** `fetch` answers 503 `Worker misconfigured:
  missing COORDINATION` without it, `local` included: no per-isolate stand-in is
  safe to run instead.
- **Production and staging** declare the binding in `osn/api/wrangler.toml`,
  top level and in each named environment (named environments inherit no
  binding), with one migration, `tag = "v1"`, `new_sqlite_classes = ["CoordinationStore"]`.
  Never edit `v1`; a renamed or removed class needs a new tag.
- **Dev** declares `COORDINATION: { kind: "durable-object", className: "CoordinationStore" }`
  in `musubi/infra/src/declaration.ts`. Alchemy hosts the class on the Worker
  through the upload's `exports` map, SQLite-backed, and the stack's K10 test
  fails if `entry.ts` stops exporting it ([[infrastructure-as-code]]).
- **Failed calls are logged once**, through the app runtime `buildAppDeps`
  builds, by the reporter it passes to the bundle builder.

## Cost

Cloudflare bills a Durable Object by requests, duration and SQLite rows
([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)):
each RPC call is one request, and so is each alarm invocation; each
`setAlarm()` is one row written; deletes count as rows written; key-value
calls are billed as rows read and written. The client takes a fresh stub for
every call, so every call is one request.

| Call | Requests | Rows written |
|---|---|---|
| `increment`, first hit of a window | 1, and 1 more when the alarm fires | about 2 (the entry and the alarm), and about 1 more when the alarm deletes the entry |
| `increment`, later hit | 1 | about 1 |
| `count`, `read` | 1 | 0 |
| `write` | 1, and 1 more when the alarm fires | about 2, and about 1 at expiry |
| `remove`, entry present | 1 | at least 1 |
| `remove`, nothing there | 1 | 0 |
| `claim`, won | 1, and 1 more when the alarm fires | about 2, and about 1 at expiry |
| `claim`, lost | 1 | 0 |
| `guess`, entry present | 1 | about 1 |
| `guess`, nothing there | 1 | 0 |
| `take` | as `remove` | as `remove` |
| `swap`, won | 1, and 1 more when the alarm fires | about 2, and about 1 at expiry |
| `swap`, lost on a live entry | 1 | about 1 (the entry, rewritten unchanged) |
| `swap`, lost on nothing | 1 | 0 |

An entry removed before it expires has no alarm left to fire. A request through
an hour- or day-window limiter costs one `increment`; `GET /health/coordination`
costs three calls. A token refresh costs no Durable Object call: its rotation
record is a D1 row ([[sessions#Reuse detection across isolates]]).

Sequential calls per request, which is what a caller far from Oceania waits
for (counted from the code, 2026-10-28):

| Route | Calls |
|---|---|
| Code `begin` (step-up OTP, TOTP enrolment, email change, recovery email) | 1 `write`, after any cap or limiter |
| Registration `begin` | 1 `swap`, after a D1 collision probe |
| Code `complete`, success | 1 `guess`, then the claim; registration and email change instead delete the entry once their commit lands, after the answer |
| Recovery code sign-in, success | 1 (the lockout lookup); the reset runs after the answer, and only when the lookup counted a failure |
| TOTP step-up or TOTP recovery, success | 1 (the lockout lookup, beside the credential read); the reset as for a recovery code |
| Passkey sign-in, identified: `begin` / `complete` | 1 / 1 (`take`) |
| Passkey sign-in, discoverable: `begin` / `complete` | 0 / 1 (`claim`, only once the signature verifies) |
| Step-up passkey, passkey registration `complete` | 1 (`take`) |
| Cross-device: `begin` / poll / `approve` or `reject` | 1 (`write`) / 1 `read`, then a `take` once the request is approved / 2 (`read`, then `swap`) |
| Recovery email `complete`, any refusal | 3 calls in 2 hops (the lockout lookup and the guess side by side, then the failure record) |
| Recovery code sign-in, any refusal | 2 (the lockout lookup; then the failure record, beside the D1 read that classifies the refusal) |

*Counted from the code on 2026-10-28 (`shared/coordination/src/store.ts`, `client.ts`, and the services under `osn/api/src/services/auth/`) against the pricing page's billing rules, not measured. The pricing page does not say how `deleteAlarm()` or `deleteAll()` are billed beyond "deletes are counted as rows written".*

**Plans.** The production account is on **Workers Paid**: no daily cap, 1
million Durable Object requests a month included, then $0.15 a million. The dev
account is on **Workers Free**: 100,000 requests and 100,000 rows written a day,
shared with cire's realtime hub. Once dev spends either, every further call
fails until 00:00 UTC, so dev's limiters deny, its ceremonies answer 503 and
dev sign-in stops until the reset. The ceilings and how to watch them are in
[[free-tier-limits#Cloudflare Durable Objects]].

## Observability

| Signal | What it carries |
|---|---|
| `osn.coordination.store.operations{store, op, result}` | One count per call an object answers or fails, retries included. `store` is a `CoordinationStoreName`, `op` one of the nine calls, `result` `ok` or `error` |
| `osn.auth.ceremony_store.operations{namespace, op, backend}` | One count per ceremony `set`, `get`, `delete` (a `consume` counts as one), `guess`, `take` or `swap`; `backend` is `memory` or `durable_object` |
| `osn.auth.recovery.lockout{result="unavailable"}`, `osn.auth.totp.lockout{result="unavailable", scope}` | A refusal because the store could not update a lockout counter or, for TOTP and the emailed recovery code, read one |
| Log `coordination store call failed` | One line per failed call, after any retry, with `store`, `op`, `durationMs`, `retried` and `kind` |

No attribute or log field carries a key, an IP, an account id or a stored value.
The counters record nothing on workerd until englishstreetventures/osn#501
lands; there, read the log line in Workers Logs, and latency and request counts
on the `CoordinationStore` namespace in the Cloudflare dashboard (Workers &
Pages, Durable Objects).

## The health probe

`GET /health/coordination`
([`osn/api/src/routes/health-coordination.ts`](../../osn/api/src/routes/health-coordination.ts))
writes a random value under a fresh random key on the `health_probe` store,
with a 60-second TTL, reads it back and removes it. It answers 200 `{ "ok": true }`
when the value reads back unchanged and the remove finds it, and 503
`{ "ok": false }` otherwise, with `cache-control: no-store`.

- It answers only a caller sending `Authorization: Bearer <INTERNAL_SERVICE_SECRET>`:
  401 without it, 501 where the secret is unset, and neither touches the
  limiter or the store. Each probe costs three calls from the allowance every
  sign-in shares, so it is not public.
- It takes no input, so it can only ever touch its own entries.
- Behind the secret, a per-IP limiter allows 10 calls a minute
  (`OSN_RATE_LIMITS.healthCoordination`), on the `RL_AUTH_IP_10_60` binding on
  a deployed tier. An IP that cannot be resolved is refused with 429.
- It is left out of the OpenAPI document, like `/health`.
- `/health` touches no store, so this is the probe that shows a deployed Worker
  can reach the store. The post-deploy smoke check asks it on production and on
  dev, with the secret from the job's Environment; a 401 fails the check
  without a rollback ([[production-deploy#7. Post-deploy verification (smoke checks)]]).

## Rollback and the first release

The release that first creates `CoordinationStore` on a Worker is a Durable
Object class lifecycle change, and Cloudflare blocks a rollback across one
([rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)).
If that release's smoke check fails, its rollback request is refused, the step
reports `Rollback failed`, and the fix is forward: redeploy a fixed commit. A
later release that keeps the class rolls back as any other does. The release
steps are in [[production-deploy#The coordination store's first release]].

## Tests

| File | What it proves |
|---|---|
| `shared/coordination/tests/d1/store.test.ts` | The class on workerd: windows, concurrency, expiry, alarms, refusals, `guess`, `take` and `swap` under concurrency, state across a restart |
| `shared/coordination/tests/client.test.ts` | Naming, the location hint on every stub, the key-length refusal, the namespace rule, the retry rule, the failure kind, the limiter's fail-closed answer |
| `osn/api/tests/services/attempt-counting.test.ts` | Each code ceremony under a burst of guesses, and two right codes at once, on both bundles |
| `osn/api/tests/services/single-use-challenges.test.ts` | Two presentations of one WebAuthn challenge at once: one succeeds, at all four sites; every refusal of a discoverable challenge |
| `osn/api/tests/services/recovery-op-sequence.test.ts`, `begin-op-sequence.test.ts` | Each padded route's branches make the same store calls (and, for recovery codes, D1 statements), and fail together while the store is down; two registration `begin`s at once for one address send one code |
| `osn/api/tests/lib/coordination/durable.test.ts` | Each consumer's mapping and failure posture, and that no metric or log carries a key or value |
| `osn/api/tests/lib/coordination/budgets.test.ts` | Both bundles let each limiter's budget through and refuse the next hit, each limiter on its own store |
| `osn/api/tests/lib/native-rate-limiters.test.ts` | Every native limit in `wrangler.toml` equals its budget, and the `v1` migration creates the class the served module exports |
| `osn/api/tests/d1/worker-e2e.test.ts` | osn-api's deployed bundle on workerd with the binding: single-use step-up tokens and codes, an hour-window limiter across a restart, a lockout, reuse detection. Writes `e2e-artifacts/osn-api-workerd/results.json` ([[testing-patterns#The D1 integration lane]]) |

## Source files

- [shared/coordination/src/store.ts](../../shared/coordination/src/store.ts) — `CoordinationStore`
- [shared/coordination/src/client.ts](../../shared/coordination/src/client.ts) — `createCoordinationClient`, `createCoordinationRateLimiter`, `MAX_KEY_LENGTH`, `MAX_TTL_MS`
- [osn/api/src/lib/coordination/](../../osn/api/src/lib/coordination/) — the `CoordinationStores` bundle, its durable and in-memory builders, store names, the health probe
- [osn/api/src/services/auth/store-call.ts](../../osn/api/src/services/auth/store-call.ts) — `storeCall`, a store call as an Effect failing with `CoordinationError`
- [osn/api/src/services/auth/attempts.ts](../../osn/api/src/services/auth/attempts.ts) — guess counting
- [osn/api/src/services/auth/server-mac.ts](../../osn/api/src/services/auth/server-mac.ts) — probe keys and the discoverable challenge's MAC
- [osn/api/src/entry.ts](../../osn/api/src/entry.ts) — the Worker's module
- [osn/api/wrangler.toml](../../osn/api/wrangler.toml) — the binding and the `v1` migration
