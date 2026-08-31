# @osn/osn

## 3.20.29

### Patch Changes

- 3b668c4: P-C1 (osn-tracker#589) — `GET /recommendations/connections` threw for any
  caller with more than 50 accepted connections. The friends-of-friends fan-out
  bound the caller's connection ids twice, once per edge direction, and D1 caps
  a query at 100 bound parameters — 51 accepted connections already produced
  102 binds and threw `D1_ERROR: too many SQL variables` in production.

  Fixed by binding `profileId` instead of the id list: the fan-out now reads
  the caller's own accepted edges through a correlated `IN (<subquery>)`
  rather than pasting them in as literals, so the bind count is fixed
  regardless of how many connections the caller has. Measured on real
  (Miniflare/workerd) D1: a correlated `EXISTS` was tried first and rejected
  (it planned as a full scan of the whole `connections` table); the
  `IN (<subquery>)` shape uses the same indexes the original query did and
  reads 484 rows against the old shape's 400 for an identical 40-connection
  result set.

  `osn/api/src/d1-integration.test.ts` had a characterisation test pinning the
  broken behaviour (added on the parent branch); it now asserts the call
  succeeds with a connection count well past the old cliff and returns the
  correct friend-of-friend candidates.

  Security review of that fix found a regression it introduced (S-H1): the
  fan-out's new seed subquery reads `connections` live, in its own D1 round
  trip, separate from the earlier snapshot `suggestConnections` takes of the
  caller's own edges — a window the old, single-snapshot query could not open.
  A connection the caller accepted from a second in-flight request, in that
  window, was misclassified as a suggestion candidate rather than a mutual
  connection, so the caller's own brand-new connection could come back as
  "someone you may know." Fixed by re-checking, fresh, against `connections`
  and `blocks` immediately before hydration, for just the ids that survived
  ranking (at most 50) — bound once per query via the same `IN (<subquery>)`
  shape, 53 params measured against real D1, not the 102 a naive two-sided
  `inArray` would cost at that size.

- 423dbd5: Connection recommendations (`GET /recommendations/connections`):

  - **Fixed** (osn-tracker#574): the organisation co-member fan-out was one query
    bounded by a single global row cap, ordered by organisation id — so whichever
    organisation the caller happened to belong to sorted first absorbed the whole
    budget, and every other organisation contributed nothing, permanently (50
    organisations of 250 members each, only ~8 ever won). The fan-out is now a
    `UNION ALL` of a per-organisation subselect each bounded by its own share of
    the budget, so every organisation the caller belongs to contributes
    candidates.
  - **Fixed** (osn-tracker#589, P-C1 — the fix above's own regression): that
    `UNION ALL` was one statement for up to 50 organisations, which throws on
    real D1 for any caller in 6 or more — D1 runs on workerd's embedded SQLite,
    capped at 5 terms in a compound `SELECT`, not the 500-term default
    `bun:sqlite` (and the original comment) assumed. The fan-out now runs in
    batches of at most 5 organisations per statement, executed concurrently and
    merged in application code, so a caller in any number of organisations up to
    the 50-organisation cap gets a result instead of a 500.
  - Added `generatedAt` (ISO 8601) to the response, alongside `suggestions`, so a
    client can tell how fresh a list is (osn-tracker#311, timestamp half only —
    the cache half is a separate, undecided change). `@osn/client`'s
    `suggestConnections` return type carries the new field.

## 3.20.28

### Patch Changes

- e38d6de: Email change and registration now correctly tell a real database fault apart from a genuine duplicate-address conflict, and a rate-capped account can no longer learn whether an email address is taken by watching which check fails first.
- Updated dependencies [e38d6de]
- Updated dependencies [e9ba055]
  - @osn/db@0.20.10
  - @shared/redis@0.4.6
  - @shared/crypto@0.10.13

## 3.20.27

### Patch Changes

- 5c51a23: Enforce foreign keys on `bun:sqlite`, and fix the two erasure bugs that were hiding behind it.

  SQLite defaults `PRAGMA foreign_keys` to **OFF** while D1 enforces them, so every local run and every test accepted writes production rejects. The cheap, fast environment was the permissive one, which is the worst way round: a statement that orphans a row, or deletes a parent before its children, passed the whole suite and would have failed on deploy.

  Turning it on found `hardDeleteAccount` broken in two ways, both of which would make GDPR Art. 17 erasure throw rather than complete. It deletes the `accounts` row while deliberately keeping `security_events` and `email_changes` under Art. 6(1)(c) — but both declared a foreign key to `accounts`, so a column documented to outlive its parent referenced it. Those two constraints are dropped. It also deleted `users` before the `oauth_consents` and `oauth_authorization_codes` rows that carry a `profile_id` referencing them; those deletes now run first.

  `dev-login`'s provisioning batch declared itself infallible through `Effect.promise` while being a chain of inserts that reference rows an earlier `onConflictDoNothing` may have skipped. With foreign keys on, that arrived as a defect and escaped the route's own error handling, answering 400 where the contract says 500 `provisioning_failed`.

- Updated dependencies [5c51a23]
  - @shared/db-utils@0.6.4
  - @osn/db@0.20.9
  - @shared/crypto@0.10.12

## 3.20.26

### Patch Changes

- 965c2ee: Hardened the email-change ceremony against a race where two accounts complete
  a change to the same address at once. The database-uniqueness check now only
  catches a genuine UNIQUE-constraint violation, so any other write failure
  correctly surfaces as a database error instead of being folded into the same
  generic message. When a change loses that race, its now-stale pending entry
  is deleted rather than left behind. The write path's pre-check now reads
  only the one column it needs from the account.

  Metrics gained a `metricResult` override: an error can now name its own
  outcome bucket directly, taking precedence over the usual message-keyword
  classification. This lets the email-change conflict path report as
  `conflict` instead of `validation_error`. `@shared/observability` exports its
  `RESULT_VALUES` runtime tuple alongside the existing `Result` type so
  downstream packages can build this kind of override without redefining the
  set of allowed outcomes.

- Updated dependencies [965c2ee]
  - @shared/observability@0.13.6
  - @shared/crypto@0.10.11
  - @shared/email@0.4.10
  - @shared/turnstile@0.2.13

## 3.20.25

### Patch Changes

- Updated dependencies [e382c40]
  - @shared/crypto@0.10.10

## 3.20.24

### Patch Changes

- 0f7d0e1: Halve the rows the connection-suggestion fan-out reads, and stop it labelling a suggestion with an organisation that no longer exists.

  `suggestConnections` fanned out to up to 2,000 organisation co-members and joined `organisations` on each row — a primary-key probe per membership row, so roughly 4,000 rows read where the query needed 2,000. D1 bills rows read. The fan-out now selects ids only, and the organisations that survive ranking (at most 50, usually far fewer) are hydrated in the same concurrent step as the profiles, so the request costs no extra round trip.

  The fan-out also gains `ORDER BY (organisation_id, profile_id)`. That pins what was left to the planner rather than fixing an observed problem: SQLite already walked `org_members_pair_idx` in exactly this order, so the plan is identical either way and no behaviour changes today. The index is UNIQUE on those two columns, so the ordering is its own and adds no sort.

  A candidate whose only basis was a shared organisation, and whose organisation has since been deleted, is now dropped rather than returned claiming `shared_organisation` with nothing to name — which is what the removed inner join used to do.

## 3.20.23

### Patch Changes

- 31008a2: Cover the `/authorize` error page's copy and its own-property guard with
  tests: each known error code now has its rendered wording pinned, an
  unrecognised code is checked against its fallback text, a code named after a
  built-in `Object.prototype` member (`constructor`) is checked against
  leaking that built-in's own string form, a property planted on
  `Object.prototype` is checked against being read as copy, and the
  `rate_limited` variant is now exercised end to end through the route when
  its rate limiter denies a request. `renderAuthorizeErrorPage` is exported
  from `oidc.ts` so the unit-level cases can call it directly; its behaviour
  is unchanged.

## 3.20.22

### Patch Changes

- 93b8474: Fix `publicError`'s `_tag` walk to stop charging the 512-node traversal budget for primitive property values, so a wide chain of string fields no longer exhausts the budget before a real tagged error is found and misreported as a 400. Also replace the queue's `Array#shift()` with a read cursor, so the walk is linear in the number of nodes visited instead of quadratic.

## 3.20.21

### Patch Changes

- 518bc7d: Stop suppressing `no-await-in-loop` where the awaits do not actually need to be sequential.

  `commitBatch` in `@shared/db-utils` chains its bun:sqlite fallback statements instead of looping over them, keeping the children-first ordering the caller built without disabling the rule.

  In `@osn/api`, the outbound ARC key registration in `outbound-arc.ts` registered with each downstream one after the next; the downstreams are independent and registration is an idempotent upsert, so both calls now go out together and a failure on a configured stack still aborts boot. The NDJSON fan-out in `account-export.ts` reads its response with `for await` rather than a manual reader loop, which also means abandoning the generator cancels the stream instead of leaving the downstream sending a bundle nobody is reading.

  No behaviour change. The one remaining disable is the keyset pagination generator, where each page's cursor comes from the page before it.

- Updated dependencies [518bc7d]
  - @shared/db-utils@0.6.3
  - @osn/db@0.20.8
  - @shared/crypto@0.10.9

## 3.20.20

### Patch Changes

- 7c101b2: Tracker#466–470 — added `Cache-Control` to every authenticated response that
  was missing one: `no-store` on `/token` and `/recovery/generate`, and
  `private, no-store` on the per-user reads (sessions, passkeys, profile list,
  account-deletion status, the graph routes, the recommendation routes). Set as
  the first statement of each handler, above the rate-limit and auth checks, so
  a 401 or 429 carries the header too, not just a 200.

  `/recovery/status` already set `no-store`, but only after its DB read, inside
  a `try` — so a rejection never got it. Moved the existing assignment up
  rather than adding a second one.

## 3.20.19

### Patch Changes

- Updated dependencies [c6d023b]
  - @shared/redis@0.4.5

## 3.20.18

### Patch Changes

- Updated dependencies [8fac137]
  - @shared/crypto@0.10.8

## 3.20.17

### Patch Changes

- ee304e6: Require an `exp` claim when verifying an access or step-up token. `jose`
  validates expiry only when the claim is present, so a token minted without one
  verified for as long as the signing key lived — no expiry, and neither verifier
  looks at token age by any other route. The issuer always sets `exp` (5 minutes
  for access tokens), so requiring it rejects nothing that was ever meant to work.

## 3.20.16

### Patch Changes

- 225fee1: `publicError`'s tag walk reads each own key with a plain property access instead of allocating an `Object.getOwnPropertyDescriptor` per key, which is much faster on the common untagged-error path (tracker#446). `GET /account/security-events` now sets `Cache-Control: private, no-store` (tracker#346).

## 3.20.15

### Patch Changes

- 330ebbd: Fix the three OIDC map-membership guards to use `Object.hasOwn` instead of
  `in`, so an inherited `Object.prototype` key (`constructor`, `toString`,
  `__proto__`) can no longer pass as a real map entry.

## 3.20.14

### Patch Changes

- Updated dependencies [15fe22c]
  - @shared/redis@0.4.4

## 3.20.13

### Patch Changes

- ee195a3: Add missing test coverage: the UNIQUE-constraint conflict branch in
  `completeEmailChange`, and route-level 401 coverage for an expired bearer
  access token on a protected Pulse and Zap route.

## 3.20.12

### Patch Changes

- Updated dependencies [b219759]
  - @shared/db-utils@0.6.2
  - @osn/db@0.20.7
  - @shared/crypto@0.10.7

## 3.20.11

### Patch Changes

- Updated dependencies [7a75d6c]
  - @shared/crypto@0.10.6

## 3.20.10

### Patch Changes

- fe3ee5d: Run the devloop behind portless: named HTTPS hosts instead of ports, and one stack per worktree.

  Every app's `dev` script is now `portless`, which reads that package's own `"portless"` key and runs its real command (`dev:app`) behind the proxy. `@osn/api` answers on `https://id.musubi.localhost`, `@pulse/web` on `https://pulse.localhost`, and so on — twelve port numbers nobody has to remember, and no clash when two things want 4321. The names mirror production hostnames.

  The nesting under a shared parent is load-bearing rather than cosmetic. A WebAuthn RP ID has to be the origin's host or a registrable suffix of it, so passkeys created on `@osn/social` are only verifiable by `@osn/api` if both sit under one parent: `musubi.localhost` and `id.musubi.localhost`, RP ID `musubi.localhost`. Flat names would have put every local passkey out of reach of the API that checks it.

  In a linked worktree portless prepends the branch, so `bun run dev` in two worktrees gives two complete, independent stacks. That is also why no app can be told where its siblings live from a committed `.env` — the answer differs per worktree. The new `@shared/dev-urls` package derives it instead: its `dev-env` launcher fronts each `dev:app`, reads the app's own `PORTLESS_URL`, splits off the shared worktree prefix and TLD, and rebuilds every sibling's origin from them. It exports the same env vars the deployed tiers set (`OSN_ISSUER_URL`, `OSN_RP_ID`, `OSN_ORIGIN`, `PULSE_CORS_ORIGIN`, `PUBLIC_API_URL`, …), so no app source knows portless exists.

  Two posture changes worth naming. `OSN_RP_ID` was the bare `localhost`, which every app on the machine shares; it is now `musubi.localhost`, so a local passkey is scoped to the account family — existing `localhost` passkeys will not resolve and need re-enrolling. And `DEV_LOGIN_RETURN_ORIGINS`, which the Bun devloop left unset (closed: every `return_to` a 400), now carries the same four frontend origins `wrangler.toml` already set for `wrangler dev`. The route still only mounts when `DEV_LOGIN_SECRET` is set.

  `PORTLESS=0 bun run dev` still gives the old fixed-port devloop. The ports the frontends lost from their `dev` scripts moved into their configs behind `devPort()`, which prefers the `PORT` portless assigns and falls back to the old literal, so the bypass keeps working and the four Astro apps do not all land on 4321.

## 3.20.9

### Patch Changes

- 1d09efd: Narrow the `listMembers` service projection to `{ id, handle, displayName }`.

  The service selected and returned `avatarUrl`, `createdAt` and `updatedAt` as
  well, and its only caller — the `GET /organisations/:id/members` route — never
  used them: the route already gates on membership and already projects the wire
  response down to `handle` and `displayName`. So nothing leaked; this is
  defence in depth. Handing back four unused fields meant a future route that
  spread the profile object instead of projecting it would widen the response
  without anyone noticing. `id` stays, because clients need it to call
  `removeMember` and `updateMemberRole`. The wire contract does not change.

- 1d1d9b4: Drop the duplicate session SELECT in the token-refresh path: `verifyRefreshToken` now returns the device metadata from the row it already loaded, and `refreshTokens` carries it onto the rotated-in row instead of re-reading the same session by primary key.

## 3.20.8

### Patch Changes

- 2440ea9: Derive a signed token's `exp` from the same clock read as its `iat`.

  Both ARC tokens (`signArcToken`) and OSN access/step-up tokens (`signToken`)
  called `setIssuedAt()` — which takes its own `Date.now()` — and then computed
  the expiry from a second, later read. A token minted across a second boundary
  therefore carried `exp - iat = ttl + 1`, a lifetime nobody configured, and made
  `@shared/crypto`'s TTL assertion fail intermittently in CI.

- Updated dependencies [2440ea9]
  - @shared/crypto@0.10.5

## 3.20.7

### Patch Changes

- Updated dependencies [60e9c51]
  - @shared/observability@0.13.5
  - @shared/crypto@0.10.4
  - @shared/email@0.4.9
  - @shared/turnstile@0.2.12

## 3.20.6

### Patch Changes

- d4553ed: Clear every `anti-slop/no-chained-type-assertions` hit in application source and
  raise the rule from `warn` to `error`. A double assertion — `x as unknown as T` —
  tells the compiler to stop checking, so each of the 32 sites was either a type
  that could be stated honestly or a claim that was no longer true.

  Most were the second kind. `buildAppDeps` and `selectEmailLayer` now name the
  env vars they read instead of taking a loose string record, so the Workers `env`
  binding passes structurally with no cast at all. `UpstashLike` mirrors the
  `@upstash/redis` mutable array signature and the wrapper copies on the way in.
  `FLAGS` is widened once on the way out of the registry, which removes three
  casts and a `Widen` round-trip at every call site. `commitBatch` probes for
  `.batch()` with a type guard rather than asserting the driver has one.

  One was a live bug: `pulse/web`'s create-event form cast a `Date` to `string`
  and relied on `JSON.stringify` to serialise it on the way out. It now calls
  `toISOString()` where the conversion happens.

  Test files still hold 161 hits — mostly a fixture cast to the shape under test —
  so the rule stays off in the test override.

- 587f561: Clear every `anti-slop/no-conditional-empty-object-spread` hit in application
  source and raise the rule from `warn` to `error`. A `...(cond ? { k: v } : {})`
  inside an object literal hides an omitted property in the middle of a shape, so
  the reader has to run the condition in their head to know what the object
  actually holds. Each of the 56 sites is now a named binding built in statements,
  with the optional field added after.

  Most were option bags handed to a constructor: `cire/api/src/index.ts` and both
  Pulse entrypoints (`index.ts`, `local.ts`) now build a typed `AppOptions` and
  set the origin, limiter and login-URL fields conditionally, which also makes the
  comment explaining each one sit next to the assignment instead of inside a
  ternary. `shared/crypto/src/arc.ts` and `shared/osn-auth-client/src/verify.ts`
  build a `JWTVerifyOptions` the same way, so the "unset issuer means jose does
  not enforce `iss`" rule (X2) is a single readable line.

  The rest are wire payloads and drizzle update sets. `pulse/api`'s series
  instance update was thirteen consecutive conditional spreads; it is now thirteen
  `if` statements over a `Partial<typeof events.$inferInsert>`, same thirteen keys.
  `guest-event-draft.ts`, `spreadsheet.ts`, `import.ts` and `zap-bridge.ts` follow
  the same shape. `organiser-hosts.ts` gains `HostPersonDto` and `HostSeatDto`, so
  the co-host panel's response is a named type rather than an inline literal with
  four conditional keys.

  Two fixes in `osn/api/src/services/auth/step-up.ts` beyond the rule: the claims
  object reuses the exported `StepUpTokenClaims` instead of redeclaring it, and it
  is built inside the `Effect.tryPromise` thunk so a throw still maps to
  `AuthError`.

  Test files still hold 25 hits, all fixture builders folding an optional argument
  into a request body, so the rule stays off in the test override.

- c87ea88: Clear every `anti-slop/no-known-value-widening` hit in application source and
  raise the rule from `warn` to `error`. The rule fires when a value the compiler
  already knows the shape of — an object literal, an arrow function, a `new` —
  is annotated with something broad enough to throw that knowledge away:
  `unknown`, `object`, an inline type literal, or any `Record<K, V>`.

  Nearly all 116 hits were lookup tables annotated `Record<string, T>`. They split
  two ways, and the split is the whole substance of this change:

  **Closed-key tables** now carry a trailing `satisfies Record<ClosedUnion, T>`
  instead of a leading annotation. The table keeps its literal type, so a missing
  key is a compile error rather than a silent `undefined` at the read site — the
  opposite of what the `Record` annotation gave.

  **Genuinely open-key tables** — the ones read with a runtime string and a `??`
  fallback — now declare a named `interface` with an index signature. This states
  the real contract (any key may miss) where `Record<string, T>` claimed every key
  is present. It also avoids the alternative the first pass reached for, a
  `key as keyof typeof TABLE` assertion, which is unsound and would have added to
  the `require-safety-comment-for-type-assertion` backlog.

  Two of these were latent bugs. `selectAuthRateLimiters` assembled its bundle in
  a `Record<string, RateLimiterBackend>` and cast the result to
  `AuthRateLimiters`, so a missing limiter slot typechecked; it now builds into a
  mapped type with the `readonly` stripped and returns without a cast. `Icon`'s
  glyph table was annotated `Record<string, () => JSX.Element>`, which let a new
  `IconName` be added to the union with no glyph behind it; the `satisfies` now
  forces coverage while `name` stays a plain `string`, since an unrecognised name
  rendering nothing is the documented behaviour its tests assert.

  Return-type hits were handled by naming the shape. `satisfies` does not silence
  those — the rule unwraps it — so `initObservability` and friends now return an
  exported interface instead of an inline type literal.

  Test files still hold 62 hits, nearly all a fixture table or a stub response
  annotated `Record<string, …>` so the test can index it with a computed key, so
  the rule stays off in the test override.

- 9f1b272: Clear every `anti-slop/no-unknown-returns` hit in application source and raise
  the rule from `warn` to `error`. A function returning `unknown` hands its caller
  a value with no contract, so every site either had a shape worth naming or was
  returning a value nobody read.

  The three `arc-middleware.ts` copies (osn, pulse, zap) now decode a JWT segment
  to text and parse it through `parseArcHeader` / `parseArcPayload`, which narrow
  with `in` checks and contain no type assertions at all. `zap-bridge.ts` gains
  four named response types and a parser per endpoint, so a malformed zap-api
  reply throws at the bridge — naming the endpoint — instead of surfacing as an
  `undefined` field several layers up. `safe-error.ts` and `grant-failure.ts`
  share a `TaggedServiceError` guard in place of duck-typed shape checks.

  `shared/redis` exports a recursive `RedisReply` and narrows ioredis's `unknown`
  through `toRedisReply()` once, at the driver boundary. `shared/observability`'s
  redactor returns a `RedactedValue` union, and `shared/openapi-tools` normalises
  through a `JsonNode` union that throws on anything JSON cannot represent.
  `@osn/ui` exports `RunPasskeyCeremony` and `RunPasskeyRegistration` so the four
  step-up call sites name the ceremony callback instead of typing it
  `(options: unknown) => Promise<unknown>`, and `@osn/client`'s two registration
  begins return `PublicKeyCredentialCreationOptionsJSON`.

  Test files still hold 18 hits, all in fetch/JSON helpers, so the rule stays off
  in the test override.

- 1ddf9bb: Clear every `anti-slop/no-unsafe-dictionary-type` hit in application source and
  raise the rule from `warn` to `error`. `Record<string, unknown>` says only "an
  object with string keys" — it accepts any key, guarantees no field, and hides
  whichever shape the code actually meant. Each of the 67 hits was one of four
  things, and each got a different fix.

  **A shape that was always known.** `@shared/crypto` exports an `Es256Jwk`
  interface and `validateEs256Jwk` asserts against it, so `importKeyFromJwk` takes
  `unknown` and does the checking itself instead of trusting a caller's cast —
  `@osn/api`'s boot path now hands it the raw string. `@osn/api`'s auth helpers
  name the four claim sets it signs (`AccessTokenClaims`, `StepUpTokenClaims`,
  `IdTokenClaims`, `OidcAccessTokenClaims`), and `verifyJwt` returns a
  `VerifiedJwtClaims` whose every field stays `unknown` on purpose: one key signs
  all four sets, so callers must still narrow on `aud`. `@pulse/api`'s account
  export becomes a discriminated union on `section`, so a reader that switches on
  the tag knows exactly which record fields it has.

  **A drizzle update set.** `@osn/api`'s organisation update and both `@cire/api`
  registry updates are typed `Partial<typeof table.$inferInsert>`, so a key that
  isn't a column fails at the assignment rather than at the D1 boundary.
  `@shared/db-utils` replaces seven `S extends Record<string, unknown>` schema
  constraints with a real `DrizzleSchema`.

  **An untrusted payload.** The CSP report normaliser, the osn-bridge org
  decoder, the crop validator and the guest claim-response guard now name the
  wire shape with every field left `unknown`, or narrow with `in` and drop the
  stand-in type entirely. Nothing gains a guarantee the wire never made.

  **A cast that was hiding a working type.** `@shared/feature-flags` uses
  GrowthBook's own `FeatureDefinitions` / `SavedGroupsValues`, which removes the
  `payload as never` at `initSync`. `@shared/observability`'s redactor and
  `@shared/openapi-tools`' normaliser drop casts their narrowing had already
  earned; `generate.ts` now throws on a non-object OpenAPI document instead of
  asserting one. `@osn/api`'s public-error walker reads through
  `Object.getOwnPropertyDescriptor` rather than indexing a widened object.

  Test files still hold 102 hits — nearly all a stub request body or a drizzle row
  the test then asserts on field by field — so the rule stays off in the test
  override.

- c9b3c75: Adopt the `anti-slop` oxlint plugin, vendored at `tools/oxlint/anti-slop` from
  upstream commit `446268e`. The rules target the type-system escape hatches that
  generated code reaches for instead of modelling the domain — chained `as`
  assertions, `unknown` in signatures, `object` parameters, runtime `typeof`
  branching, index-signature dictionaries.

  Upstream ships all 15 rules at `error`. Enabling them here produced 4686
  diagnostics across 541 files, so `oxlintrc.json` runs them as a ratchet
  instead: seven rules that are already clean in application source are `error`,
  five with bounded debt are `warn`, and three whose debt runs into the hundreds
  or thousands are `off` with the counts recorded inline. A test override turns
  off the rules whose only violations are test idioms — `Reflect.get` in Proxy
  traps, `vi.mock`, `body: object` request helpers.

  No behaviour change: `bun run lint` still reports zero errors.

- Updated dependencies [d4553ed]
- Updated dependencies [587f561]
- Updated dependencies [c87ea88]
- Updated dependencies [9f1b272]
- Updated dependencies [1ddf9bb]
  - @shared/db-utils@0.6.1
  - @shared/observability@0.13.4
  - @shared/redis@0.4.3
  - @shared/crypto@0.10.3
  - @shared/email@0.4.8
  - @shared/openapi-tools@0.1.1
  - @osn/db@0.20.6
  - @shared/turnstile@0.2.11

## 3.20.5

### Patch Changes

- c5cc541: Add a passkey-less dev sign-in (`GET|POST /dev/login`) for the `local` and `dev`
  tiers, so the seeded wedding is reachable without enrolling a WebAuthn
  credential.

  A passkey is the only primary login factor, which leaves any seeded account
  permanently locked out — a seed script cannot enrol a credential on its own
  behalf. The route mints a **real** OSN session for one fixed principal
  (`usr_dev_bootstrap_owner`, the id the cire seed writes as the seeded wedding's
  owner), so the OIDC authorize/token chain, the organiser portal, the vendor
  portal and `@osn/social` all run untouched. There is no bypass anywhere else in
  the stack, no identifier parameter, and nothing to enumerate.

  **Two gates, both fail closed**, both applied in `buildAppDeps` — `OSN_ENV` must
  be unset (the repo-wide local default) or read as `local`/`dev`, and
  `DEV_LOGIN_SECRET` must be set. Fail either and the routes are never mounted, so
  the path answers 404 rather than a 401 that would admit the surface exists. The
  tier list is its own, deliberately not an alias of the OpenAPI-docs gate, so a
  later change to how docs are gated cannot quietly widen a credential bypass. The
  secret is compared in constant time; the endpoint carries its own 10/min limiter,
  per app instance, keyed on the resolved IP. The production deploy job now refuses
  to run while `DEV_LOGIN_SECRET` is set on the production Worker.

  `return_to` is optional and checked against `DEV_LOGIN_RETURN_ORIGINS` — its own
  comma-separated var, **not** the CORS allowlist, because a redirect target need
  not be an origin that fetches this API with credentials and `OSN_CORS_ORIGIN`
  also feeds the CSRF origin guard. Unset ⇒ every `return_to` is a 400, so the
  endpoint cannot become an open redirect that leaks the session cookie. The check
  runs before the secret compare, and both verbs answer `Referrer-Policy:
no-referrer` so the secret-bearing URL never reaches the target. `GET` is the
  primary verb: the origin guard rejects a POST without a matching `Origin`, and a
  URL keeps the secret out of every public frontend bundle.

  The principal is provisioned idempotently on first use (`onConflictDoNothing`
  inside a single `commitBatch`), since `osn-db-dev` is never reset. Its handles
  `dev_bootstrap` and `dev_bootstrap_org` are now in `RESERVED_HANDLES` so no real
  registration can occupy the row first — and organisation creation now consults
  that set too, which also closes a pre-existing gap that let `admin`, `api` and
  friends be taken as organisation handles.

## 3.20.4

### Patch Changes

- d50c68e: Comments only: repoint every "tracked in wiki/TODO.md" reference at GitHub
  Issues. Findings keep their IDs and now name the private `xchromo/osn-tracker`;
  planned work points at open issues in `xchromo/osn`. No behaviour change.
- Updated dependencies [d50c68e]
  - @shared/crypto@0.10.2
  - @shared/observability@0.13.3
  - @shared/rate-limit@0.3.2
  - @shared/email@0.4.7
  - @shared/turnstile@0.2.10

## 3.20.3

### Patch Changes

- b0bb1ee: Serve the OpenAPI docs on `local` and `dev` only

  The Scalar UI at `/openapi` and the document at `/openapi/json` are now mounted
  on the `local` and `dev` tiers only; on `staging` and `production` the plugin is
  never mounted and both paths 404.

  The document maps every route, parameter and error shape, and nothing reads it
  at runtime — `shared/openapi/{osn,pulse}.json` are committed, the generated
  clients are built from those files, and each generator boots its own app to
  produce one. A deployed public host gains nothing by serving it.

  Both gates take the tier from the request-scoped `env.OSN_ENV` binding rather
  than `process.env`, which workerd leaves empty during module evaluation; a
  decision made at import time would read `local` on every deployed tier. They
  fail closed, so an unrecognised tier string leaves the docs off.

  `pulse/api/wrangler.toml` now sets `OSN_ENV` on `staging` and `production`. That
  var also drives the cookie `Secure` flag, the plaintext-JWKS refusal and the
  fail-closed CORS check, all of which were inert on those tiers because the var
  was never set. Neither tier has ever deployed (both still carry placeholder D1
  ids), and both will now refuse to boot until their CORS and issuer vars are
  real — which is the intended posture.

## 3.20.2

### Patch Changes

- fd4c2f1: Stop a bot fleet from spending half the daily Worker budget on pointless
  `POST /token` grants. Roughly 33k requests a day were arriving at
  `osn-api-production` from one AWS region, all of them anonymous bootstrap
  grants fired by page loads of the `osn-social.pages.dev` copy of the app.

  Two causes, both fixed here:

  - **The client asked for a session it had no reason to think existed.** A
    cold page load with no stored account always replayed the cookie against
    `/token`, even in a browser that had never signed in. The API now sets a
    readable `osn_has_session` marker cookie beside the HttpOnly session cookie;
    the client skips the grant when the marker is absent. The marker holds no secret — a forged one buys a single 400. It carries `Domain` from the new `OSN_COOKIE_DOMAIN` var, because the
    issuer (`id.musubi.social`) and the app (`musubi.social`) are different
    hosts; the session cookie itself stays `__Host-` and host-only. Where there
    is no `document` — iOS, SSR — the gate is inert.

  - **Every refusal was retried as if it were a blip.** A cross-origin CORS
    refusal surfaces as an opaque `TypeError`, indistinguishable from a network
    failure, and the client ran the full transient ladder over it: three
    requests per blocked page load. The network path now retries once. A real
    transient status (429/5xx) keeps the full ladder.

  The session cookie is never cleared on a rejected grant — that path also
  covers a storage blip, and clearing would harden a transient failure into a
  permanent logout.

## 3.20.1

### Patch Changes

- 2e8e8ba: Deploy OSN identity to its own dev tier, isolated from production.

  The cire dev tier needs an identity provider it can break. `[env.dev]` in
  `osn/api/wrangler.toml` was a set of localhost placeholders pointing at the
  production `osn-db`; it is now a real deployed tier — route
  `id.dev.musubi.social` (`custom_domain = true`), `OSN_RP_ID = "dev.musubi.social"`,
  its own issuer and authorize-UI URLs, the `osn-db-dev` D1 database, five native
  rate-limit namespaces on fresh ids, and its own `[env.dev.triggers]`. Dev
  passkeys are separate credentials from production, which is the point.

  Same `process.env` fix as `@cire/api`: this Worker also pins
  `compatibility_date = "2025-03-01"` without
  `nodejs_compat_populate_process_env`, so `loadConfig` resolved the `local` tier
  in production and the logger picked the local format and level. The flag is
  listed explicitly and the module-top-level read moves to request scope —
  `process.env` populates lazily on first access, so the flag alone would not have
  fixed a top-level read. The comment in `shared/observability` asserting that
  `nodejs_compat` populates `process.env` was wrong and is corrected.

  `@osn/db` gains the same per-env migrate script shape as the other db packages.

- Updated dependencies [2e8e8ba]
  - @osn/db@0.20.5
  - @shared/observability@0.13.2
  - @shared/crypto@0.10.1
  - @shared/email@0.4.6
  - @shared/turnstile@0.2.9

## 3.20.0

### Minor Changes

- ae68f78: Declare `response:` schemas for the core session-lifecycle auth routes, and stop the OpenAPI document dropping `/.well-known/*`.

  Fourteen operations — handle availability, registration, `/token`, logout, passkey login, session introspection and revocation, profile list and switch, OIDC discovery and JWKS — now declare TypeBox `response:` schemas and an `operationId`. Shared shapes (`errorResponse`, `tokenResponse`, `publicProfile`, `sessionSummary`, the WebAuthn request options) live in a new `routes/auth/response-schemas.ts`.

  These schemas are not documentation. Elysia validates and _cleans_ every response against them at runtime: an undeclared key is deleted from the body before it is sent, and a value that fails its type check turns the route into a 500. Each schema here was written against the handler's actual return value and the service's return type rather than the endpoint's intent. The JWK object carries `additionalProperties: true` for exactly that reason — a JWK field the schema forgot would be silently stripped from the document every relying party verifies signatures against.

  `jwtPublicKeyJwk` on `AuthConfig` is now typed as jose's `JWK` rather than `Record<string, unknown>`, because a property of type `unknown` satisfies no TypeBox schema. The three `as Record<string, unknown>` casts at its call sites are gone.

  The generated document also gains `/.well-known/openid-configuration` and `/.well-known/jwks.json`, which had never appeared in it: `@elysiajs/openapi` decides a route serves a static file when its path contains a dot, and dropped both. No route in `@osn/api` serves a file, so the heuristic is now off.

### Patch Changes

- cc81135: Describe the response bodies of the last nine operations: profiles, recommendations, account erasure and account export. Every operation in the OpenAPI document now declares its success and error shapes, so a generated client no longer has to guess.

  Account export keeps its 200 out of the `response` map on purpose — the success path streams a raw NDJSON `Response`, and an Elysia response schema is a runtime validator as much as a document. It is described through `detail.responses` instead.

- 3feb77c: Graph route group — response schemas and stable operation ids (PR 5 of the
  `shared/openapi/osn.json` series). All eleven user-facing routes in
  `routes/graph.ts` — connection request, respond, remove, the three connection
  lists, connection status, block, unblock, block list and the block check —
  previously generated with an empty `responses` object, and so a `Void` return
  in any generated client. Each now describes every status it can emit.

  The schemas live in a new `routes/response-schemas.ts`, deliberately separate
  from `routes/auth/response-schemas.ts`. The two groups do not share an error
  envelope: the auth surface funnels failures through `publicError`, whose body
  carries an optional human-readable `message` alongside `error`, while these
  routes answer with a bare `{ error }` whose value already IS the message —
  either a fixed string ("Unauthorized", "Profile not found", "Too many
  requests") or `makeSafeError`'s output. A single shared const would have had to
  be a superset of both, documenting a `message` field that half the API never
  sends.

  Each status set is taken from the handler's literal control flow rather than
  from what the endpoint looks like it should do. Three consequences worth
  naming:

  - The three list endpoints and `GET /blocks` declare only 200/401/500. They are
    reads, so no rate limiter runs, and they take no handle, so nothing can 404.
  - Both mutations that create a row (`POST /connections/:handle`,
    `POST /blocks/:handle`) answer 201; every other mutation answers 200.
  - "Not connected", "no pending request" and "no block to remove" are all 400,
    not 404. The profile in the path exists in each case — it is the edge that
    doesn't, and `resolveHandle` is what owns 404.

  `resolveHandle` also sets **500** when the lookup itself throws, returning null
  either way, so every route that resolves a handle can emit a 500 carrying the
  same `{ error: "Profile not found" }` shape. That is why 500 is declared with
  the error envelope throughout rather than left off the read paths.

  `getConnectionStatus` returns a closed union (`none` / `pending_sent` /
  `pending_received` / `connected`) rather than a plain string, matching the
  service's own return type, so a generated client gets an enum it can switch
  over. It is directional on purpose: a client can label the button "Cancel" or
  "Accept" without a second call.

  No behaviour change: the route set in `shared/openapi/osn.json` is identical
  before and after (62 paths, 73 operations), and `shared/openapi/pulse.json`
  regenerates byte-identical.

- e485818: OIDC route group — response schemas and stable operation ids (PR 4 of the
  `shared/openapi/osn.json` series). Covers `routes/auth/oidc-clients.ts` (client
  registration, list, disable) and `routes/auth/oidc.ts` (`/authorize`,
  `/authorize/context`, `/authorize/decision`, `/oidc/token`,
  `/oidc/connections`). Nine operations that previously generated with an empty
  `responses` object — and so a `Void` return in any generated client — now
  describe every status they can emit.

  Two things about this group are unlike the ones before it.

  The OIDC routes emit **two different error envelopes at the same status**.
  Their own refusals use the RFC 6749 §5.2 `{ error, error_description }` shape;
  the shared rate-limit gate and `handleError` use the house
  `{ error, message }`. Elysia's `response:` schemas clean as well as validate —
  an undeclared key is deleted from the body before it is sent — so a schema
  carrying only the RFC pair would silently blank the message on a 429 or a 500.
  `oidcErrorResponse` is therefore a superset of both, with `error_description`
  and `message` each optional, rather than a union.

  `GET /authorize` is the only route in the auth surface whose body is sometimes
  a string. It answers a browser navigation, not a fetch, and has three shapes:
  an empty body at 302 (every success and every post-validation error, which
  travels back to the relying party as query parameters); a rendered HTML page at
  400/401/429, because RFC 6749 §4.1.2.1 forbids redirecting before the client
  and redirect URI are trusted, so the user is stranded and gets a real page; and
  a JSON error at 400/500 when a non-OIDC failure falls through `handleError`.
  Its 400 is a `t.Union([t.String(), oidcErrorResponse])` for that reason —
  declaring only the object would have made Elysia reject the error page it was
  rendering.

  Four new schema consts in `routes/auth/response-schemas.ts`
  (`oidcErrorResponse`, `ownedClientSummary`, `oidcConnectionSummary`,
  `oidcTokenResponse`), each modelled on the service's literal return type rather
  than the endpoint's apparent intent. Routes authenticated by session cookie or
  client credentials get an `operationId` but no `security: [{ bearerAuth: [] }]`,
  since a bearer token is not what authenticates them.

  No behaviour change: the route set in `shared/openapi/osn.json` is identical
  before and after, and `shared/openapi/pulse.json` regenerates byte-identical.

- 2c06824: Organisation route group — response schemas and stable operation ids (PR 6 of
  the `shared/openapi/osn.json` series). All nine routes in
  `routes/organisation.ts` — create, list mine, read, update, delete, add member,
  remove member, change role, list members — previously generated with an empty
  `responses` object. Nine of the eighteen remaining empty operations; the last
  nine are account erasure/export, profiles and recommendations.

  Two consts in `routes/response-schemas.ts` were named after the graph but are
  not specific to it, so they are renamed rather than duplicated per group:
  `graphErrorResponse` → `errorResponse` and `graphOkResponse` → `okResponse`.
  Both are internal to `osn/api` and the generated spec is unchanged by the
  rename. Four groups still to come would each have needed its own copy.

  Points where the described behaviour is not what the endpoint looks like:

  - **`POST /organisations/` cannot 500.** Its catch maps every service failure
    to 400, so a taken handle and a database fault are reported identically. The
    schema says so rather than declaring a 500 that never arrives.
  - **Authorisation refusals are 400, not 403,** everywhere a check lives in the
    service: "only admins can update", "only the owner can delete", "only the
    owner can grant admin". The single real 403 is `GET
/organisations/:handle/members`, whose membership check runs in the route.
  - **404 on the member routes covers two different misses** — no such
    organisation and no such profile — told apart by the message, since both
    handles are in the path.
  - `resolveOrg` sets **500** when the lookup itself throws and returns null
    either way, so every handle-resolving route can emit a 500 carrying the same
    `{ error: "Organisation not found" }` body.

  One behaviour change, and it is a fix: in `GET /organisations/:handle/members`
  the `getMemberRole` call sat outside the `try`, so a database fault during the
  membership check escaped to Elysia's default handler and answered with a body
  unlike every other error in the group. It now runs inside the `try` and reports
  `{ error }` at 500 like its neighbours. The 200 and 403 paths are untouched.

  `listMembers` also had its return type narrowed from `role: string` to the
  column's own `"admin" | "member"`. The roster is what a client reads before
  PATCHing a role back, and both request bodies accept exactly those two values,
  so the wider type was wrong at the source — and a `t.String()` in the response
  schema would have propagated it into every generated client.

  Route set unchanged: 62 paths, 73 operations before and after.
  `shared/openapi/pulse.json` regenerates byte-identical.

- deee38a: Declare response schemas for the passkey, step-up, recovery, cross-device, email-change and security-event routes.

  Twenty-one operations now carry a `response` map and an `operationId`, so the generated OpenAPI document describes what each one actually returns instead of an untyped body. Every schema is taken from the service's real return type, because Elysia deletes any key a response schema omits — an incomplete schema is silent data loss, not a documentation gap.

  Two details worth naming:

  - The WebAuthn registration options declare `extensions`, which `@simplewebauthn/server` fills with `credProps` unconditionally. Omitting it would have stripped the extension and broken enrolment in the browser.
  - `POST /login/cross-device/:requestId/status` is a union of four shapes discriminated by `status`, only one of which carries a session.

  Enum-ish WebAuthn members stay plain strings: those vocabularies grow, and an unrecognised value would fail response validation and take down the ceremony.

  New tests pin the full key set of the registration options, the passkey list and the security-event list, so a future schema edit that drops a field fails a test rather than a client.

## 3.19.0

### Minor Changes

- 87bd5f8: Generate an OpenAPI document for `@osn/api`, and share the post-processing with `@pulse/api`.

  `@osn/api` now mounts `@elysiajs/openapi` and gains an `openapi:generate` script that boots the real app, fetches its own `/openapi/json`, and writes `shared/openapi/osn.json` — the same pipeline Pulse already used, so the committed spec cannot drift from what the app serves. CI regenerates both documents and fails on a diff.

  The ~290 lines of document post-processing that lived in Pulse's generator script moved to a new `@shared/openapi-tools` package, now covered by tests. `shared/openapi/pulse.json` regenerates byte-identical.

  The ARC-gated internal routes (`/graph/internal/*`, `/organisations/internal/*`, `/internal/*`) are excluded from the OSN document: only other OSN services call them, and they authenticate with signed ES256 tokens rather than a user session.

### Patch Changes

- Updated dependencies [87bd5f8]
  - @shared/openapi-tools@0.1.0

## 3.18.1

### Patch Changes

- Updated dependencies [1c19bae]
  - @shared/crypto@0.10.0

## 3.18.0

### Minor Changes

- 4e0509f: Add a "Sent" tab to Connections so an outgoing request is actually visible somewhere.

  `listPendingRequests` was always addressee-only by design (a request you sent
  never shows up there), and `listConnections` only returns accepted rows, so a
  sender had no page anywhere in `@osn/social` that showed their own outstanding
  requests — the toast on send was the only trace, and it vanished on
  navigation. Reported as "I tried connecting with someone and it didn't work,
  don't see it in pending or accepted," but the request was landing fine on the
  recipient's side the whole time.

  - `@osn/api`: new `graph.listOutgoingRequests` service method and
    `GET /graph/connections/sent` route (mirrors the existing `/pending`
    endpoint, filtered by `requesterId` instead of `addresseeId`).
  - `@osn/client`: `GraphClient.listSentRequests` + `SentRequestEntry` type.
  - `@osn/social`: a "Sent" tab on `ConnectionsPage` listing outgoing requests,
    with a Cancel action (`removeConnection`, which already cancels a pending
    request in either direction).

  Also gives the desktop rail combobox and the `/search` page search fields a
  prepended "@" inside the existing pill styling, replacing the magnifying-glass
  icon — reusing the `@osn/ui` `UsernameInput` field's own `@`-prefix visual
  convention. `UsernameInput`'s availability-check `status` machinery doesn't
  fit a live people/org combobox that also matches by display name, so this
  borrows the visual token rather than the component itself.

## 3.17.2

### Patch Changes

- 25ee66c: Remove the Tauri desktop/mobile shell from Pulse. `@pulse/app` stays exactly where it is, keeps its package name, and stays a browser SPA — Pulse is going native in Swift instead, and no Tauri build ever shipped.

  Deleted `pulse/app/src-tauri/` outright (Rust crate, `gen/apple/` Xcode project, capabilities, build guard scripts) along with the `@tauri-apps/*` dependencies, the `tauri://localhost` CORS/origin-guard allowance in `@osn/api` and `@pulse/api`, and the `@tauri-apps/plugin-opener` usage in `MapPreview.tsx` / `AddToCalendarButton.tsx` (replaced with plain browser APIs). `@osn/client`'s `session-fetch.ts` keeps its `setSessionFetch`/`sessionFetch` seam — only the Tauri-specific doc comments referencing it were dropped.

  Dev ports (1420 for `@pulse/app`, 1422 for `@osn/social`) and `strictPort` are untouched; `@osn/social`'s dev server drops its `TAURI_DEV_HOST` host/HMR override and its `src-tauri` watch-ignore, which changes nothing about the shipped build. CI, docs, and wiki pages updated to match; historical changelog entries are left as-is.

## 3.17.1

### Patch Changes

- 8cb8b04: Fix graph/organisation routes swallowing every business-rule error into a
  generic "Request failed".

  Route handlers run service effects through `ManagedRuntime.runPromise` (see
  `makeAppRunner`), which rejects with Effect's `FiberFailure` wrapping the
  typed failure — never the tagged error itself. The per-route `safeError`
  copies checked `_tag` on the caught value directly, so the check never
  matched: tagged `GraphError` / `OrgError` / `NotFoundError` messages
  ("Connection already exists", "Cannot connect to yourself", "Pending request
  not found", …) all collapsed into the generic "Request failed". In
  `@osn/social` this surfaced as an unexplained "Request failed" toast when
  Connect hit an already-pending edge (e.g. the other person had already sent
  a request, or a previous click had succeeded despite the error toast).

  The four copies are replaced by a shared `makeSafeError(allowedTags)` in
  `osn/api/src/lib/safe-error.ts` that unwraps a `FiberFailure` to its typed
  failure (`Runtime.isFiberFailure` → `Cause.failureOption`) before applying
  the tag allowlist. Non-allow-listed failures (`DatabaseError`, defects) still
  collapse to the generic message, so the S-M17 no-leak invariant is unchanged.

## 3.17.0

### Minor Changes

- dea594b: Rank OSN search on social proximity and name tokens, not text alone

  `GET /recommendations/search` now follows the tiering Facebook's typeahead
  describes — retrieve the caller's own graph first, then the global index, then
  score the whole candidate set before slicing.

  - **New retrieval pass over the caller's own edges.** An index seek on the
    connection indexes joined to `users`, capped at 50 rows. It is a recall
    guarantee, not a duplicate: every global pass is `ORDER BY handle LIMIT
overfetch`, so a common prefix filled the window with whoever sorted
    alphabetically first and a connection could be missed entirely regardless of
    ranking. Organisation search gained the same pass over the caller's own
    memberships.
  - **Ranking is text score + proximity score**, summed, computed before the page
    is sliced rather than after. Connections, then pending requests, then
    co-members of an organisation the caller belongs to, outrank strangers on the
    same text tier. Friends-of-friends is deliberately excluded: nothing exposes
    another profile's connection list, so ordering by mutuals would be the same
    graph-inference oracle that keeps `mutualCount` out of the payload.
  - **Name-token prefix is now its own tier**, above handle infix. `"smith"` used
    to score `"Roberta Smith"` as a name infix — indistinguishable from
    `"Blacksmith Ltd"` and ranked below `@blacksmith`.
  - **Multi-word queries work.** Tokens are matched independently, so
    `"Smith, John"` and `"smi joh"` both find `John Smith`, and the tokens are
    rejoined to spell the handle they imply, so `"john smith"` seeks `@johnsmith`
    on the index instead of skipping the seek on account of the space.
  - **The minimum query length is 1**, down from 2. What a character reaches still
    widens in steps: 1 searches only the caller's own connections and
    organisations, 2 unlocks the global handle seek, 3 unlocks name matching.
  - The three post-retrieval probes (blocks, connection state, shared
    organisations) now run concurrently, so the request has one fewer sequential
    database step than before despite the added signal.

  `@shared/db-utils/search` gains `tokeniseQuery`, `joinTokens`,
  `tokenContentLength` and `tokensPrefixName`. The tokeniser keeps every LIKE
  metacharacter (`%`, `_`, `\`) inside the token, because `escapeLike` can only
  neutralise a character that survives tokenisation — treating `%` as a separator
  would turn `"a%b"` into `a` + `b` and convert the one wildcard the escape exists
  to defuse back into a wildcard. Ordinary punctuation still splits, so
  `"Smith, John"` tokenises the way a person reads it.

  Two findings from the pre-merge security review, both introduced and fixed on
  this branch:

  - **S-M1** — the length gates compared the raw phrase, while the SQL they gate
    is built from the tokens. Since tokenisation drops separators, `"a."` reached
    a one-character global handle seek and `"a a"` a one-character global infix
    scan, bypassing the scope rule the 1-character floor depends on. The prefix
    pass now gates on the handle prefix actually bound into the range, and the
    infix pass on the longest token — an `AND` of `LIKE` patterns is only as
    selective as its most selective conjunct.
  - **S-M2** — token count was unbounded. `q`'s 64-character cap admits 32
    single-character tokens, each emitting its own ANDed pair of `LIKE`
    predicates: 64 evaluations per scanned row on a conjunction that matches
    nothing, so `LIMIT` never short-circuits the scan. Capped at
    `MAX_QUERY_TOKENS = 6`.

  The infix gate is **script-aware** (`hasScanworthyToken`). A minimum-length
  gate is a proxy for a minimum-selectivity gate, and character count is only a
  good proxy inside one alphabet: two Han characters pick a name out of a very
  large space where two Latin letters barely narrow anything. Tokens in Han,
  Hiragana, Katakana or Hangul therefore clear the gate at two characters. This
  was a regression the token-length fix above introduced — `"日本 太郎"` is a
  complete name whose every token is two characters, and a flat three-character
  rule made it unsearchable.

  No change to the response shape of either search surface.

### Patch Changes

- Updated dependencies [dea594b]
  - @shared/db-utils@0.6.0
  - @osn/db@0.20.4
  - @shared/crypto@0.9.5

## 3.16.2

### Patch Changes

- 4d5f815: Fix two silent DDL-emitter defects and consolidate test harnesses

  The schema-reflection emitters in `@osn/db/testing`, `@pulse/db/testing` and
  `@zap/db/testing` dropped two kinds of constraint when building test databases:

  - **Column-level `UNIQUE`.** `emitColumn()` read only the table config's
    `uniqueConstraints` (table-level `unique()`), never `col.isUnique`, where
    Drizzle records column-level `.unique()`. Seven OSN constraints were dropped —
    `accounts.email`, `accounts.passkey_user_id`, `users.handle`,
    `passkeys.credential_id`, `recovery_codes.code_hash`, `organisations.handle`,
    `oauth_clients.client_id`.
  - **Partial-index `WHERE` clauses.** Four OSN partial indexes were emitted as
    full indexes, and `deletion_jobs`' pulse/zap pending pair collapsed into a
    single duplicate.

  The blast radius was narrower than it first appears, and worth stating
  precisely: `osn/api`'s unit lane used a hand-written DDL block that already
  carried all seven UNIQUEs, so replacing it with `applySchema()` is drift-proofing
  rather than new coverage. The lane that genuinely ran without them is the
  Miniflare D1 in `osn/api/src/d1-integration.test.ts`, which builds from
  `createSchemaSql()` directly — the only test proving OSN core runs on real D1 was
  doing so against a schema that accepted duplicates and had four indexes widened.

  `osn/db/tests/ddl-lockstep.test.ts` (new) diffs a normalised structural
  snapshot of the emitted schema against the full `osn/db/drizzle/*.sql`
  migration chain — columns, defaults, indexes (including column order within an
  index), partial predicates, foreign keys and their referential actions — and
  fails on any divergence. `zap/db` gets the same test. Both emitter fixes are
  applied to all three copies; pulse and zap were unaffected in practice (neither
  schema uses column-level `.unique()` or partial indexes today) but carried the
  same latent trap.

  The emitter also now emits `ON DELETE`/`ON UPDATE` actions, which it previously
  dropped — harmless while every OSN foreign key is `no action`, but the first
  `onDelete: "cascade"` would otherwise have cascaded in production and restricted
  in every test.

  Two performance fixes to the emitters, both measured: the reflected DDL is
  memoised (it was ~24% of per-test database setup, recomputed for a schema that
  cannot change within a process) and the `SQLiteSyncDialect` is hoisted out of
  the per-index loop.

  Also in this change:

  - `osn/db/tests/schema.test.ts` builds its fixture with `applySchema()` instead
    of a hand-written `CREATE TABLE` block. Its three "enforces unique …
    constraint" tests previously asserted against DDL typed in the same file, so
    removing every `.unique()` from `osn/db/src/schema` left all 50 tests green;
    they now fail as intended.
  - `osn/api/tests/helpers/db.ts` drops 239 lines of hand-maintained DDL for the
    same `applySchema()` call.
  - New `@shared/crypto/testing` export with `makeAccessTokenSigner()`, replacing
    the duplicated ES256 key-pair + `makeToken` block in 12 pulse/zap route
    suites; `@cire/api`'s `makeOsnTestAuth()` becomes a thin adapter over it.
  - `pulse/api/tests/services/rsvps.test.ts` — the test named "upsertRsvp ensures
    pulse_users row is created" asserted `expect(true).toBe(true)`; it now queries
    `pulse_users`.
  - `zap/api/src/d1-integration.test.ts` — repaired a stale fixture that had been
    failing unnoticed: it created a DM as a bare `{ type: "dm" }`, predating the
    Z3 "a DM is exactly two people" guard and the Z4 consent gate. Nothing caught
    it because the D1 integration lane runs outside the default vitest include and
    no CI workflow invokes `test:d1` — tracked as T-C1 in `wiki/TODO.md`.

- Updated dependencies [4d5f815]
  - @shared/crypto@0.9.4
  - @osn/db@0.20.3

## 3.16.1

### Patch Changes

- 2a98413: Share the search primitives, and make internal handle search an index seek.

  - `@shared/db-utils`: new `@shared/db-utils/search` module (also re-exported
    from the barrel) holding `normaliseHandleQuery`, `escapeLike`, `likeContains`
    and `handlePrefixRange`. These were three private near-copies across
    `recommendations.ts`, `graph-internal.ts` and cire's `directory.ts`, and the
    copies had drifted: only one knew that `handle LIKE 'q%'` does not use the
    index, and the normalisers disagreed on trim-versus-strip order. Dependency-free
    string math, so the subpath is reachable without the drizzle/effect graph.
  - `@osn/api`: `GET /graph/internal/profile-search` now matches on the half-open
    BINARY range instead of `LIKE 'q%'` — `EXPLAIN QUERY PLAN` goes from
    `SCAN users USING INDEX users_handle_idx` to
    `SEARCH … (handle>? AND handle<?)`. Closes backlog item P-I
    (`internal-profile-search-scan`). The range makes `_` literal for free, so the
    LIKE escaping on that path is gone rather than merely correct, and a query
    containing a character no handle can hold now skips the read entirely.
  - `@osn/api`: fixes a normalisation bug the shared version absorbed — the local
    normaliser tested `startsWith("@")` _before_ trimming, so `" @alice"` (a paste,
    or a mobile keyboard's auto-space) kept its sigil and resolved to nothing on
    `/profile-by-handle` and `/profile-search`.
  - `@osn/api`: new `GET /graph/internal/connection-search` — ARC `graph:read`,
    returns one profile's own **accepted** connections (handle-prefix range OR
    display-name substring, tombstoned accounts excluded, ordered by handle, capped
    at 10). Backs cire's connection-aware co-host autocomplete. Unlike
    `/profile-search` it has no minimum query length and treats an empty query as
    "first page of connections", because the result set is bounded by one profile's
    graph — a list that profile can already read via the user-facing
    `GET /graph/connections` — rather than by the handle namespace.

- Updated dependencies [2a98413]
  - @shared/db-utils@0.5.0
  - @osn/db@0.20.2
  - @shared/crypto@0.9.3

## 3.16.0

### Minor Changes

- 94ab93e: Contact suggestions and a shell search bar in OSN Social. Search is reachable
  from anywhere — a live combobox in the desktop rail and a `/search` page behind
  a new Search tab in the mobile bottom bar — and Discover's suggestion cards now
  say why each person is being suggested.

  - `@osn/api`: new `GET /recommendations/search?q=&limit=&orgLimit=` —
    autocomplete over people **and** organisations, both sections in one round
    trip. One endpoint rather than two because this is typeahead: one request per
    keystroke means one abort to cancel, one rate-limit budget to reason about,
    and no torn state where the people half of a result set is newer than the
    organisation half. People match on handle and display name, two-phase by
    design: pass 1 is an index **seek** over a half-open handle range, and the
    unanchored `%q%` pass over handle + display name runs only when that
    under-fills the page _and_ the query is at least three characters. The range
    is deliberate — `handle LIKE 'q%'` does **not** use the index, because
    SQLite's LIKE-prefix optimisation needs a collation matching LIKE's case
    sensitivity and both handle indexes are BINARY with `case_sensitive_like`
    off, so it plans as `SCAN … USING INDEX`. The two forms are exactly
    equivalent here (handles are lowercase and `^[a-z0-9_]+$`), so this is a pure
    planner win. Queries are normalised (trim, strip `@`, lowercase) and
    LIKE-escaped so an underscore in a handle matches literally; anything under
    two characters returns an empty list rather than a 4xx. Self, tombstoned
    accounts and profiles blocked in either direction are excluded. Each result
    carries the caller's own connection state (`none` / `pending_sent` /
    `pending_received` / `connected`), batched in one query for the whole page —
    the same fact `GET /graph/connections/:handle` already reports per handle, so
    no new disclosure. Deliberately no mutual counts: search takes an arbitrary
    handle, and answering "how many mutuals" for arbitrary handles is a
    graph-inference oracle.
  - `@osn/api`: organisation results follow the same two-phase shape and share
    the ranking function, but carry no exclusions — organisations are public, and
    the caller's own are _more_ relevant in a search box, so they come back
    flagged `isMember: true` and render a badge instead of a CTA. Results are
    addressed by **handle**, not the internal `org_*` id: `GET
/organisations/:handle` resolves by handle and the public `orgProjection`
    omits the id. Chasing that down also turned up a pre-existing bug —
    `OrganisationsPage` linked `/organisations/${org.id}` against that same
    id-less projection, so every organisation row navigated to
    `/organisations/undefined`. Fixed in passing.
  - `@osn/api`: `suggestConnections` gains organisation co-members as a second
    signal, so an account with no connections yet has something to act on — FOF
    alone returns nothing until the first connection is accepted. Suggestions now
    carry a `reason` (`mutual_connections` | `shared_organisation`) naming the
    strongest signal plus the shared organisation as card context, and rank by
    mutual count, then shared-organisation count, then profile id for stable
    ties. Two fixes fell out of the rework: an edge in _any_ state now excludes a
    candidate (a pending request used to keep the person in Discover behind a
    Connect button that could only fail with "Connection already exists"), and
    the hydrate step joins `accounts` so a profile mid-erasure is never
    suggested.
  - `@osn/api`: the recommendations route factory now takes a
    `RecommendationRateLimiters` pair instead of a single backend —
    `createRedisRecommendationRateLimiters` supplies `recs:read` at 20/user/min
    for the fan-out and `recs:search` at 60/user/min for typeahead, which fires
    once per debounced keystroke and would otherwise 429 a user mid-word. Both
    stay per-user and fail-closed.
  - `@osn/client`: `createRecommendationClient` gains `search`, returning people
    and organisations together and taking an `AbortSignal` so a caller can cancel
    a superseded keystroke; `Suggestion` gains `reason` and `sharedOrganisation`.
  - `@osn/social`: search now lives in the shell rather than on one page.
    `GlobalSearch` is an ARIA combobox in the desktop rail — arrow keys move
    `aria-activedescendant` across both sections without leaving the field, Enter
    acts on the active row (Connect / Accept for a person, navigate for an
    organisation), Escape closes. The new `/search` page groups results under
    section headings and is the mobile shell's **Search tab**: the bottom bar is
    the thumb-reachable surface, where a header field is not. `NAV_ITEMS` gained
    a `mobileOnly` flag so the rail — which has the live field — doesn't also
    carry the link, and Discover's icon moved from a magnifier to a person-plus
    so the tab bar doesn't show two magnifiers. Both surfaces share one
    `createSearchController` (debounce, abort, optimistic status), so a row's
    state flips locally on success rather than refetching and reordering the list
    under the cursor — and a failed request renders an error instead of spinning
    forever, since Solid's `resource.latest` rethrows in the error state unless
    the error is read first. The two surfaces run different ARIA patterns on
    purpose: the rail is a combobox whose options carry no operable descendants
    (a listbox option is flattened to its accessible name, so a nested button is
    unreachable to assistive tech), while the page is a plain list with real
    buttons. Discover is now suggestions-only, its cards rendering the
    reason line ("3 mutual connections" / "Also in Acme Inc").

## 3.15.3

### Patch Changes

- 9c3a48a: Allow the Pulse iOS webview origin (`tauri://localhost`) through CORS and the
  Origin guard in local and dev environments. A literal `null` origin stays
  rejected.

## 3.15.2

### Patch Changes

- 46a301d: Backlog sweep — seven tracked findings closed, no behaviour changes beyond
  each item's own scope.

  **AZ-P-I2 — the authorize client had no deadline.** `createAuthorizeClient`'s
  two `fetch` calls carried neither timeout nor `AbortSignal`, so a stalled
  issuer left the consent screen on its spinner until the browser gave up; the
  retry screen only helps once the promise settles. Both calls now take an
  optional `signal` and run under a default 10s ceiling
  (`DEFAULT_AUTHORIZE_TIMEOUT_MS`, overridable via `timeoutMs`). A timeout or
  transport failure surfaces as a retryable `AuthorizeError` — previously a
  transport failure escaped as a raw `TypeError`, contradicting the documented
  error contract — while a caller's own abort is re-thrown untouched.
  `AuthorizePage` aborts its in-flight context read on unmount.

  **AZ-P-I1 — no `preconnect` to the issuer.** `/authorize` is a cold
  cross-origin landing, so `GET /authorize/context` paid DNS + TCP + TLS before
  it could start. A Vite plugin emits `<link rel="preconnect" crossorigin>` from
  the resolved `VITE_OSN_ISSUER_URL`; a missing or malformed value emits no tag
  rather than a dead one.

  **A-L1 — the consent screen announced nothing.** `<Switch>` swapped the whole
  screen without moving focus, so a screen reader was told nothing when the page
  flipped to "Taking you back…" or to a terminal state. An always-mounted polite
  live region announces each transition; the error screen is left to its
  existing `role="alert"` rather than announced twice.

  **`isAuthExpiredError()` exported from `@osn/client`.** Effect's `FiberFailure`
  wrapping defeats `instanceof AuthExpiredError`, so consumers were
  string-matching the printout by hand. The predicate now ships next to the error
  class and can no longer drift from it.

  **S-L4 — recipient email in the dev OTP log.** `logDevOtp` interpolated the
  address into a free-text message, which the key-based redaction deny-list in
  `@shared/observability` cannot see — the `OSN_ENV` gate was the only thing
  between an OTP recipient and the log sink. The address is dropped; the
  `purpose` + code stay.

  **S-L30 — `createInternalGraphRoutes` had no `loggerLayer`.** Every sibling
  route factory merges the observability layer into its fallback runtime; this
  one did not, so anything it logged off the shared runtime went to Effect's
  default logger, unredacted.

  **S-L2 (series) — RRULE expansion bounds.** An `UNTIL` before `dtstart` parsed
  as valid grammar and silently produced a series with zero instances; it is now
  rejected when the caller knows `dtstart`. `expandRRule` returns immediately on
  an empty window — a routine input, since `extend_window` passes a
  now-plus-90-days horizon — and its safety valve drops from 10,000 iterations
  (~70k `Date` allocations) to `MAX_SERIES_INSTANCES`, which provably cannot
  truncate a legitimate expansion.

  **Recovery-codes loading skeleton.** The generate button was disabled until the
  first `GET /recovery/status` read settled, under a blank gap — indistinguishable
  from a broken button on a slow link. A skeleton holds the status line's height
  and the button reads "Checking…" while it waits.

  ***

  **Corrections from the prep-pr reviews, applied in-branch.**

  **S-M1 (security)** — the deadline and the page's unmount abort originally
  covered `submitDecision` as well. That call is state-changing: it consumes the
  parked request, records the consent row and mints the code. Aborting a fetch
  does not un-send it, so a timeout firing mid-commit surfaced a _retryable_
  error over a grant that had actually happened — Allow/Cancel became clickable
  again, the next click hit a consumed request and rendered "this sign-in request
  has expired", and a live consent sat in Connected apps the user believed they
  had cancelled. The write now carries no default deadline and no unmount signal;
  only the idempotent read does.

  **P-W1 / S-L3 / T-S1 (performance + security)** — the timer was cleared when
  `fetch` resolved, i.e. at response _headers_. A server that flushed headers and
  then stalled mid-body escaped the deadline entirely, which is the exact
  indefinite spinner the feature exists to bound. The body read moved inside the
  guarded window.

  **P-W2 / S-L1 (performance + security)** — the preconnect shipped
  `crossorigin=""`, which is _anonymous_ mode. The connection-pool key includes
  the credentials flag, so an anonymous preconnect is not reused by the
  `credentials: "include"` context read: it opened a second idle TLS connection
  and the handshake was paid anyway — strictly worse than emitting no tag. Now
  `use-credentials`.

  **S-L2 (security)** — both `isAuthExpiredError` and cire's `isAuthExpired`
  matched the tag anywhere in the error printout, so an error whose message
  echoed a server-supplied code could decide to sign a user out. Both matches are
  now anchored to the tag heading the string, which is the shape Effect actually
  renders.

  **P-I1 (performance)** — the new recovery-codes skeleton keyed on raw
  `status.loading`, so the refetch after `acknowledge()` withdrew an
  already-known count from the screen. Gated on the cold read only.

  **P-I3 (performance)** — removed an unreachable branch in the money formatter's
  cache lookup.

  Test coverage added for each of the above, plus the gaps the test review named:
  the preconnect plugin, the `aria-live` region, the unmount abort, `logDevOtp`'s
  redaction, the `loggerLayer` fallback path, `timeoutMs: 0`, and the tightest
  legal RRULE walk.

## 3.15.1

### Patch Changes

- 8226487: Refresh dependencies across the monorepo (routine maintenance audit).

  Security-relevant: `@simplewebauthn/server` 13.3.0 → 13.3.2 closes
  GHSA-6hxq-p678-4hr2 (CVSS v4 Low 2.0), where a maliciously-crafted attestation
  `x5c` could present a self-signed "root certificate" rather than chaining to an
  RP-specified trust anchor. Reached through `verifyRegistrationResponse()` on the
  passkey registration path. Exposure was nil rather than merely limited: we
  configure no trust anchors anywhere, so `validateCertificatePath` short-circuits
  on `trustAnchorsPEM.length === 0` and no chain decision was ever made — in
  13.3.0 as much as in 13.3.2. Tracked as S-L102, which also records why
  `attestationType: "none"` is _not_ the control here.

  `jose` moves 6.2.3 → 6.2.4 only, which is a docs update plus an `exportJWK`
  refactor that drops `undefined`-valued properties. That change is inert for us:
  `exportKeyToJwk` immediately `JSON.stringify`s its result, and `thumbprintKid`
  feeds RFC 7638 canonicalisation over `kty`/`crv`/`x`/`y`, so existing `kid`s and
  stored JWKs are byte-identical. The JOSE input-validation hardening (Base64URL
  alphabet, UTF-8 in headers and claims, truncated ASN.1 key data, duplicate
  `crit`) is in **6.2.5**, which this branch does _not_ take — it published
  2026-07-29 and is inside the 3-day quarantine. That upgrade is tracked
  separately and matters, since `jose` sits under both ARC S2S tokens and the
  5-minute `osn-access` JWTs.

  `effect` 3.21.2 → 3.22.0 (deprecates `Graph.neighborsDirected`, unused here),
  with `@effect/vitest` 0.29 → 0.30 and `@effect/opentelemetry` 0.63 → 0.64
  following its `^3.22.0` peer. `@effect/platform` is now an explicit
  `@shared/observability` dependency at `^0.97.0`: it was previously auto-installed
  at 0.94.5 purely to satisfy `@effect/opentelemetry`'s peer and did not actually
  meet it.

  `oxlint` 1.70 → 1.76 makes `vitest/expect-expect` effective inside `it.effect`
  bodies for the first time — the rule was already configured with
  `additionalTestBlockFunctions`, but earlier versions never walked those blocks.
  Ten `@osn/api` tests (of 644) were relying on "the Effect didn't fail" as their
  only assertion; each now asserts the behaviour its name claims, with no change
  to what is under test.

  The `@opentelemetry/*` SDK packages are held at `~2.9.0` rather than moved to
  2.10.0. The exporters and `sdk-logs` cannot follow yet — 0.221.0 is inside the
  14-day minor window — and the 0.220.0 exporters pin `core`/`resources`/
  `sdk-metrics`/`sdk-trace` to exactly 2.9.0, so taking only the SDK half splits
  the tree across two lines and links 2.10.0 packages against `core@2.9.0`. The
  tilde is deliberate: `^2.9.0` still admits 2.10.0. The whole line moves together
  once the exporters are eligible (2026-08-04).

  The root `esbuild` override rises `^0.27.0` → `^0.28.1`, closing
  GHSA-g7r4-m6w7-qqqr. The override had inverted from protective to harmful:
  wrangler 4.114 pins `esbuild 0.28.1` — the fixed version — and the `^0.27.0`
  floor was clamping the whole tree back down to the vulnerable 0.27.7. astro
  already declares `^0.28.0`, so `^0.28.1` now agrees with both consumers instead
  of fighting either. `bun audit` reports no vulnerabilities.

  `oxfmt` 0.44 → 0.59 spans four breaking formatter changes, but produces no
  output change here: the `fmt` script already excludes CSS, astro and markdown,
  and the `sort_imports` reclassification of subpath imports matches nothing in
  the tree. `bun run fmt` is a no-op on the current sources and `fmt:check` is
  clean. 0.60/0.61 stay out until they clear the 14-day minor window.

  Everything else is a patch/minor bugfix bump with no migration steps.

- Updated dependencies [8226487]
  - @osn/db@0.20.1
  - @shared/crypto@0.9.2
  - @shared/db-utils@0.4.1
  - @shared/email@0.4.5
  - @shared/observability@0.13.1
  - @shared/rate-limit@0.3.1
  - @shared/redis@0.4.2
  - @shared/turnstile@0.2.8

## 3.15.0

### Minor Changes

- 55a8ea8: Security + UX hardening across the auth stack (review of PRs #315–#324).

  **Identity / OIDC provider (`@osn/api`, `@osn/db`)**

  - Pairwise-`sub` isolation: a self-serve OIDC client's sector is now its
    server-generated `client_id`, not the first redirect-URI host (attacker-chosen
    and unverified), so colluding clients can no longer share a sector to correlate
    the same user across apps.
  - `auth_time` survives silent session rotation: sessions gain an immutable
    `authenticated_at` (new column, copied forward on every refresh), so a relying
    party's `max_age`/`prompt=login` reflects the real passkey ceremony instead of
    the last background token refresh.
  - Consent-screen anti-impersonation: client names are NFKC-normalised, reject
    bidi/zero-width/control characters, and are blocked when they fold to a
    confusable skeleton of a first-party app name (Musubi, OSN, Pulse, Zap, Cire).
  - Step-up tokens are bound to their ceremony purpose at every gate (passkey
    register/delete, email change, security-event ack), closing cross-ceremony
    replay of a still-unconsumed token.
  - Destructive passkey routes fail closed (409) on a presented-but-stale session
    binding instead of degrading to an account-wide session wipe (S-M2).
  - Minor OIDC hardening: generic token-endpoint errors (no internal cause on the
    wire), RFC 9207 `iss` on authorization responses, required browser-binding on
    every parked request (S-L4), a total-rows cap on client registration, and a
    branded HTML error page for pre-validation `/authorize` failures.

  **Client + UI (`@osn/client`, `@osn/ui`, `@osn/social`)**

  - New OIDC connections SDK; Settings → "Connected apps" now lists and revokes
    real connections (GDPR Art. 7(3)) instead of a hardcoded list.
  - The security-events banner is mounted (recovery-code generate/consume events
    now reach the user in-app), and the consent screen surfaces a verifiable
    identity signal (verified-app badge / third-party redirect host).
  - Consent UX: a `login_required` re-auth loop is capped, the profile picker gets
    a decline path, and a trailing-slash `/authorize/` no longer escapes the bare
    layout. CSP tightened (object-src/base-uri/form-action).
  - Recovery codes are guarded against silent loss on navigation after the old set
    is revoked; the rotation warning uses the component-library dialog; the
    step-up dialog explains why re-auth is needed; a failed passkey ceremony maps
    to an actionable recovery message.

### Patch Changes

- Updated dependencies [55a8ea8]
  - @osn/db@0.20.0
  - @shared/crypto@0.9.1

## 3.14.1

### Patch Changes

- 0c7dc46: Support `prompt=create` — let a relying party open the consent screen on its
  sign-up half.

  "Initiating User Registration via OpenID Connect 1.0". A relying party sends
  `prompt=create` when it knows the visitor has no account yet; the provider then
  leads with registration rather than sign-in, and the new user lands back on the
  app signed in, inside the same OIDC transaction.

  **`@osn/api`.** `prepareAuthorization` checks `create` before every other branch
  — a signed-in visitor who clicked "create an account" meant it — and parks the
  request with the same `requireAuthAfter = now` that `prompt=login` uses, so the
  decision only accepts a session created after the request arrived. Registration
  ends in an enrolled passkey and an adopted session, which satisfies that. The
  pre-existing rule that `none` may not be combined with another value already
  rejects `none`+`create`, so the branch is unreachable in silent mode.

  **`@osn/social`.** `AuthorizeSignIn` now holds both halves of "who are you" and
  swaps between them: a "No account yet? Create one" link under sign-in, and
  Cancel back from registration. It opens on registration when the server says
  `reason=create`. Without that second half a relying party's "Create account"
  button was a dead end — the screen only ever offered a passkey ceremony to
  someone who had no passkey. `reason` is advisory copy; the server re-derives
  every requirement at decision time, so a tampered value widens nothing.

  **`@shared/rp-auth`.** `signInUrl` takes an options bag, and `startCreateAccount`
  is the same journey opened on the sign-up screen. Only `create` is ever passed
  through.

## 3.14.0

### Minor Changes

- 2b7a7f1: Support relying parties that sign people in through the OSN OIDC issuer.

  - `@shared/rp-auth` (new): the browser half of a relying party — `signInUrl`,
    `startSignIn`, `fetchSession`, `signOut`, `createAuthFetch`, `readAuthError`,
    `clearAuthError`, `isAuthExpired` and `AuthExpiredError`, plus an
    `AuthProvider`/`useAuth` pair on the `/solid` sub-path. Every request carries
    `credentials: "include"`, because the RP holds its own session cookie and the
    browser never sees an OSN token.
  - `@shared/osn-auth-client`: new `verifyIdToken` — signature over the issuer's
    JWKS, `iss`/`aud`/`exp`/`nonce` checks, and the claims a relying party reads.
  - `@shared/crypto`: `timingSafeEqual` moved here from `@osn/api`, so both sides
    of a code exchange can compare secrets without one importing the other.
  - `@osn/api`: ID tokens for first-party clients now carry an `osn_profile_id`
    claim holding the real `usr_*` profile id, so a first-party app can address a
    person by the same id the ARC routes use instead of the pairwise `sub`. The
    internal profile-organisations route returns full organisation summaries
    (`organisations`) rather than bare `organisationIds` — the public
    `/organisations` projection still has no id, which is why the caller needs
    this one.
  - `@osn/social`: the settings page reads and writes the URL fragment, so other
    apps can deep-link to `/settings#security`. Passkeys are bound to this
    origin's RP ID and can only be managed here.

### Patch Changes

- Updated dependencies [2b7a7f1]
  - @shared/crypto@0.9.0

## 3.13.0

### Minor Changes

- 79b19e1: Move OSN identity to its own domain: osn-api on `id.musubi.social`, `@osn/social` on the
  `musubi.social` apex, WebAuthn RP ID `musubi.social`.

  Identity was living on `cireweddings.com`, a domain that belongs to one product. It now
  has a registrable domain of its own, which is what lets any later surface — cire, pulse,
  zap — sign in through the same issuer without borrowing another product's name.

  **`@osn/social` deploys to Cloudflare Pages.** `deploy.yml` gains a `deploy-osn-social`
  job publishing the app to the `osn-social` project, served at the apex. The apex is the
  right home rather than a subdomain: the RP ID is the registrable domain, so ceremonies
  run legally on `musubi.social` itself _and_ on every `*.musubi.social` surface added later.
  `__Host-osn_session` and the per-request `__Host-osn_oar_<12hex>` binding cookie are
  host-bound and `SameSite=Lax`, and apex → `id.musubi.social` is same-site, so they ride
  along on the consent screen's credentialed fetches. Feature-branch previews go to a
  separate `osn-social-preview` project — the preview workflow deploys to a project's
  production branch, so aimed at `osn-social` it would put unreviewed branch code on a
  live hostname.

  **osn-api production vars.** `OSN_RP_ID = musubi.social`, `OSN_ISSUER_URL =
https://id.musubi.social`, `OSN_ORIGIN = https://musubi.social`, `OSN_AUTHORIZE_UI_URL =
https://musubi.social/authorize` (unset, the provider falls back to `/authorize` on the
  first `OSN_ORIGIN` entry — right today by accident, so it stays explicit), plus a
  `custom_domain` route on `id.musubi.social`. `OSN_CORS_ORIGIN` keeps the three cire
  origins: these are two different lists, and CORS governs bearer-token calls, which
  still work cross-site. `OSN_ORIGIN` governs WebAuthn ceremonies, which do not.
  `OSN_EMAIL_FROM` stays `hello@cireweddings.com` — the only verified Resend sender, and
  moving it would fail closed and take OTP step-up with it.

  **Consumers repointed** at the new issuer: cire-api (`[env.production]` and
  `[env.preview]`, which shares production identity by design), zap-api, the cire
  organiser and guest build-time `PUBLIC_OSN_ISSUER_URL`, `@osn/social`'s
  `VITE_OSN_ISSUER_URL`, and the guest site's CSP `connect-src`.

  **Two costs, both accepted, both breaking.** Changing the RP ID invalidates every
  passkey enrolled under `cireweddings.com` — the private half is bound to the RP ID
  inside the authenticator, and no server-side change rebinds it. Recovery codes were
  minted for both production accounts first, and are the only way back in: recovery-code
  login → OTP step-up (`purpose: passkey_register`) → enroll → regenerate codes. And cire
  sign-in — organiser, vendor, guest linking — is down until those frontends move to the
  OIDC redirect flow, because a `cireweddings.com` origin can neither run a `musubi.social`
  ceremony nor replay a now-cross-site session cookie. Bearer-token verification is
  unaffected.

  The two dashboard steps neither wrangler nor CI can do — the apex on the `osn-social` Pages
  project, and `musubi.social` on the Turnstile widget's domain list — were done by hand on
  2026-07-27. Reasoning and cutover order in `wiki/runbooks/musubi-identity-migration.md`.

## 3.12.1

### Patch Changes

- 43a88ae: Fix two compare-and-swap gates that read the wrong rows-affected field on D1 —
  refresh rotation and passkey rename both failed on every production call.

  Drizzle reports rows affected differently per driver: bun:sqlite and
  better-sqlite3 use `{ changes }`, libsql uses `{ rowsAffected }`, and Cloudflare
  D1 uses `{ success, meta: { changes }, results }`. Both call sites read
  `changes ?? rowsAffected ?? 0`. Tests run on bun:sqlite and production runs on
  D1, so the gates were green in CI and read 0 for every write in production.

  - **Refresh rotation** (`services/auth/tokens.ts`). The old-session `DELETE` is
    the CAS; 0 rows means "a concurrent grant won the race". Reading 0 every time
    meant every production refresh deleted the session it was renewing, skipped
    the replacement INSERT, and answered `400 invalid_grant`. Access tokens live
    five minutes, so every session died at the first refresh — the long-standing
    "logged out for no reason" report. Prod backs this up: no session row has ever
    had `last_used_at` move past `created_at`.
  - **Passkey rename** (`services/auth/passkey-management.ts`). Same read, so a
    rename that updated the row still answered "Passkey not found".

  Both now go through `rowsChanged` from `@shared/db-utils`, which knows all
  three shapes. `cire/api` carried three copies of the same helper — one per
  service — so the fix lands in the one place every package already reaches for
  Drizzle helpers, and the copies are gone. Regression tests drive each osn gate
  through a driver proxy that reports counts D1-style, and unit tests in
  `@shared/db-utils` cover every shape plus junk input.

- Updated dependencies [43a88ae]
  - @shared/db-utils@0.4.0
  - @osn/db@0.19.1
  - @shared/crypto@0.8.11

## 3.12.0

### Minor Changes

- 0953024: Wire recovery codes into the settings UI, and fix the generate call that could never succeed.

  `generateRecoveryCodes` in `@osn/client` posted an empty body and no step-up token, so `POST /recovery/generate` answered 403 `step_up_required` every time. It now forwards the token, and `RecoveryCodesView` runs the passkey/OTP ceremony that mints it — the same `StepUpDialog` flow `PasskeysView` uses.

  Binds the generate gate to a purpose (S-M1). `POST /recovery/generate` now requires a step-up token minted with `purpose: "recovery_generate"`, so a token from another ceremony — an email change, a passkey delete — cannot be replayed against the one action that destroys an account's whole existing set. `StepUpDialog` gained a `purpose` prop and `@osn/client` forwards it through both `/complete` routes; a purposeless token is refused, with no legacy fallback.

  Adds `GET /recovery/status`, which reports how many codes an account has left and when the set was minted. It carries counts only, never a code, so it needs no step-up — gating it would be circular, since the answer is what tells a user whether starting a ceremony is worth it. The view leads with it, and says outright when an account has no codes at all.

  `RecoveryCodesView` is now mounted in Settings → Security in `@osn/social` (it previously rendered nowhere).

### Patch Changes

- Updated dependencies [0953024]
  - @shared/observability@0.13.0
  - @shared/crypto@0.8.10
  - @shared/email@0.4.4
  - @shared/turnstile@0.2.7

## 3.11.1

### Patch Changes

- d334152: Stop passkey add/remove from signing a Bearer-only caller out of every device.

  Passkey register (H1) and passkey delete (S-L3) revoke every session on the
  account except the caller's own, and the caller's own session was read only
  from the HttpOnly cookie. A request that authenticated with a Bearer access
  token but carried no cookie — a cross-origin call, a proxy that strips
  cookies, a native client — looked sessionless, so both paths took the "no self
  to preserve" branch and deleted **every** session on the account. Removing or
  adding a passkey logged the user out everywhere, including on the device they
  were using.

  Access tokens now carry a `osn_sid` claim: `sha256(session_hash + ":" + profile_id)`
  truncated to 128 bits. It is one-way (the session hash is itself a SHA-256 of a
  160-bit random token) and per-profile — sessions are account-scoped and shared
  across profile switches, so a plain session id would have let an observer tie
  two profiles of one account together, which P6 forbids. Recognition is by
  recomputation over the account's session rows (bounded by
  `MAX_SESSIONS_PER_ACCOUNT`), via the new `resolveSessionByBinding`. No new
  secret, no schema change.

  `issueTokens` and `refreshTokens` generate the session token before signing the
  JWT so the access token binds to the session it ships with — on refresh, the
  rotated-in session, not the retired one. `switchProfile` resolves the caller's
  session from the old profile's `osn_sid` and re-derives it for the target profile.

  Routes call one helper, `resolveCallerSession`: the cookie wins when it names a
  session that is still live, otherwise the `osn_sid` binding does. A cookie that
  is merely present no longer counts — a stale one hashes to a value matching no
  row, and passing that on would delete every session, the same failure through a
  different door. With neither a live cookie nor a resolvable binding the
  account-wide revocation stands, so a token minted before this claim existed
  degrades to the old behaviour rather than failing.

## 3.11.0

### Minor Changes

- 307a2c1: OIDC provider deferred-hardening batch — closes every deferred finding from the PR #315 prep-pr review that didn't genuinely need the consent-screen UI.

  **@osn/api (minor)**

  - **S-H1 (oidc)** — honest `auth_time` + enforced freshness. `verifyRefreshToken` now returns `authenticatedAt` (session `created_at`); codes and ID tokens carry the session's real authentication time instead of the code-mint time. `max_age` is parsed and bounded; exceeding it behaves like `prompt=login`; both park the request with `requireAuthAfter` and `/authorize/decision` refuses (`400 login_required`, request kept alive for retry) any session created before that instant, re-checking `max_age` at decision time.
  - **S-M1 (oidc)** — per-request browser-binding cookie. `/authorize` sets a 600 s HttpOnly `__Host-`-prefixed cookie per parked request; the store keeps only its SHA-256. Context reads without it 404 like an unknown id; decisions without it fail before the request is consumed.
  - **S-M2 (oidc)** — `RESERVED_OIDC_CLIENT_IDS` deny-list enforced at `findClient` (reserved ids read as absent); OIDC access tokens carry a `typ: "at+jwt"` header (RFC 9068) via a new optional `typ` parameter on `signJwt`.
  - **S-M3 / C-M3 (oidc)** — user-facing connections routes: `GET /oidc/connections` (live grants with client name/logo) and `DELETE /oidc/connections/:clientId` (revokes the consent and deletes in-flight authorization codes for the pair — withdrawal is immediate). Two new rate-limiter slots (`oidcConnectionsList` 30/min, `oidcConnectionsRevoke` 10/min) across the in-memory, Redis, and native-binding bundles.
  - **C-M1 (oidc)** — DSAR export gains an `oidc_consents` section (clientId, clientName, profileId, scope, grantedAt, revokedAt; revoked grants included as withdrawal history).
  - **P-W1/2/4/5, P-I3 (oidc)** — exchange and decision return their metric dimensions instead of re-reading the client/parked request; `recordConsent` is insert-first (`ON CONFLICT DO NOTHING`); the two token signatures run concurrently; client/consent reads use explicit projections. P-W3 declined: the `/token` reads are dependency-ordered — consuming the code before client auth would burn a victim's code on an attacker's failed attempt.
  - PKCE `code_challenge` is now required to be exactly 43 base64url characters (an S256 digest's only possible length); discovery advertises `auth_time`, `preferred_username`, `picture`, `email_verified`.
  - Prep-pr review fixes: `prompt=login` records its freshness demand on the signed-out park path too; a re-grant after revocation replaces the stored scope instead of resurrecting withdrawn scopes; the token exchange re-checks consent liveness (revocation is race-free); binding-mismatch errors are byte-identical to unknown-id errors; binding-hash compares are constant-time.

  - **Self-serve client registration** — `POST /oidc/clients` (server-generated `cid_`, secret shown exactly once with only its SHA-256 stored, https-only redirect URIs with loopback-http dev tolerance, no fragments, https-only `logo_url`, derived `sector_identifier`, `is_first_party` never settable, 5-live-clients-per-account cap), `GET /oidc/clients` (owner's list, never the secret), `DELETE /oidc/clients/:clientId` (disable — the client reads as absent everywhere at once). Three new rate-limiter slots (`oidcClientCreate` 5/hour on the hour-window tier, `oidcClientList` 30/min, `oidcClientDisable` 10/min). Account erasure disables and unlinks owned clients; DSAR export gains an `oidc_clients_owned` section.
  - New GitHub workflow `set-osn-pairwise-salt.yml` (`workflow_dispatch`, production environment): sets the `OSN_PAIRWISE_SALT` Worker secret idempotently — generates 64 random bytes in-job, never prints them, and refuses to touch an existing secret (rotation is forbidden by design).

  **@osn/db (minor)**

  - `oauth_clients` gains `owner_account_id` (nullable, references `accounts`) + `oauth_clients_owner_idx` (migration `0003_sleepy_mongoose`) — the self-registration ownership link.

  **@shared/observability (patch)**

  - `AuthRateLimitedEndpoint` widened with `oidc_connections_list`, `oidc_connections_revoke`, `oidc_client_create`, `oidc_client_list`, `oidc_client_disable`.

### Patch Changes

- Updated dependencies [307a2c1]
  - @osn/db@0.19.0
  - @shared/observability@0.12.3
  - @shared/crypto@0.8.9
  - @shared/email@0.4.3
  - @shared/turnstile@0.2.6

## 3.10.0

### Minor Changes

- f57a201: Add an OpenID Connect provider to osn-api, so any app can recognise an OSN
  account without holding a passkey of its own.

  Passkeys bind to one domain and cannot be moved, so every product that wants
  its own sign-in either shares the identity domain or asks the user to enrol
  again. This is the way out: the ceremony stays on the identity domain, and
  other apps get there by redirect.

  Three endpoints and a discovery document:

  - `GET /authorize` — authorization code flow, PKCE with S256 only. Errors
    follow RFC 6749 §4.1.2.1: until the client and its redirect URI are both
    known good the error is rendered, never redirected, so the provider cannot
    be turned into an open redirect. `prompt=none|login|select_account|consent`
    all behave as the spec says.
  - `GET /authorize/context` and `POST /authorize/decision` — what the consent
    screen reads and writes. The request id is single use, so an approval
    cannot be replayed into a second code.
  - `POST /oidc/token` — code for tokens. One code, one exchange; the code is
    deleted as it is read. Public clients must present no secret, confidential
    clients may use `client_secret_basic` or the body, never both.

  Subjects are pairwise: each client sees a `sub` derived by HMAC from its own
  sector and the profile, so two clients cannot join their records by user id.
  Codes are stored hashed, as session tokens already are.

  New tables in `@osn/db`: `oauth_clients`, `oauth_authorization_codes`,
  `oauth_consents` (migration `0002_wet_gamora`).

  Four rate limiters and their metric attributes come along with it. Both
  shared packages change only to widen a closed union — no behaviour moves.

  Before the next non-local deploy, set `OSN_PAIRWISE_SALT` (32 bytes or more)
  as a Worker secret. The check is fail closed: without it osn-api will not
  boot outside local. Set `OSN_AUTHORIZE_UI_URL` once the consent screen has a
  home; it falls back to `/authorize` on the web origin.

  See `[[wiki/systems/oidc-provider]]`.

### Patch Changes

- Updated dependencies [f57a201]
  - @osn/db@0.18.0
  - @shared/observability@0.12.2
  - @shared/redis@0.4.1
  - @shared/crypto@0.8.8
  - @shared/email@0.4.2
  - @shared/turnstile@0.2.5

## 3.9.11

### Patch Changes

- 6e7fbc5: Allow the guest invite site on osn-api's CORS and WebAuthn origin allowlists. The guest "Link my Pulse account" island talks to the OSN issuer from `invite.cireweddings.com`, but production `OSN_CORS_ORIGIN`/`OSN_ORIGIN` only listed the organiser and vendor portals, so every token call died on CORS. Adds the invite origin in production and `localhost:4321` to the local dev lists.

## 3.9.10

### Patch Changes

- Updated dependencies [f951187]
  - @shared/observability@0.12.1
  - @shared/crypto@0.8.7
  - @shared/email@0.4.1
  - @shared/turnstile@0.2.4

## 3.9.9

### Patch Changes

- Updated dependencies [945702c]
  - @shared/email@0.4.0

## 3.9.8

### Patch Changes

- e01206c: fix(auth): stop refresh-token rotation from logging users out on concurrent grants

  Refresh-token rotation revoked the entire session family whenever two grants of the same current token raced — multiple tabs bootstrapping on reload, a cold-start bootstrap racing a 401-refresh, or a retried grant after a lost response. That is a false positive (a replay of an already-rotated token can't reach the CAS branch; only concurrent use of the live token does), and it logged legitimate users out across every device well before the 30-day session TTL.

  Server (`@osn/api`): a 0-rows rotation CAS is now treated as benign concurrency (family preserved, `rotation_race` metric) instead of reuse, and `detectReuse` applies a short `ROTATION_GRACE_MS` (10 s) window — a rotated-out token replayed within the window is benign, outside it is still genuine reuse and still revokes the family. `RotatedSessionStore.check` now returns the rotation timestamp.

  Client (`@osn/client`): the bootstrap and refresh paths share one `/token` single-flight so a bootstrap racing a refresh in one tab fires the grant once.

## 3.9.7

### Patch Changes

- de286e2: Allow https://vendor.cireweddings.com in OSN_ORIGIN / OSN_CORS_ORIGIN so the new vendor portal can call the /organisations API cross-origin.

## 3.9.6

### Patch Changes

- 6a38d0f: Add `org:read` to the register-service permitted-scopes allowlist in `@osn/api` so downstream services (cire-api) can resolve OSN org membership over ARC for the Vendors feature. Add the `vendor-claim-invite` transactional email template to `@shared/email` (fail-soft: sent on claim-token minting; missing `RESEND_API_KEY` degrades to a logged no-op).
- Updated dependencies [6a38d0f]
  - @shared/email@0.3.4

## 3.9.5

### Patch Changes

- 9856ea5: Prune the transitional `app.cireweddings.com` origin from osn-api's production
  `OSN_ORIGIN` / `OSN_CORS_ORIGIN` allowlists now that the organiser portal has
  cut over to `host.cireweddings.com`. RP ID stays the registrable apex, so
  existing organiser passkeys are unaffected. Also drops a stale "deploy osn-api
  manually" comment (osn-api is CI-deployed since 2026-07-16).

## 3.9.4

### Patch Changes

- d32fd6f: CI: auto-deploy osn-api to production. Add a `deploy-osn-api` job to
  `.github/workflows/deploy.yml` (mirrors `deploy-cire-api`): on merge to `main` it
  applies the prod osn D1 migrations (`wrangler d1 migrations apply osn-db-prod
--remote --env production`) then deploys the Worker (`wrangler deploy --env
production`) against the already-set out-of-band secrets.

  Removes the last manual production deploy step. osn-api has been a deployed
  Cloudflare Worker (workerd + Upstash + native rate-limiters) since the 2026-06
  cutover, so the old "gated until the ioredis→Workers-Redis swap" reason in the
  `deploy.yml` stub was stale. Merging this PR runs the job, which also picks up the
  domain-reshuffle `OSN_ORIGIN`/`OSN_CORS_ORIGIN` (`host.cireweddings.com`) already
  on `main`. As with cire-api, osn's D1 migrations now auto-apply on merge.

## 3.9.3

### Patch Changes

- c256caf: Domain reshuffle (organiser portal `app.cireweddings.com` → `host.cireweddings.com`):
  add the new portal origin to osn-api's prod WebAuthn/CORS allowlists.
  `[env.production].OSN_ORIGIN` and `OSN_CORS_ORIGIN` now list
  `https://host.cireweddings.com,https://app.cireweddings.com` (both kept for the
  switchover window; prune `app.` after the move + verify).

  `OSN_RP_ID` stays `cireweddings.com` (the registrable apex), so existing organiser
  passkeys keep working on the new subdomain with no re-registration — credentials
  are scoped to the RP ID, not the full origin. osn-api is deployed MANUALLY (not
  CI): run `cd osn/api && bunx wrangler deploy --env production` after this merges
  for the var change to take effect.

## 3.9.2

### Patch Changes

- 7a36be4: Test-hardening (test-only, no production behaviour change): add direct,
  deterministic coverage for the refresh-rotation compare-and-swap (CAS)
  family-revoke branch in `refreshTokens` (landed in #253).

  Previously the happy path and the `verifyRefreshToken` → `detectReuse` reuse
  path were tested, but the CAS-0-rows branch — where the session row is present
  at verify time yet the rotation DELETE reports 0 rows affected (a concurrent /
  replayed writer already rotated it out) — had no direct test. The new test
  proxies the drizzle `Db` handle to force the DELETE to report 0 rows on demand
  (the row is genuinely removed, mirroring a lost CAS) and asserts the reuse
  guarantee: the whole session family is revoked, no sibling session is minted,
  and the reuse / family-revoke metrics fire. A control case proves the
  interception — not a broken layer — is what drives the branch.

## 3.9.1

### Patch Changes

- f569c7c: Harden ARC S2S auth: bind the public-key cache to `(issuer, kid)` and fix Origin-guard S2S drift.

  The ARC public-key cache was keyed by `kid` alone, so a cache hit returned the
  key for whatever `issuer` the caller passed — silently skipping the
  `serviceId == issuer` DB binding that only runs on the miss path. The same
  forged-`iss` token was therefore rejected on a cold cache but accepted on a warm
  one. The cache is now keyed by `(issuer, kid)` so the binding holds on both
  paths; `evictPublicKeyCacheEntry` scans the composite keys. `verifyArcToken` now
  requires `exp`/`iat`/`iss`/`aud` via jose `requiredClaims` so a token minted
  without `exp` can never be treated as non-expiring.

  The Origin-guard's hardcoded S2S exemption list had drifted from the real
  internal route prefixes (`/internal/*` was unlisted and `/organisation-internal`
  matched no route), so in production every ARC POST to `/internal/*` was 403'd
  before ARC verification ran. The guard now exempts on the `Authorization: ARC`
  header (immune to route renames) with segment-boundary path matching as a
  secondary signal.

- f569c7c: Harden deployment posture and the Pulse Worker's JWKS scheme check.

  - Pulse's Workers entry now fails closed when `OSN_JWKS_URL` is missing or
    plaintext `http://` in a non-local env (mirrors zap-api), so a misconfigured
    JWKS URL can't let a network attacker serve a forged key set.
  - `workers_dev = false` on the top-level (env-less) wrangler configs for osn-api
    and cire-api, and the `deploy` scripts are now `wrangler deploy --env
production`. A bare `wrangler deploy` (which binds the production D1 with a
    local security posture) now fails loudly instead of publishing a public shadow
    Worker. Real deploys go through `--env production`; CI migrations are
    unaffected.

- f569c7c: Close org privilege-escalation via add/remove and gate the member roster.

  The owner-only role gate (`updateMemberRole`) was bypassable: `addMember` let
  any admin insert a target as `admin`, and `removeMember` let any admin remove
  other admins — so an admin could mint or strip admins via remove+add. Granting
  `admin` now requires the owner, and removing an admin now requires the owner;
  admins may still add and remove plain members.

  `GET /:handle/members` returned the full roster (handles, display names, roles)
  to any authenticated user with no membership check. It is now restricted to
  members of the org. If public org pages are desired later, gate on an explicit
  `organisations.visibility` flag rather than dropping the check.

- f569c7c: Make refresh-token rotation atomic (compare-and-swap on the old session).

  `refreshTokens` verified the session then deleted-old/inserted-new in a batch.
  Two concurrent refreshes presenting the same token both passed verification and
  both inserted a new session, leaving two live sessions in one family with reuse
  detection never firing. The old-session DELETE is now the CAS gate: rotation
  proceeds only while the old row still exists (rows-affected == 1); a 0-rows
  result means the token was already rotated out (concurrent refresh or replay),
  which is treated as C2 reuse — the whole family is revoked instead of minting a
  sibling session. Mirrors the recovery-code CAS already in this file.

- Updated dependencies [f569c7c]
  - @shared/crypto@0.8.6

## 3.9.0

### Minor Changes

- 6b14961: C-H1 — account data export (`GET /account/export`, DSAR Art. 15 / 20 + CCPA).

  Self-service, step-up gated (new `account_export` step-up purpose), rate-limited
  to 1 export / 24 h / account. Streams the locked NDJSON bundle
  (`{"version":1,...}` header → `{"section","record"}` lines → `{"end":true}`
  terminator) via a `ReadableStream`, so the response never materialises the full
  dataset. osn's own sections (account, profiles, passkeys, sessions,
  security_events, recovery_codes counts, email_changes, connections, blocks,
  organisations) are read with keyset pagination (`LIMIT 500 WHERE id > :cursor`,
  no OFFSET). The internal `accountId` is never emitted (P6 invariant).

  The `pulse.*` / `zap.*` sections are fetched over ARC (new `account:export`
  scope, registered downstream alongside `account:erase`) from a new
  `POST /internal/account-export` on each app and streamed through the outer
  envelope line-by-line; a failing bridge degrades to a `{"degraded":...}` line
  rather than breaking the stream. Pulse returns rsvps / events-hosted /
  close-friends; Zap returns chat memberships only (message ciphertext excluded).

  Also builds Zap's inbound-ARC infrastructure from scratch (it previously had
  none): `zap/api` gains an `arc-middleware` (`requireArc` + key registry +
  `register-service` bootstrap) mirroring Pulse's, closing the latent gap where
  osn's cross-service fan-out targeted a Zap `/internal` surface that did not
  exist.

  `@shared/observability` adds the `account_export` value to the `StepUpPurpose`
  metric-attribute union.

- 6b14961: C-H8: COPPA under-13 age gate on registration.

  `POST /register/begin` now requires a `birthdate` (`YYYY-MM-DD`). The
  registration service validates the date format (`BirthdateSchema`) and then
  hard-rejects any registrant under 13 with a new `AgeRestrictionError` →
  HTTP 422 `{ error: "age_restricted", message: "OSN is for users 13 and older" }`
  — **before** any collision probe or OTP dispatch, so OSN never gains "actual
  knowledge" of a child's data. The birthdate is a transient argument and is
  never written to any store or table (no rejected or accepted DOB retained).

  The client SDK's `beginRegistration` gains a required `birthdate` field, and
  `@osn/ui`'s `Register` form adds a date-of-birth input that mirrors the gate
  client-side for immediate feedback (the server remains authoritative). The
  legacy, unrouted `registerProfile` seed helper is intentionally left ungated.

  Also hardens `publicError`: `Effect.runPromise` rejects with a `FiberFailure`
  that stores the tagged error under a symbol-keyed `Cause`, which the previous
  walker never traversed — so every Effect failure silently fell through to the
  default 400. The walker now descends through all own keys (including symbols)
  and skips Effect's internal Cause tags, so tagged errors like
  `AgeRestrictionError` (422) map to their real status.

### Patch Changes

- Updated dependencies [6b14961]
  - @shared/observability@0.12.0
  - @shared/crypto@0.8.5
  - @shared/email@0.3.3
  - @shared/turnstile@0.2.3

## 3.8.10

### Patch Changes

- 630e98f: TODO-backlog hardening sweep:

  - **S-H (arc-scope-pattern)** — `@shared/crypto` `SCOPE_PATTERN` rejected hyphens, so every ARC token minted with the deployed hyphenated scopes (`step-up:verify`, `app-enrollment:write`) threw `Invalid scope format` at sign time — the Flow B leave-Pulse fan-out was broken end-to-end. Pattern now admits `-`; regression-tested round-trip.
  - **S-H1 (arc-key-scopes, prep-pr review) — mitigation** — osn-api stores `allowedScopes` per SERVICE (upsert = full replace) while pulse-api registers TWO keys under one serviceId; disjoint scope sets clobbered each other on every boot race / 24h rotation, randomly fail-closing either the graph bridge or Flow B. Both pulse registrations (graphBridge + outbound-arc) and the seed now carry the identical four-scope union, and the false "per-key isolation" comment is corrected. Real per-key scope storage is tracked in wiki/TODO.md.
  - **S-L1 (prep-pr review)** — osn-api's `requireArc` early exits (malformed token, unknown/revoked kid, registry scope denial) now record the shared `arc.token.verification` counter, mirroring the pulse receiver; infra (DB-query) failures are excluded from the counter.
  - **S-M1 (pulse-onboarding)** — dedicated `graph:resolve-account` ARC scope gates `GET /graph/internal/profile-account` (least privilege on the profileId → accountId lookup). Granted to pulse-api (self-registration + seed) and cire-api (runbook); a `graph:read`-only token now gets 401 on that endpoint.
  - **S-L6 (account-deletion)** — Pulse `requireArc` now records the shared `arc.token.verification` counter on its early-exit branches (malformed / kid-unknown / kid-revoked / registry-scope-denied); new bounded `revoked_key` result value in `@shared/observability`.
  - **S-M4 (auth)** — `loadJwtKeyPair` asserts the imported `OSN_JWT_PRIVATE_KEY` carries the `sign` usage, failing at boot when the public JWK is pasted into the private slot.
  - **S-L5 (auth)** — boot-time assertion that `OSN_ORIGIN` is set in non-local envs (mirrors the CORS fail-closed guard) instead of silently falling back to the localhost WebAuthn origin.
  - **M3 (Copenhagen)** — `EmailSchema` caps emails at 255 chars.
  - **Dead metric cleanup (pulse)** — `pulse.auth.jwks_cache.lookups` deleted (cache moved to `@shared/osn-auth-client`, uninstrumented); `pulse.events.create.duration` wired around `createEvent` via `withEventCreateDuration`; `pulse.events.host_cancelled.hard_delete` wired into `runEventCancellationSweep`.

- Updated dependencies [630e98f]
  - @osn/db@0.17.3
  - @shared/crypto@0.8.4
  - @shared/observability@0.11.2
  - @shared/email@0.3.2
  - @shared/turnstile@0.2.2

## 3.8.9

### Patch Changes

- f62784d: Code-quality sweep: lint-config repair + convention fixes monorepo-wide.

  - oxlint config: pin rules that leaked in via an upstream category re-shuffle
    (`no-underscore-dangle` off — Effect `_tag` is idiomatic;
    `unicorn/consistent-function-scoping` off — boot-time factory modules and
    Effect-context DI make it noise; `no-await-in-loop` off in tests), raise
    `jsx-a11y/control-has-associated-label` depth for Solid control-flow
    wrappers. 463 → 21 warnings; the survivors are the deliberate aspirational
    jsx-a11y set.
  - S-M5 (osn): `/account` erasure endpoints now thread `clientIpConfig` +
    socket peer into per-IP rate-limit keying (spoofable XFF no longer picks
    the bucket; unresolved IPs are denied, S-M34 posture) — with route tests.
  - pulse/api + zap/api route factories now build their Effect layer graph once
    per factory via `ManagedRuntime` instead of `Effect.provide(dbLayer)` inside
    every request (convention: `osn/api/src/lib/route-runtime.ts`); dead
    pre-instantiated route-group exports removed.
  - Dead exports removed: `decodeSession` (@osn/client), `getHandleFromToken`
    (@pulse/app).
  - Assorted lint fixes: variable shadowing renames, unused imports, promise
    handling in `TurnstileWidget`, `toSorted` in tests.

## 3.8.8

### Patch Changes

- 368e3e8: Performance audit sweep (versioned packages). No behavioural or security
  changes — fail-closed rate limiting, visibility gates, consent checks,
  single-use guarantees, and tenant scoping are preserved exactly.

  - `@zap/api`: `listChats` is cursor-paginated (default 50, max 100) with a
    composite `(createdAt, id)` keyset cursor (same-second creation bursts are
    never skipped) and caller-scoped cursors (unknown/foreign cursors
    rejected); `getChatMembers` is limit/offset-paginated (default 100, max 500) and skips its redundant existence load when the route has already
    asserted membership; both list responses carry `hasMore` (+ `nextCursor`
    for chats) continuation metadata; `addMember` checks the member cap with
    `COUNT(*)` instead of fetching every member row.
  - `@osn/api`: ceremony-store TTL sweep debounced to once per 30s (hard cap
    still enforced on every set); `beginRegistration`/`registerProfile`
    uniqueness probes collapsed to one round-trip via `UNION ALL` of two
    indexed single-table arms (an `OR` across the users-accounts join defeats
    SQLite's OR-optimization and plans as a full table scan);
    `sendConnectionRequest` reads run concurrently; `consumeRecoveryCode` is a
    single atomic conditional `UPDATE … RETURNING` (also closes the remaining
    check-then-act window); `countActiveRecoveryCodes` is a SQL aggregate that
    no longer fetches `code_hash` values; redundant accounts read moved out of
    the identified passkey-login path; per-call `TextEncoder` allocation and
    per-issuance `process.env` reads hoisted to module scope.
  - `@pulse/api`: status-transition persistence batched to one `UPDATE … WHERE
id IN (…)` per (from → to) group across all five list surfaces (was up to
    500 writes per GET on series instances); `updateSeries`/`cancelSeries`
    collapsed to single race-free `UPDATE … RETURNING`; `listTodayEvents`
    capped at 200 rows; RSVP routes thread the already-loaded event row into
    `listRsvps`/`rsvpCounts`/`latestRsvps`; `createEvent` uses `INSERT …
RETURNING`; `GET /events/:id/ics` sends `Cache-Control: private,
no-cache` + a weak ETag and honours `If-None-Match` (including `*` and
    multi-value lists) with 304 — every reuse revalidates through the
    visibility gate.
  - `@pulse/db`: new `event_rsvps_event_status_idx (event_id, status)`
    composite index; the subsumed single-column `event_rsvps_event_idx` is
    dropped (migration 0008).
  - `@osn/client`: `RegistrationClient.checkHandle` accepts an optional
    `AbortSignal` so debounced callers can cancel stale availability probes.
  - `@osn/ui`: `Register` and `CreateProfileForm` abort the previous in-flight
    handle check before issuing a new one and on unmount.
  - `@pulse/app`: Explore map resize handling is debounced (100 ms), grid
    geometry is memoized per size, and theme detection is a reactive
    `MutationObserver`-driven signal instead of a per-access DOM read.

## 3.8.7

### Patch Changes

- 5aa3273: Refactor the auth monoliths into module directories, behaviour-preserving. `services/auth.ts` (~4,500 lines) becomes `services/auth/` — domain factories (profiles, registration, tokens, passkeys, passkey management, profile switch, sessions, recovery, security events, step-up, email change, cross-device) composed over a shared `AuthContext` by `index.ts`; the three duplicated security-notification mailers collapse into one shared helper. `routes/auth.ts` (~1,800 lines) becomes `routes/auth/` — one Elysia route group per domain over a shared `AuthRouteContext`, mounted by `index.ts`. Public surfaces and import paths are unchanged.

## 3.8.6

### Patch Changes

- f4b9c6b: Upgrade oxlint to 1.70; satisfy tightened vitest rules — add toThrow messages and fix standalone-expect in test suites
- Updated dependencies [f4b9c6b]
  - @osn/db@0.17.2
  - @shared/crypto@0.8.3

## 3.8.5

### Patch Changes

- Updated dependencies [5d6a97c]
  - @shared/observability@0.11.1
  - @shared/crypto@0.8.2
  - @shared/email@0.3.1
  - @shared/turnstile@0.2.1

## 3.8.4

### Patch Changes

- 5add635: Handle prefix search for co-host autocomplete.

  - `@osn/db`: add a B-tree index on `users.handle` (`users_handle_idx`) to back
    left-anchored `LIKE 'prefix%'` scans, with forward-only migration
    `0001_exotic_lady_vermin.sql`. DEPLOY: this migration must be applied to
    osn-db-prod manually at deploy time — it is NOT in CI's `deploy.yml`
    (`bun run --cwd osn/db db:migrate:prod`).
  - `@osn/api`: new ARC-gated `GET /graph/internal/profile-search?prefix=&limit=`
    (scope `graph:read`, audience `osn-api`, same guard as the sibling internal
    endpoints). Normalises the prefix like `profile-by-handle` (strips `@`,
    lowercases), requires a minimum prefix length of 2 (returns an empty list,
    not an error, below it), excludes tombstoned/soft-deleted accounts
    (`deletedAt IS NULL`), escapes `LIKE` wildcards in the user input, orders by
    handle, and hard-caps results at 10 (default 8). Returns
    `{ profiles: [{ id, handle, displayName, avatarUrl }] }`.

- Updated dependencies [5add635]
  - @osn/db@0.17.1
  - @shared/crypto@0.8.1

## 3.8.3

### Patch Changes

- 59a1dab: Raise the per-IP rate limits on the auth endpoints that legitimately auto-fire,
  which were tripping a 429 on normal sign-in. `passkey_login_begin` is fired by
  the passkey **conditional-UI / autofill** ceremony on every login-page load, and
  `handle_check` fires as-you-type during registration — both were capped at
  10/min/IP, which a couple of page reloads exhausted. New per-IP/60s tiers:
  `passkey_login_begin` 10 → **60**, `passkey_login_complete` 10 → **20**,
  `handle_check` 10 → **30** (native Workers binding tiers + the local in-memory
  mirror). The security-relevant gates (`register_complete`, `*_complete`,
  step-up, recovery, email-change) are unchanged — begin is cheap and completion
  still requires a valid assertion.

## 3.8.2

### Patch Changes

- c261a5f: Fix two auth-path bugs that only surfaced on the deployed Cloudflare Worker
  (workerd).

  - **Bug A — `/graph/internal/register-service` + `/service-keys/:keyId` 500
    ("crypto.timingSafeEqual is not a function").** The `INTERNAL_SERVICE_SECRET`
    bearer check compared the header with the GLOBAL `crypto` (Web Crypto), which
    has no `timingSafeEqual` on workerd, so the compare threw and the request
    500'd — blocking the cire→osn ARC key registration (the "add hosts by handle"
    feature). The compare now uses a new workerd-safe `timingSafeEqualString`
    helper (`osn/api/src/lib/timing-safe.ts`) backed by `node:crypto`
    (`nodejs_compat`), keeping the constant-time property and the length-mismatch
    guard. `osn/api/src/services/auth.ts` now reuses the same shared helper
    instead of its private copy.

  - **Bug B — organiser "Security → add a passkey" returned 401 "unauthorized".**
    `/passkey/register/{begin,complete}` resolved the enrol principal by requiring
    the client to echo a `body.profileId` exactly equal to the access token's
    `sub`. When the client's notion of the active profile drifted from the token's
    `sub` (e.g. after a silent token refresh re-issues the access token for the
    account's default profile), this produced a spurious 401. The principal is now
    resolved from the access token's OWN verified `sub` (the same pattern
    `/step-up/passkey/*` already uses), so enrolment always binds to the caller's
    own account; the client-supplied `profileId` is no longer a trust input and a
    foreign `profileId` can never redirect enrolment onto another account.

  - **Bug C — organiser login looped back to login once Turnstile was enabled.**
    `/login/passkey/begin` is hit by TWO frontend paths: the interactive
    identifier-bound form (renders the Turnstile widget, carries a token) and the
    silent conditional-UI / passkey-autofill ceremony (NO identifier, NO token, by
    design). With Turnstile configured the gate fail-closed on EVERY caller, so the
    autofill path — the common way passkey users sign in — got `turnstile_failed`
    and bounced back to login. The gate now fires only when a non-empty
    `identifier` is present (the interactive form); the no-identifier conditional-UI
    ceremony is exempt — it discloses nothing account-specific, still requires a
    valid passkey assertion to complete, and stays per-IP rate-limited.

## 3.8.1

### Patch Changes

- d541a79: ops: email is now required in prod (Resend delivery confirmed from hello@cireweddings.com) — removed the `OSN_EMAIL_OPTIONAL` degraded opt-in from osn-api's production vars, so osn-api fails closed at startup if `RESEND_API_KEY` is ever absent rather than silently dropping OTP/security mail. Also activated the Cloudflare Turnstile sitekey in the cire/web + cire/organiser Pages builds (`deploy.yml`), reading the `PUBLIC_TURNSTILE_SITEKEY` repo Variable; the matching `TURNSTILE_SECRET_KEY` is set on the osn-api + cire-api Workers (sitekey-first rollout so the gate never blocks before the widget is live).

## 3.8.0

### Minor Changes

- 0880d75: Add Resend as osn-api's preferred transactional-email transport.

  `@shared/email` gains `ResendEmailLive` (`makeResendEmailLive`) — POSTs to Resend's HTTP API (`https://api.resend.com/emails`, bearer-authed), works on workerd with no paid Workers plan. It reuses the exact template/render path of `CloudflareEmailLive` and matches its instrumented-fetch, span, metric, and non-2xx → tagged-failure semantics (429 → `rate_limited`, other non-2xx → `dispatch_failed`, fetch reject → `api_unreachable`). The `RESEND_API_KEY` is placed only in the `Authorization` header — never in a URL, span/metric attribute, log, or `EmailError.cause`.

  `osn/api`'s `selectEmailLayer` now prefers Resend: precedence is **Resend → Cloudflare (legacy fallback) → local Log → `OSN_EMAIL_OPTIONAL` Noop → throw**. `RESEND_API_KEY` is added to the Worker `Env` type. Key-optional / non-breaking: with no key, behaviour is exactly as before. With Resend configured, `OSN_EMAIL_OPTIONAL` is no longer needed (a future Resend outage then fails closed like any normal misconfig).

### Patch Changes

- Updated dependencies [0880d75]
  - @shared/email@0.3.0

## 3.7.0

### Minor Changes

- 44b0982: Add an ARC-gated internal endpoint `GET /graph/internal/profile-by-handle` that
  resolves an OSN handle (e.g. `@alice`) to its profile id (plus handle +
  display name), or 404. Requires audience `osn-api` + scope `graph:read`, mirrors
  the existing `/profile-account` route, and applies the same tombstone rule (a
  soft-deleted account is invisible during the grace window). Handle input is
  normalised (strips a leading `@`, lowercases) before the exact-match lookup.

  Consumed by cire to turn an organiser-typed handle into a `usr_*` id when adding
  a wedding co-host — cire has no other way to map a handle to a profile id.

- 5055e1a: OSN core auth hardening (W6):

  - **O1 — issuer pinning + clock tolerance.** Access and step-up JWTs are now
    signed with `iss = AuthConfig.issuerUrl` and verified with `issuer` pinned +
    a 30s `clockTolerance` at every verify site (local signer + verifier half;
    the downstream `@shared/osn-auth-client` verifier is W7). Rollout is
    verifier-first: the tolerant verifier must deploy before the signer enforces
    `iss`.
  - **O2 — recovery-code per-account lockout.** `consumeRecoveryCode` now counts
    failed attempts keyed on the RESOLVED accountId (threshold 5, 15-min
    lockout), Redis-backed with an in-memory fallback. Lockout returns the same
    generic error (no enumeration oracle), writes a `recovery_code_lockout`
    security-event row, and resets on success. Unknown identifiers never lock a
    victim.
  - **O3 — full Redis ceremony-store epic.** Every process-local ceremony /
    pending-state store (registration + login + step-up challenges, pending
    registrations, step-up OTP, pending email changes, cross-device requests) now
    has an injectable Redis-backed implementation alongside the in-memory default,
    plus the two per-account caps (profile-switch, email-change-begin) routed
    through the rate-limiter family. New `RedisNamespace` metric union in
    `@shared/redis` and per-namespace store telemetry.
  - **O4 — passkey-register cookieless fix.** `completePasskeyRegistration` now
    invalidates ALL account sessions (with a logged anomaly + invalidation
    metric) when no caller session is resolvable, instead of silently skipping
    H1 invalidation.
  - **O5 — randomised enumeration-probe sentinels.** The fixed `acc_enum_probe` /
    `__nonexistent__` burn-in keys are now per-request random non-matching ids.

  `@shared/observability` adds the `recovery_code_lockout` security-event kind.

- dbed689: Rate-limit + IP-trust hardening for osn-api behind Cloudflare.

  - **Client-IP trust (security fix):** the non-local Workers runtime now keys per-IP rate limiting on `cf-connecting-ip` exclusively (`trustCloudflare: true`), never the spoofable `x-forwarded-for`. This closes the bypass where an attacker forged XFF to rotate past the per-IP auth limits. Local Bun dev keeps socket-peer keying; `TRUSTED_PROXY_COUNT` is now ignored in deployed tiers. Unresolved IPs still deny (429), never bucket-share.
  - **Native Workers rate limiting:** the 60-second-window per-IP auth limiters move off Upstash onto the Cloudflare Workers native Rate Limiting binding (global + atomic at the edge, fail-closed). The three 1-hour-window per-IP limiters (recovery generate/complete, email-change-begin), every per-user/per-account limiter, and every stateful store stay on Upstash. `createWorkersRateLimiter` + `WorkersRateLimitBinding` are now shared from `@shared/rate-limit`.
  - **Workers observability:** `[observability]` enabled in `osn/api/wrangler.toml` (and every named env) so Workers Logs/invocations are captured in the Cloudflare dashboard.

  Per-colo trade-off accepted: native rate limiting is counted per Cloudflare location, not globally. osn-api must be redeployed for the new bindings + observability to take effect.

- 5aa1594: osn-api runs on Cloudflare Workers (`export default { fetch, scheduled }`).

  `osn/api/src/index.ts` is now the workerd entry, mirroring cire's proven
  template: a per-isolate `cached` app, fail-closed 503 on missing
  bindings/vars, everything built from the request-scoped `env` binding (not
  module-top `process.env`), and a cron `scheduled` handler that runs the
  account-erasure fan-out-retry + hard-delete sweeps (replacing the Bun
  `setInterval`). The Bun dev server moved into `src/local.ts` and is unchanged
  in behavior (default `bun run dev`); a runtime-agnostic `src/build-deps.ts`
  holds the shared composition both entries call.

  Highlights:

  - S-L1: the Workers Redis path env-gates the in-memory fallback — a deployed
    Worker (`OSN_ENV` set & != "local") with missing Upstash bindings fails
    closed at construction instead of silently downgrading rate-limiters /
    step-up-jti to per-isolate in-memory.
  - P-I3: the Upstash client + Effect runtime + Elysia app are built once per
    isolate and cached, never reconstructed in the request path.
  - S-H3: the Workers entry re-applies the `x-request-id` sanitize-and-echo the
    omitted observability plugin used to do.
  - Secrets (`INTERNAL_SERVICE_SECRET`, `PULSE_API_URL`/`ZAP_API_URL`) are
    threaded through `env`/the `createApp` factory instead of module-top
    `process.env` reads, since workerd surfaces secrets only on `env`.
  - `createApp` gains an `aot` flag (Workers passes `false`; AOT's `new
Function` is forbidden on workerd) and keeps `includeObservabilityPlugin:
false` + the redacting `osnLoggerLayer` on the Workers path.

  `@osn/db` / `@shared/db-utils`: `DbLive`'s bun:sqlite path is resolved lazily
  (`makeDbLive` now accepts a path thunk) so `fileURLToPath(import.meta.url)` no
  longer runs at module load — it threw on workerd, where `import.meta.url` is
  undefined, even though the Workers path never builds the bun:sqlite layer.

  wrangler.toml gains `main`, the real per-env D1 ids, per-env `[vars]`, and a
  6-hourly `[triggers] crons` for the sweeper. New devloop scripts: `dev`
  (unchanged fast Bun loop), `dev:wrangler` (workerd + local D1 + in-memory
  Redis, no external services), `deploy`, `types`, `build`.

- aed9d98: Add a Workers-compatible Upstash REST Redis backend (migration Phase 2).

  `@shared/redis` now ships three interchangeable `RedisClient` backends behind
  the same interface, split so the Workers bundle never statically imports
  `ioredis` (which needs Node `net`/`tls` sockets and cannot run on workerd):

  - **ioredis split to a subpath.** `wrapIoRedis`, `createClientFromUrl`,
    `ConnectableRedisClient`, and the Effect `RedisLive` layer moved to a new
    `@shared/redis/ioredis` subpath export. The top-level `@shared/redis` entry
    now exports only the `RedisClient` interface, the in-memory client, and the
    new Upstash client — no static `ioredis` import in its graph.
  - **Upstash adapter.** New `@shared/redis/upstash` with `wrapUpstash(redis)`
    and `createUpstashClient({ url, token })`. `createUpstashClient` sets
    `automaticDeserialization: false` so `get` returns raw strings (matching
    ioredis and the rotated-session-store's opaque family-id round-trips); `set`
    maps `pxMs` to `{ px }`; `eval` passes the script/keys/args straight through
    (preserving numeric returns for the rate-limit Lua and the `1`/`"1"` step-up
    jti check); `quit` is a no-op for the stateless REST transport.

  `@osn/api` gains `initRedisClientFromEnv(env)` — a synchronous, ioredis-free,
  side-effect-free selector that returns `createUpstashClient(...)` when both
  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are present on the
  Workers `env` binding, else an in-memory client. It performs no startup health
  check, has no `REDIS_REQUIRED` fail-closed mode, and never calls
  `process.exit` — those stay on the Bun `initRedisClient` path, which is
  unchanged. Consumers (rate limiters, rotated-session/step-up/ceremony stores)
  remain backend-agnostic; no call sites changed.

- d81383d: Add Cloudflare Turnstile bot protection to the OSN auth surface (key-optional, fail-closed).

  New `@shared/turnstile` package exposes `createTurnstileVerifier(secret?)` — a key-optional, fail-closed siteverify helper. When the `TURNSTILE_SECRET_KEY` secret is **unset** the verifier is `null` and every gate is skipped (flows behave exactly as before — safe to merge before the widget exists). When **set**, it POSTs the token to Cloudflare's managed `siteverify` endpoint via `instrumentedFetch`, passing the caller's `cf-connecting-ip` as `remoteip`, and rejects on any missing / invalid / expired / duplicate (single-use) token or unreachable endpoint. The secret is never logged or returned to the client.

  - **`@osn/api`**: `/register/begin` and `/login/passkey/begin` are gated. The verifier is built once per isolate in `build-deps.ts` from `env.TURNSTILE_SECRET_KEY` and threaded through `createAuthRoutes`; a configured gate fails closed with `400 turnstile_failed`. New bounded metric `osn.auth.turnstile.rejected{endpoint}`.
  - **`@osn/client`**: `RegistrationClient.beginRegistration` and `LoginClient.passkeyBegin` accept an optional `turnstileToken`, sent on the begin call (omitted cleanly when absent — the no-Turnstile call shape is unchanged, and the silent conditional-UI passkey ceremony carries no token).
  - **`@osn/ui`**: new `TurnstileWidget` (Solid) renders Cloudflare's widget only when a `siteKey` prop is provided (lazy-loads `api.js`, `data-action="turnstile-spin-v1"`); `Register` + `SignIn` take an optional `turnstileSiteKey` prop and gate submit on a solved challenge. Omitted ⇒ no widget, no gate.

  The sitekey is public (embedded in client HTML at build time via `PUBLIC_TURNSTILE_SITEKEY`); the secret is a `wrangler secret` on osn-api. Both halves are optional and graceful, mirroring the maps-embed key and `OSN_EMAIL_OPTIONAL` precedents.

### Patch Changes

- 892fe3e: Wire the `cireweddings.com` custom domain into osn-api's production config. OSN
  identity runs under the cireweddings.com zone for now (a dedicated OSN domain is
  deferred). In `osn/api/wrangler.toml` `[env.production]`:

  - `OSN_RP_ID = "cireweddings.com"` — the WebAuthn RP ID is the registrable apex
    shared by the organiser portal (`app.cireweddings.com`), the only prod passkey
    surface. Prod passkeys are now UNBLOCKED (previously deferred pending a domain).
  - `OSN_ORIGIN = "https://app.cireweddings.com"` — the organiser portal is the
    passkey origin.
  - `OSN_ISSUER_URL = "https://id.cireweddings.com"` (JWT `iss`).
  - `OSN_CORS_ORIGIN = "https://app.cireweddings.com"` — only the organiser portal
    calls osn-api; an empty list throws at boot.
  - `OSN_EMAIL_FROM = "noreply@cireweddings.com"`.
  - A custom-domain route `[[env.production.routes]]` (`pattern =
"id.cireweddings.com"`, `custom_domain = true`) serving the Worker on
    `id.cireweddings.com` — auto-provisions DNS + cert since the zone is in-account.

  Config-only; no app logic changed. dev/staging keep their current config. Validated
  with `wrangler deploy --env production --dry-run`.

- 7c7fab4: Refactor osn/api into a pure `createApp` factory + a Bun dev entry, with no
  behaviour change (Phase 1 of the Cloudflare Workers migration).

  - `src/app.ts` exports `createApp(deps)` — the Elysia route composition,
    verbatim — taking an explicit `AppDeps` struct (auth config, cookie config,
    CORS origins, origin guard, rate limiters, stores, layers, shared
    `appRuntime`). It never reads `process.env`.
  - `src/local.ts` owns all env-driven Bun wiring: `buildAppDeps()` loads the JWT
    key pair, validates the session-IP pepper, initialises Redis-backed stores +
    rate limiters, selects the email transport, and builds the Effect layer graph
    ONCE into a shared `ManagedRuntime`; `startBunServer()` keeps the
    `app.listen`, ephemeral-key warning, outbound ARC key rotation, and the
    account-erasure sweeper.
  - `src/index.ts` stays the Bun composition entry tests import: it calls
    `buildAppDeps()` + `createApp()`, still exports `app`, and still conditionally
    listens off `NODE_ENV`.

  Redis/ioredis, observability, and the Workers `fetch` entry are untouched —
  they belong to later phases.

- f2c1351: Allow osn-api to boot in non-local environments WITHOUT Cloudflare email as an explicit opt-in.

  By default osn-api still fails closed at startup when `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` are absent in a non-local env. Setting the new non-secret boolean `OSN_EMAIL_OPTIONAL=true` now lets it boot with a no-op email transport (`makeNoopEmailLive` in `@shared/email`) that discards transactional mail and emits a loud, redacted startup warning instead of throwing. Cloudflare creds always win when present. Transport selection is centralised in `osn/api/src/lib/email-layer.ts` (shared by the Bun and Workers entries).

- 4d44795: Fix: register osn's outbound ARC public key with Pulse/Zap on the Cloudflare
  Workers path before the account-erasure deletion fan-out.

  Pulse + Zap verify osn's inbound ARC tokens against a **pre-registered** public
  key (kid → registered key; no JWKS-by-kid pull). The Bun server registers that
  key at boot via `startOutboundKeyRotation` (`local.ts`), but the workerd
  `scheduled` handler — which runs the deletion fan-out and mints `account:erase`
  ARC tokens — never did. The first `/internal/account-deleted` POST would be
  401'd by the downstream and the GDPR Art. 17 erasure would stall (P6 finding).

  The `scheduled` handler now calls a new `registerOutboundKeysOnce` (reusing the
  existing `registerWithDownstream` logic) **before** the fan-out sweeps,
  registering once per isolate (a module latch suppresses re-POSTing on later cron
  ticks; the downstream upsert is idempotent regardless). A registration failure
  is logged via `Effect.logError` and swallowed so a transient downstream outage
  never aborts the cron — the latch only flips on full success, so the next tick
  retries. The misleading "lazily inits on first outbound use" comment in
  `src/index.ts` is corrected. No change to the Bun path.

- 8af4c92: Add a workerd-safe, logger-only observability layer to `@osn/api` so the
  eventual Cloudflare Workers entry never imports `@effect/opentelemetry/NodeSdk`
  (Node-only, won't run on workerd).

  - New `osn/api/src/observability.ts` mirrors `cire/api`'s: exports
    `osnLoggerLayer` (built via `makeLoggerLayer(loadConfig({ serviceName: "osn-api" }))`,
    importing only the effect-only `@shared/observability/config` + `/logger`
    subpaths) plus `runOsn` / `runOsnSync` helpers. It deliberately never calls
    `initObservability` / `makeTracingLayer`, which pull the Node OTel SDK. Typed
    `Layer.Layer<never>`, so it is interchangeable with the full layer in the app
    runtime / route signatures.
  - `createApp` (`app.ts`) gains an `includeObservabilityPlugin: boolean` deps
    flag. The Elysia `observabilityPlugin` calls `process.hrtime.bigint()` on the
    per-request hot path (start timestamp + duration), which is not available on
    workerd without `nodejs_compat`; the flag lets the Workers path omit it while
    keeping `healthRoutes` + the redacting logger. The Bun path passes `true` —
    no behaviour change.

- 5055e1a: Harden client-IP resolution for rate limiting (S-M34).

  `getClientIp` now accepts an optional `ClientIpOptions { trustedProxyCount?, trustCloudflare?, socketIp? }` and resolves the keying IP under an explicit trust policy that **fails closed**:

  - `trustCloudflare` → trust `cf-connecting-ip` only (never falls back to `x-forwarded-for`); missing/invalid → unresolved.
  - `trustedProxyCount > 0` → take the entry N-from-the-right of `x-forwarded-for` (spoofing-resistant); missing/short/malformed → unresolved.
  - otherwise (direct/dev) → trust the transport socket peer (`socketIp`) only; absent/invalid → unresolved.

  New exports: `UNRESOLVED_IP`, `isUnresolvedIp(ip)`, `isValidIp(value)`, and the `ClientIpOptions` type. The legacy no-options call form (`getClientIp(headers)`) is preserved and marked `@deprecated` — it keeps the old left-most-XFF / `"unknown"` behaviour so consumers can migrate incrementally; the hardened behaviour is opt-in via the options argument.

  `@osn/api` adopts the hardened path at its auth + profile rate-limit call sites: the composition root reads `TRUSTED_PROXY_COUNT` (validated integer, default 0 = direct/socket-peer mode), wires Bun's `server.requestIP` as `socketIp`, and emits a startup warning when a non-local deploy leaves it unset. Requests whose IP is unresolved are denied (429) rather than sharing a single bucket. Session-IP persistence uses the same resolved IP.

- 5055e1a: Harden shared crypto / auth-client issuer handling (W7).

  - `@shared/crypto` `verifyArcToken` gains an optional `expectedIssuer` argument
    (X1). When set, jose enforces the signed `iss`, cryptographically binding the
    token issuer to the `kid`→issuer DB mapping. The OSN ARC middleware now passes
    the peeked issuer so a token whose `iss` differs from its `kid`'s registered
    service is rejected at verification time. Pulse's in-memory ARC receiver
    passes the registered issuer too (its explicit post-verify `iss` check is kept
    as defence-in-depth). Backward compatible — omitting the argument leaves `iss`
    unenforced.
  - ARC token cache key now includes the requested `ttl` and a canonicalised
    scope (X3), so a token requested with a shorter TTL never reuses a
    longer-lived cached entry and formatting-only scope differences collapse onto
    one entry. Scope is not sorted (differing scope order stays distinct, matching
    the signed claim).
  - The ARC public-key cache TTL is now overridable via
    `ARC_PUBLIC_KEY_CACHE_TTL_SECONDS` (default 300), bounding the cross-process
    key-revocation window (X4).
  - `@shared/osn-auth-client` `extractClaims` / `osnAuth` adapters gain an optional
    `issuer` option and apply a 30s `clockTolerance` (X2). Issuer is optional and
    unset by default for rollout safety — when unset, `iss` is not enforced so
    pre-issuer-stamping access tokens still verify. An issuer mismatch is terminal
    (no JWKS refetch).
  - `@shared/redis` in-memory client `eval` now asserts it is only ever handed the
    rate-limit Lua script (X5), so a future, semantically-different script cannot
    silently inherit fixed-window rate-limit behaviour.

- Updated dependencies [5055e1a]
- Updated dependencies [dd2dad3]
- Updated dependencies [f2c1351]
- Updated dependencies [dbed689]
- Updated dependencies [5aa1594]
- Updated dependencies [aed9d98]
- Updated dependencies [130e6c5]
- Updated dependencies [5055e1a]
- Updated dependencies [5055e1a]
- Updated dependencies [d81383d]
  - @shared/redis@0.4.0
  - @shared/observability@0.11.0
  - @osn/db@0.17.0
  - @shared/email@0.2.7
  - @shared/rate-limit@0.3.0
  - @shared/db-utils@0.3.1
  - @shared/crypto@0.8.0
  - @shared/turnstile@0.2.0

## 3.6.0

### Minor Changes

- f466a65: Migrate Pulse and the OSN core DB layer onto the four-environment database story
  (local bun:sqlite / dev·staging·prod D1). D1 has no interactive transaction, so
  every `db.transaction(async tx => …)` is rewritten to the shared `commitBatch`
  helper — an atomic `db.batch([...])` on D1, sequential awaited writes on
  bun:sqlite — preserving all-or-nothing semantics on the deployed driver.

  `@pulse/api`: 5 account-erasure transactions → `commitBatch`; `createApp`
  factory (`aot: false`) + `local.ts` (Bun.serve) + Workers `index.ts` (D1) +
  `wrangler.toml` (dev/staging/production) + a Miniflare integration test.

  `@osn/api`: all 17 transactions across auth / profile / graph / organisation /
  account-erasure → `commitBatch`, preserving the S-H1/S-M2 atomicity invariants
  (UNIQUE-constraint guards for handle/email races; a count-guarded conditional
  DELETE for the last-passkey invariant). Adds a Miniflare integration test and a
  `wrangler.toml` for D1 migration tooling. NOTE: full Workers _hosting_ of
  osn-api remains gated on replacing ioredis with a Workers-compatible Redis —
  its DB layer is D1-ready but it still runs only as the Bun.serve `local` host.

  `@pulse/db` / `@osn/db`: broadened service `Db` type + `makeDbD1Live`,
  schema-reflection `./testing` export, and wrangler-based `db:migrate:*` scripts.

### Patch Changes

- Updated dependencies [f466a65]
- Updated dependencies [f466a65]
  - @shared/db-utils@0.3.0
  - @osn/db@0.16.0
  - @shared/crypto@0.7.1

## 3.5.2

### Patch Changes

- 87b2f75: Build the application layer graph once into a shared `ManagedRuntime` instead
  of re-providing `DbLive` + the observability layer inside every request's
  `Effect.runPromise`. The old per-request pattern restarted and tore down the
  whole OpenTelemetry NodeSdk (and opened a fresh SQLite connection) on each
  call; the teardown's exporter flush stalled interactive endpoints by ~3s
  locally — most visibly the debounced username-availability check
  (`GET /handle/:handle`). All nine route factories now run handlers against the
  single process-wide runtime (tests wrap their layer in a one-time runtime),
  eliminating the per-request rebuild.

  Also lightens the handle-availability check itself: it now runs a single-column
  `users.handle` existence probe instead of `findProfileByHandle`, which joined
  `accounts` to hydrate an email the check discarded.

## 3.5.1

### Patch Changes

- af2cf69: Bring cire under the OSN oxlint + oxfmt conventions cleanly — cire was the
  source of 34 of the repo's 40 oxlint warnings; it is now warning-free under
  the shared `oxlintrc.json`.

  Lint fixes (behaviour-preserving):

  - `unicorn/no-array-sort` — replaced mutating `Array#sort()` with
    non-mutating `Array#toSorted()` in test assertions across `cire/api`
    (`claim`, `rsvp`, `spreadsheet` service + route tests).
  - `unicorn/prefer-add-event-listener` — `FileReader`/`script` `on*`
    assignments converted to `addEventListener(...)` in
    `cire/organiser` `ImportPanel`, `cire/web` `PinterestBoard`, and the
    `cire/web` calendar test.
  - `unicorn/consistent-function-scoping` — hoisted scope-independent
    helpers (`pad` in `cire/web/calendar`, `tooManyRows` / `cellTooLarge`
    in `cire/api/spreadsheet`) to module scope.
  - `no-console` — annotated the `cire/api` local-dev server banner
    (`local.ts`, a Bun shim, not the deployed Worker) with the repo's
    standard `eslint-disable-next-line no-console -- …` justification.

  Tooling parity:

  - The root `fmt` / `fmt:check` scripts now include `cire` (the `lint`
    script already covered it via `.`), so CI's format check enforces cire
    too. The two cire `astro.config.mjs` files were import-sorted to match.

  Also cleared the remaining 6 repo-wide oxlint warnings so the whole tree
  is warning-free under the shared config:

  - `@pulse/api` events feed — `Array#sort()` → `Array#toSorted()`.
  - `@pulse/app` Explore — hoisted `isDark` to module scope
    (`consistent-function-scoping`) and prefixed an unused mock param.
  - `@osn/api` outbound-arc + `@shared/osn-auth-client` jwks-cache test —
    justified `no-await-in-loop` disables where the sequential `await` is
    intentional (short-circuit on a configured stack / LRU access order
    under test), plus a hoisted test url helper.

- 04e0bf2: Audit + align cross-workspace dependency ranges and adopt TypeScript 6.0.

  - Resolve declared-range drift: `solid-js` → `^1.9.13` and `vitest` → `^4.1.8`
    everywhere they were behind; `@osn/landing` switched from pinned
    `astro@6.1.10` / `@astrojs/solid-js@6.0.1` to the caret ranges (`^6.4.2` /
    `^6.0.1`) used by the cire Astro apps.
  - Bump `typescript` `^5.9.3` → `^6.0.3` across the repo. The shared tsconfig was
    already TS 6.0-clean (`strict: true`, `target` ≥ ES2015, ESNext modules, no
    removed flags), so no `ignoreDeprecations` shim was needed. Three call sites
    surfaced by the stricter compiler were fixed:
    - `@osn/social`: added the missing `src/vite-env.d.ts`
      (`/// <reference types="vite/client" />`) so side-effect CSS imports type
      again (TS2882).
    - `@pulse/api`: dropped the now-deprecated `baseUrl` from `tsconfig.json`
      (the `#db` / `#routes` `paths` are already tsconfig-relative; TS5101).
    - `@pulse/api`: annotated `createClient`'s return type as
      `Treaty.Create<App>` to satisfy the tightened declaration-portability check
      (TS2883).

- 1bb4270: Dev auth ergonomics for the multi-frontend monorepo:

  - `OSN_ORIGIN` now accepts a comma-separated list of accepted WebAuthn origins
    (parsed in `index.ts`; `AuthConfig.origin` widened to `string | string[]` and
    passed straight to `@simplewebauthn`'s `expectedOrigin`). Lets pulse (1420),
    social (1422), cire organiser (4322) and the SDK example (5173) all run passkey
    ceremonies against one OSN API. Backward compatible — a single origin still
    works.
  - Local-only OTP visibility: registration / step-up / email-change now emit a
    debug log of the OTP code, gated strictly on a local environment (`OSN_ENV`
    unset or `"local"`). Never logs in staging/production. Makes email-OTP dev
    flows testable without a real inbox (the `LogEmailLive` transport records the
    body but deliberately never logs the code).

- Updated dependencies [d04dc20]
- Updated dependencies [77f91a4]
- Updated dependencies [04e0bf2]
- Updated dependencies [940561f]
  - @shared/crypto@0.7.0
  - @shared/observability@0.10.1
  - @osn/db@0.15.1
  - @shared/email@0.2.6
  - @shared/rate-limit@0.2.2
  - @shared/redis@0.3.1

## 3.5.0

### Minor Changes

- c3cca40: Account deletion compliance (C-H2 / GDPR Art. 17).

  Two flows:

  - **Flow A — full OSN account delete.** New `DELETE /account` on osn-api with step-up gate, 7-day soft-delete grace + manual fast-track, ARC fan-out to currently-enrolled apps, hard-delete sweeper.
  - **Flow B — leave Pulse.** New `DELETE /account` on pulse-api with step-up verification round-trip to osn-api. Hosted events flip into a 14-day public cancellation window before hard-delete (audience commitment, independent of the 7-day account grace).

  Schema additions:

  - `osn/db`: `accounts.deleted_at`, `accounts.processing_restricted_at`, new `app_enrollments` (modular-platform opt-in tracking) and `deletion_jobs` (in-flight tombstones with per-bridge `*_done_at`).
  - `pulse/db`: `events.cancelled_at` / `hard_delete_at` / `cancellation_reason`, new `pulse_deletion_jobs`.

  Other surfaces:

  - New step-up token `purpose` claim (`account_delete`, `pulse_app_delete`) — confused-deputy guard for cross-service flows.
  - New osn-api internal endpoints: `/internal/step-up/verify`, `/internal/app-enrollment/{join,leave}`. ARC scopes `step-up:verify`, `app-enrollment:write`, `account:erase` added to the register-service allowlist.
  - Pulse becomes an ARC verifier (in-memory key registry + `/internal/register-service`) and an ARC issuer for the leave-app callback.
  - New observability: `osn.account.deletion.{requested,completed,duration,fanout,fanout_pending_age}`, `osn.account.app_enrollment.{joined,left}`, `pulse.account.deletion.*`, `pulse.events.host_cancelled[.hard_delete]`.
  - New `osn/client` SDK methods: `deleteAccount`, `cancelAccountDeletion`, `getAccountDeletionStatus`.

### Patch Changes

- Updated dependencies [c3cca40]
  - @osn/db@0.15.0
  - @shared/observability@0.10.0
  - @shared/crypto@0.6.12
  - @shared/email@0.2.5

## 3.4.1

### Patch Changes

- 2420fc8: Add http://localhost:4322 (@cire/organiser) to the local-dev CORS
  fallback so the organiser portal's OSN passkey sign-in works
  out-of-the-box.
- Updated dependencies [9f6874b]
  - @shared/observability@0.9.2
  - @shared/crypto@0.6.11
  - @shared/email@0.2.4

## 3.4.0

### Minor Changes

- dd742dd: Pulse first-run onboarding: six-step `/welcome` flow with themed coral illustrations (welcome rings, editorial map, interest constellation, location pin drop, notifications ember, finish date stamp). Captures interests, location/notifications permissions, and reminder opt-in. Account-keyed server-side via a new `pulse_account_onboarding` table + `pulse_profile_accounts` mapping cache + new `GET /graph/internal/profile-account` ARC endpoint on `osn/api` — preserves the multi-account privacy invariant (accountId never on the wire). Server-side first-run gate redirects new users to `/welcome` and is idempotent on the completion POST. See `wiki/systems/pulse-onboarding.md`.

## 3.3.2

### Patch Changes

- 073238d: Migrate close friends from OSN core to Pulse.

  Close friends is now a Pulse-scoped feature, not an OSN core feature. Each OSN
  app can implement its own close-friends-style list against the OSN connection
  graph; OSN core retains only `connections` and `blocks`.

  What it does in Pulse:

  - **Feed boost.** Events organised by a close friend surface higher in
    `listEvents` (stable partition: chronological order preserved within each
    bucket; not applied for anonymous viewers).
  - **Hosting affordance.** The existing RSVP avatar ring — driven by an
    attendee having marked the viewer as a close friend — is preserved end-to-end,
    now backed by the local `pulse_close_friends` table.
  - **Management UI.** New `/close-friends` page in `@pulse/app` (linked from the
    header avatar dropdown).

  Surface changes:

  - New: `pulse_close_friends` table in `@pulse/db`; Effect service + four CRUD
    routes (`GET/POST/DELETE /close-friends/...`) in `@pulse/api`; metrics
    `pulse.close_friends.{added,removed,listed,list.size,batch.size}`.
  - Removed: OSN-core `close_friends` table, services, routes (user-facing
    `/graph/close-friends/*` and internal `/graph/internal/close-friends*`),
    graph close-friend SDK methods on `@osn/client`, the close-friends tab in
    `@osn/social` ConnectionsPage, the `withGraphCloseFriendOp` metric helper,
    and the `GraphCloseFriendAction` observability attribute.
  - Connection projection now includes `id` so cross-DB references (Pulse adding
    by profile id) work without duplicating handle→id resolution.

  Pre-launch: the OSN `close_friends` table is dropped outright; seed data
  updated. No migration path or backwards-compatibility shims.

- Updated dependencies [073238d]
  - @osn/db@0.14.2
  - @shared/observability@0.9.1
  - @shared/crypto@0.6.10
  - @shared/email@0.2.3

## 3.3.1

### Patch Changes

- Updated dependencies [9de67a2]
  - @shared/observability@0.9.0
  - @shared/crypto@0.6.9
  - @shared/email@0.2.2

## 3.3.0

### Minor Changes

- ac7312b: Add cross-device login: QR-code mediated session transfer allowing authentication on a new device by scanning a QR code from an already-authenticated device.

### Patch Changes

- Updated dependencies [ac7312b]
  - @shared/observability@0.8.1
  - @shared/email@0.2.1
  - @shared/crypto@0.6.8

## 3.2.0

### Minor Changes

- d431e9d: Switch email transport from Worker-proxy to Cloudflare Email Service REST API.

  `@shared/email` `CloudflareEmailLive` now POSTs directly to `https://api.cloudflare.com/client/v4/accounts/{id}/email-service/send` with a bearer token. Removes the ARC-token-signing intermediary and the `@shared/crypto` dependency. Error reason `worker_unreachable` renamed to `api_unreachable`.

  `@osn/email-worker` is deleted — the Cloudflare Worker middleman is no longer needed since the REST API is available from any runtime, not just Workers.

  `@osn/api` replaces `OSN_EMAIL_WORKER_URL` with `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` env vars.

### Patch Changes

- Updated dependencies [d431e9d]
  - @shared/email@0.2.0

## 3.1.1

### Patch Changes

- 92e9486: Fix CORS blocking handle checks and passkey flows from Tauri apps in local dev. `OSN_CORS_ORIGIN` now falls back to the actual monorepo frontend ports (`http://localhost:1420` for `@pulse/app`, `http://localhost:1422` for `@osn/social`) instead of the WebAuthn example-app origin (`5173`). Non-local envs still require `OSN_CORS_ORIGIN` to be set explicitly.

## 3.1.0

### Minor Changes

- 31957b4: In-range minor bumps:

  - `effect` 3.19.19 → 3.21.2 (11 workspaces)
  - `elysia` 1.2.0 → 1.4.28 + `@elysiajs/eden` 1.2.0 → 1.4.9
  - `@simplewebauthn/server` 13.1.1 → 13.3.0
  - `ioredis` 5.6.0 → 5.10.1
  - `happy-dom` 20.8.4 → 20.9.0
  - `better-sqlite3` 12.5.0 → 12.9.0 (SQLite 3.51.1 → 3.53.0)
  - OpenTelemetry stable cluster 2.0.0 → 2.7.0 (`resources`, `sdk-metrics`, `sdk-trace-base`, `sdk-trace-node`) — note: `OTEL_RESOURCE_ATTRIBUTES` parsing tightened in 2.6.0 (the entire env var is dropped on any invalid entry; whitespace must be percent-encoded). Audit deployment configs.
  - `@opentelemetry/semantic-conventions` 1.34.0 → 1.40.0
  - Root tooling: `turbo` 2.9.6, `oxlint` 1.61.0, `lefthook` 2.1.6, `@changesets/cli` 2.31.0

### Patch Changes

- 31957b4: Fix oxlint warnings: hoist helpers that don't capture parent scope, replace `Array#sort()` with `Array#toSorted()` in tests, parallelise independent session evictions, route pulse-api boot error through the observability layer, and de-shadow `token` in `OrgDetailPage`.
- 31957b4: Bump `drizzle-orm` 0.45.0 → 0.45.2 (SQL injection fix in `sql.identifier()` / `sql.as()` escaping) and `astro` 6.1.5 → 6.1.9 (unsafe HTML insertion + prototype-key safeguards in error handling).
- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).
- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
  - @osn/db@0.14.1
  - @shared/crypto@0.6.7
  - @shared/observability@0.8.0
  - @shared/rate-limit@0.2.1
  - @shared/redis@0.3.0

## 3.0.0

### Major Changes

- 6387b98: Passkey-primary login (M-PK). WebAuthn (passkey or security key) is the only primary login factor. OTP and magic-link primary login, and the `enrollmentToken` JWT machinery, have been removed. Registration is WebAuthn-gated and first-credential enrollment is mandatory; `deletePasskey` refuses unconditionally if it would leave zero credentials. The "Lost your passkey?" path (recovery codes) is the single escape hatch.

  Hardenings from the security review: **S-H1** step-up gate on `/passkey/register/*` when the account already has ≥1 passkey + `security_events{passkey_register}` audit row + best-effort email notification + server-derived session token (no user-supplied body field). **S-H2** options/verifier `userVerification` alignment (`required` on both sides; rejects UP-only U2F). **S-M1** `/login/passkey/begin` returns a uniform synthetic response for unknown identifiers, closing the enumeration oracle. **S-M2** access tokens carry `aud: "osn-access"` and `verifyAccessToken` asserts it.

  **Breaking — @osn/api**

  - Removed routes: `POST /login/otp/begin`, `POST /login/otp/complete`, `POST /login/magic/begin`, `POST /login/magic/verify`.
  - Removed service methods: `beginOtp`, `completeOtpDirect`, `beginMagic`, `verifyMagicDirect`, `issueEnrollmentToken`, `verifyEnrollmentToken`.
  - `/passkey/register/{begin,complete}` now authenticates via the normal access token; enrollment tokens are gone.
  - `/passkey/register/begin` accepts an optional `step_up_token` body field or `X-Step-Up-Token` header; **required** when the account already has ≥1 passkey (S-H1).
  - `/passkey/register/complete` body no longer accepts `session_token`; the server derives it from the HttpOnly cookie (S-H1).
  - `/register/complete` response drops `enrollment_token`.
  - `/login/passkey/begin` now returns `200 { options }` in all cases (including unknown identifier) — previously 400 on unknown (S-M1).
  - Access tokens carry `aud: "osn-access"` (S-M2).
  - `AuthConfig` drops `magicLinkBaseUrl` / `magicTtl`; adds `passkeyRegisterAllowedAmr` (default `["webauthn", "otp"]`). `AuthRateLimiters` drops `otpBegin`, `otpComplete`, `magicBegin`.
  - `SecurityEventKind` union adds `"passkey_register"`.
  - `deletePasskey` refuses to drop below 1 passkey regardless of recovery-code state.
  - WebAuthn registration options use `residentKey: "preferred"` + `userVerification: "required"`; both login paths use `userVerification: "required"` to match the verifier (S-H2).

  **Breaking — @osn/client**

  - `LoginClient` now only exposes `passkeyBegin` / `passkeyComplete`. `otpBegin`, `otpComplete`, `magicBegin`, `magicVerify` removed.
  - `CompleteRegistrationResult` no longer contains `enrollmentToken`.
  - `RegistrationClient.passkeyRegisterBegin` / `passkeyRegisterComplete` take `accessToken` instead of `enrollmentToken`.
  - `RegistrationClient.passkeyRegisterBegin` additionally accepts an optional `stepUpToken` — required when adding a passkey to an account that already has one (S-H1). The bootstrap first-passkey flow from `completeRegistration` still works without it.

  **Breaking — @osn/ui**

  - `<SignIn>` now requires a `recoveryClient: RecoveryClient` prop. The component is WebAuthn-only; it renders an informational screen when WebAuthn is unsupported, and exposes a "Lost your passkey?" link into `<RecoveryLoginForm>`.
  - `<Register>` is WebAuthn-gated. No flow path exists without WebAuthn support, and the "Skip for now" button is gone.
  - `<MagicLinkHandler>` deleted.

  **@shared/observability (minor)**

  - `AuthMethod` narrowed to `"passkey" | "recovery_code" | "refresh"`.
  - `AuthRateLimitedEndpoint` dropped `otp_begin`, `otp_complete`, `magic_begin`.

  **@pulse/app / @osn/social (patch)**

  - Pass a `recoveryClient` into `<SignIn>`; `<MagicLinkHandler>` removed from the root layout.

### Patch Changes

- Updated dependencies [6387b98]
  - @shared/observability@0.7.0
  - @shared/crypto@0.6.6

## 2.1.0

### Minor Changes

- b1d5980: M-PK: passkey-primary prerequisites — passkey management surface + discoverable-credential login.

  **Features**

  - `GET /passkeys`, `PATCH /passkeys/:id`, `DELETE /passkeys/:id` (step-up gated) — list, rename, remove credentials from Settings.
  - Discoverable-credential / conditional-UI passkey login. `POST /login/passkey/begin` accepts an empty body and returns `{ options, challengeId }`; clients round-trip the challenge ID to `/login/passkey/complete`.
  - `last_used_at` tracking on every assertion + step-up ceremony (60s coalesce).
  - WebAuthn enrolment tightened to `residentKey: "required"` + `userVerification: "required"`.
  - Hard cap of 10 passkeys per account (P-I10), enforced at both `begin` and `complete`.
  - New `SecurityEventKind` `passkey_delete` — audit row + out-of-band notification, same pattern as recovery-code generate/consume.
  - Last-passkey lockout guard: `DELETE /passkeys/:id` refuses the final credential unless recovery codes exist.
  - New `@osn/client` surface `createPasskeysClient`; `@osn/ui/auth/PasskeysView` settings panel.
  - `SignIn` opportunistically invokes `navigator.credentials.get({ mediation: "conditional" })` on mount when supported.

  **Breaking**

  - Removed the legacy unverified `POST /register` HTTP endpoint — use `/register/begin` + `/register/complete`.
  - `LoginClient.passkeyComplete` now takes `{ identifier | challengeId, assertion }` instead of positional args.
  - `AuthMethod` attribute union dropped `"password"` (OSN is passwordless).

  **DB**

  - Migration `0007_passkey_management.sql` adds `label`, `last_used_at`, `aaguid`, `backup_eligible`, `backup_state`, `updated_at` columns to `passkeys` (all nullable).

  **Observability**

  - New span names `auth.passkey.{list,rename,delete}`.
  - New counter `osn.auth.passkey.operations{action, result}`.
  - New histogram `osn.auth.passkey.duration{action, result}`.
  - New counter `osn.auth.passkey.login_discoverable{result}`.
  - `SecurityInvalidationTrigger` extended with `passkey_delete`.
  - Log redaction deny-list adds `attestation`, `passkeyLabel`/`passkey_label`.

### Patch Changes

- Updated dependencies [b1d5980]
  - @osn/db@0.14.0
  - @shared/observability@0.6.1
  - @shared/crypto@0.6.5

## 2.0.0

### Major Changes

- c04163d: Remove legacy OAuth authorization-code / PKCE flow.

  The first-party `/login/*` endpoints (Session + PublicProfile returned inline)
  are now the only sign-in surface. The following are gone:

  - Server routes `GET /authorize`, `POST /token` `grant_type=authorization_code`,
    `POST /passkey/login/{begin,complete}`, `POST /otp/{begin,complete}`,
    `POST /magic/begin`, `GET /magic/verify`
  - Service methods `exchangeCode`, `issueCode`, `completePasskeyLogin`,
    `completeOtp`, `verifyMagic`, `validateRedirectUri`; `AuthConfig.allowedRedirectUris`
  - Client API `OsnAuthService.startLogin` / `handleCallback`, module `@osn/client/pkce`,
    errors `AuthorizationError`, `TokenExchangeError`, `StateMismatchError`;
    `OsnAuthConfig.clientId`
  - Solid context methods `login` / `handleCallback`
  - `<CallbackHandler />` components in `@pulse/app` and `@osn/social`
  - Helper files `osn/api/src/lib/html.ts`, `osn/api/src/lib/crypto.ts`
  - Rate-limiter slot `magicVerify` and `AuthRateLimitedEndpoint` variant `magic_verify`

  OIDC discovery now reports `grant_types_supported: ["refresh_token"]` only.
  Magic-link emails point at `/login/magic/verify` (consumed client-side by
  `MagicLinkHandler`).

### Patch Changes

- Updated dependencies [c04163d]
  - @shared/observability@0.6.0
  - @shared/crypto@0.6.4

## 1.8.0

### Minor Changes

- 811eda4: feat(auth): out-of-band security-event audit + notification for recovery-code regeneration (M-PK1b)

  - Adds a `security_events` table and inserts an audit row inside the same transaction that regenerates recovery codes. The row captures the UA label + peppered IP hash of the request that triggered it.
  - Sends a best-effort notification email ("Your OSN recovery codes were regenerated") on success. Email failure is logged and reported via metrics but never rolls back the primary action — the audit row is the signal.
  - Exposes `GET /account/security-events` and `POST /account/security-events/:id/ack` (Bearer-authenticated, rate-limited). The list surface only returns unacknowledged rows; ack is idempotent and scoped to the owning account.
  - Adds a `SecurityEventsBanner` component (`@osn/ui/auth`) plus `createSecurityEventsClient` (`@osn/client`) so the Settings surface can render "was this you?" prompts that keep rendering until dismissed — regardless of whether the confirmation email was delivered.
  - New OTel counters + histogram on `osn.auth.security_event.*` (recorded, notified, acknowledged, notify.duration), all with bounded string-literal attributes.
  - Redaction deny-list now covers `securityEventId` / `security_event_id`.

  Unblocks the Phase 5 passkey-primary migration: a stolen access token + inbox hijack can no longer silently burn the account's recovery codes.

### Patch Changes

- Updated dependencies [811eda4]
  - @osn/db@0.13.0
  - @shared/observability@0.5.2
  - @shared/crypto@0.6.3

## 1.7.1

### Patch Changes

- 58e3e12: Cluster-safe rotated-session store for C2 reuse detection (S-H1 session / P-W1 session). Extracted `RotatedSessionStore` interface with in-memory + Redis-backed impls in `osn/api/src/lib/rotated-session-store.ts`, wired from `osn/api/src/index.ts`. Shipping with `{action, result, backend}`-dimensioned counter + duration histogram (`osn.auth.session.rotated_store.*`) and `RotatedStoreAction`/`RotatedStoreResult`/`RotatedStoreBackend` attribute unions in `@shared/observability`. Fail-open on Redis error so an outage cannot manufacture false-positive family revocations.
- Updated dependencies [58e3e12]
  - @shared/observability@0.5.1
  - @shared/crypto@0.6.2

## 1.7.0

### Minor Changes

- dc8c384: Auth phase 5a: step-up (sudo) ceremonies, session introspection/revocation, and email change.

  **New features**

  - **Step-up (sudo) tokens** — short-lived (5 min) ES256 JWTs with `aud: "osn-step-up"` minted by a passkey or OTP ceremony, required by sensitive endpoints. Replay-guarded via `jti` tracking. Routes: `POST /step-up/{passkey,otp}/{begin,complete}`.
  - **Session introspection + revocation** — `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/revoke-all-other`. Each session now carries a coarse UA label (e.g. "Firefox on macOS"), an HMAC-peppered IP hash, and a `last_used_at` timestamp. Revocation handles are the first 16 hex chars of the session SHA-256.
  - **Email change** — `POST /account/email/{begin,complete}`, step-up-gated. Hard cap of 2 changes per trailing 7 days. Atomic with session invalidation so a partial failure can never leave a stale-email session alive. Audit rows persist in the new `email_changes` table.

  **Breaking changes**

  - `/recovery/generate` now requires a step-up token (`X-Step-Up-Token` header or `step_up_token` body param) with `webauthn` or `otp` amr. The old "1 per day" rate limit is replaced by a per-hour throttle; the step-up gate is the real defence.
  - `Session` no longer carries `refreshToken` — the refresh token is HttpOnly-cookie-only after C3. `AccountSession` drops `refreshToken` and adds `hasSession: boolean`. Any stored client session state will fail schema validation and be silently cleared (users will re-login).
  - `POST /logout` no longer accepts `refresh_token` in the body — cookie-only.

  **Observability**

  - New metrics: `osn.auth.step_up.{issued,verified}`, `osn.auth.session.operations`, `osn.auth.account.email_change.{attempts,duration}`.
  - New `SecurityInvalidationTrigger` enum members: `session_revoke`, `session_revoke_all`.
  - New redaction deny-list entries: `stepUpToken`, `ipHash`, `uaLabel` (both spellings).

  Migration `0005_sessions_metadata_and_email_change.sql` adds `sessions.ua_label`, `sessions.ip_hash`, `sessions.last_used_at`, and the new `email_changes` table.

### Patch Changes

- Updated dependencies [dc8c384]
  - @osn/db@0.12.0
  - @shared/observability@0.5.0
  - @shared/crypto@0.6.1

## 1.6.0

### Minor Changes

- 9459f5e: feat(auth): recovery codes (Copenhagen Book M2) + short-lived access tokens

  **Recovery codes (M2)**

  - 10 × 64-bit single-use codes per generation (`xxxx-xxxx-xxxx-xxxx`), SHA-256 hashed at rest in the new `recovery_codes` table.
  - `POST /recovery/generate` (Bearer-auth, 3/hr/IP) returns the raw codes exactly once; regenerating atomically invalidates the prior set.
  - `POST /login/recovery/complete` (5/hr/IP) consumes a code, revokes every session on the account, and establishes a fresh session + cookie.
  - `@shared/crypto` exports `generateRecoveryCodes`, `hashRecoveryCode`, `verifyRecoveryCode`.
  - `@osn/client` exposes `createRecoveryClient`; `@osn/ui` ships `RecoveryCodesView` and `RecoveryLoginForm`.
  - Observability: `osn.auth.recovery.codes_generated`, `osn.auth.recovery.code_consumed{result}`, `osn.auth.recovery.duration`; spans `auth.recovery.{generate,consume}`; redaction deny-list additions for recovery fields.

  **Short-lived access tokens**

  - Default access-token TTL cut from 3600s to 300s (breaking for third-party consumers that cached past `expires_in`).
  - New `OsnAuthService.authFetch(input, init)` (also exposed via the SolidJS `useAuth()` context) silent-refreshes on 401 via the HttpOnly session cookie and retries once; surfaces `AuthExpiredError` when refresh fails.

  **Migration**

  - New Drizzle migration `osn/db/drizzle/0004_add_recovery_codes.sql`.
  - `AuthRateLimiters` gains `recoveryGenerate` and `recoveryComplete` (Redis bundle auto-populated).

  Mitigates prior backlog items: `S-M20` (refresh tokens in localStorage — now paired with a 5-min access-token ceiling) and unblocks M-PK (passkey-primary migration).

### Patch Changes

- Updated dependencies [9459f5e]
  - @osn/db@0.11.0
  - @shared/crypto@0.6.0
  - @shared/observability@0.4.0

## 1.5.0

### Minor Changes

- 2d5cce9: HttpOnly cookie sessions (C3), Origin guard (M1), hash magic/OTP tokens (H2/H3), extract shared auth derive (S-M2)

### Patch Changes

- Updated dependencies [2d5cce9]
  - @shared/observability@0.3.3
  - @shared/crypto@0.5.3

## 1.4.0

### Minor Changes

- 2a7eb82: feat(auth): refresh token rotation (C2), session invalidation on security events (H1), profile endpoints migrated to access token auth (S-H1)

  - **C2**: Refresh token rotation on every `/token` refresh grant. New `familyId` column on `sessions` table groups all tokens in a chain. Replaying a rotated-out token revokes the entire family.
  - **H1**: `invalidateOtherAccountSessions(accountId, keepSessionHash)` revokes all sessions except the caller's on passkey registration.
  - **S-H1**: `/profiles/list`, `/profiles/switch`, `/profiles/create`, `/profiles/delete`, `/profiles/:id/default` authenticate via `Authorization: Bearer <access_token>` instead of `refresh_token` in body.
  - Observability: 4 new session metrics, 3 new spans, `familyId` added to redaction deny-list.

### Patch Changes

- Updated dependencies [2a7eb82]
  - @osn/db@0.10.0
  - @shared/observability@0.3.2
  - @shared/crypto@0.5.2

## 1.3.0

### Minor Changes

- ac6a86c: feat(auth): server-side sessions with revocation (Copenhagen Book C1)

  Replace stateless JWT refresh tokens with opaque server-side session tokens.
  Session tokens use 160-bit entropy, stored as SHA-256 hashes in the new `sessions` table.
  Sliding-window expiry, single-session and account-wide revocation, `POST /logout` endpoint.
  Removes deprecated `User`/`NewUser` type aliases and legacy client session migration.

### Patch Changes

- Updated dependencies [ac6a86c]
  - @osn/db@0.9.0
  - @shared/crypto@0.5.1

## 1.2.0

### Minor Changes

- 0edef32: Switch OSN access token signing from HS256 to ES256 and expose a JWKS endpoint.

  - `@shared/crypto`: add `thumbprintKid(publicKey)` helper (RFC 7638 SHA-256 thumbprint)
  - `@shared/observability`: add `JwksCacheResult` metric attribute type
  - `@osn/api`: replace `AuthConfig.jwtSecret` with `jwtPrivateKey`, `jwtPublicKey`, `jwtKid`, `jwtPublicKeyJwk`; add `GET /.well-known/jwks.json`; update OIDC discovery with `jwks_uri`; ephemeral key pair in local dev when env vars are unset
  - `@pulse/api`: replace symmetric JWT verification with JWKS-backed ES256 verification; add in-process JWKS key cache with 5-minute TTL and rotation-aware refresh; remove `OSN_JWT_SECRET` dependency

### Patch Changes

- Updated dependencies [0edef32]
  - @shared/crypto@0.5.0
  - @shared/observability@0.3.1

## 1.1.1

### Patch Changes

- Updated dependencies [1f14c6a]
  - @shared/crypto@0.4.1

## 1.1.0

### Minor Changes

- 177eeea: Merge `@osn/core` into `@osn/api` and move `@osn/crypto` to `@shared/crypto`.

  - `@osn/api` now owns all auth, graph, org, profile, and recommendations routes and services directly — no longer delegates to `@osn/core`
  - `@shared/crypto` is the new home for ARC token crypto (was `@osn/crypto`); available to all workspace packages
  - ARC audience claim updated from `"osn-core"` to `"osn-api"` for consistency with the merged service identity
  - `@pulse/api` updated to import from `@shared/crypto` and target `aud: "osn-api"` on outbound ARC tokens

### Patch Changes

- Updated dependencies [177eeea]
  - @shared/crypto@0.4.0

## 1.0.3

### Patch Changes

- Updated dependencies [fe55da8]
  - @osn/db@0.8.0
  - @osn/core@0.18.0

## 1.0.2

### Patch Changes

- Updated dependencies [f594a46]
  - @osn/core@0.17.2

## 1.0.1

### Patch Changes

- Updated dependencies [1d9be5a]
  - @osn/core@0.17.1

## 1.0.0

### Major Changes

- 4197434: Rename package from `@osn/app` to `@osn/api` and move directory from `osn/app/` to `osn/api/`. The server binary is now `@osn/api` — a clearer name that signals this is an API server, not a frontend app.

## 0.3.12

### Patch Changes

- e2e010e: Add `@osn/social` app — identity and social graph management UI. Add
  `recommendations` service and route to `@osn/core`. Add `graph` and
  `organisations` client modules with Solid `GraphProvider` and `OrgProvider`.
  Fix dropdown menu not opening by wrapping `DropdownMenuLabel` in
  `DropdownMenuGroup` (required by Kobalte).
- Updated dependencies [e2e010e]
  - @osn/core@0.17.0

## 0.3.11

### Patch Changes

- Updated dependencies [d691034]
  - @osn/core@0.16.4

## 0.3.10

### Patch Changes

- 09a2a60: Add four-tier environment model (local/dev/staging/production). Local env gets debug log level and OTP codes printed to terminal; all other environments default to info. Disable SO_REUSEPORT on all servers so stale processes cause EADDRINUSE errors instead of silently intercepting requests. Add email validation message to registration form. Remove Vite devtools plugin.
- Updated dependencies [09a2a60]
  - @shared/observability@0.3.0
  - @osn/core@0.16.3

## 0.3.9

### Patch Changes

- Updated dependencies [42589e2]
  - @shared/observability@0.2.10
  - @osn/core@0.16.2

## 0.3.8

### Patch Changes

- Updated dependencies [a723923]
  - @osn/core@0.16.1
  - @osn/db@0.7.2
  - @shared/observability@0.2.9

## 0.3.7

### Patch Changes

- Updated dependencies [8137051]
  - @osn/core@0.16.0
  - @shared/observability@0.2.8

## 0.3.6

### Patch Changes

- Updated dependencies [33e6513]
  - @osn/core@0.15.0
  - @shared/observability@0.2.7

## 0.3.5

### Patch Changes

- Updated dependencies [5520d90]
  - @osn/db@0.7.1
  - @osn/core@0.14.1

## 0.3.4

### Patch Changes

- Updated dependencies [f5c1780]
  - @osn/db@0.7.0
  - @osn/core@0.14.0
  - @shared/observability@0.2.6

## 0.3.3

### Patch Changes

- e2ef57b: Add organisation support with membership and role management
- Updated dependencies [e2ef57b]
  - @osn/db@0.6.0
  - @osn/core@0.13.0
  - @shared/observability@0.2.5

## 0.3.2

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).
- Updated dependencies [8732b5a]
  - @osn/core@0.12.1
  - @osn/db@0.5.3
  - @shared/observability@0.2.4
  - @shared/redis@0.2.2

## 0.3.1

### Patch Changes

- b48d68e: Add ARC token verification middleware and internal graph routes for S2S authentication on `/graph/internal/*` endpoints.
- Updated dependencies [b48d68e]
  - @osn/core@0.12.0

## 0.3.0

### Minor Changes

- 19c39ba: feat(redis): wire up Redis-backed rate limiters (Phase 3)

  - Add `createRedisAuthRateLimiters()` and `createRedisGraphRateLimiter()` factories
    in `@osn/core` that build Redis-backed rate limiters from a `RedisClient`
  - Add `createClientFromUrl()` to `@shared/redis` so consumers don't need ioredis
    as a direct dependency
  - Wire env-driven backend selection in `@osn/app`: `REDIS_URL` set → Redis with
    startup health check; unset → in-memory fallback; graceful degradation on
    connection failure
  - All 12 rate limiters (11 auth + 1 graph) now use Redis when available
  - Resolves S-M2 (rate limiter resets on restart) for production deployments

### Patch Changes

- Updated dependencies [19c39ba]
  - @osn/core@0.11.0
  - @shared/redis@0.2.1

## 0.2.4

### Patch Changes

- Updated dependencies [77ce7ad]
  - @osn/core@0.10.0

## 0.2.3

### Patch Changes

- Updated dependencies [e8b4f93]
  - @osn/core@0.9.0
  - @osn/db@0.5.2
  - @shared/observability@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [f87d7d2]
  - @osn/core@0.8.0
  - @shared/observability@0.2.2

## 0.2.1

### Patch Changes

- 1cc3aa5: Migrate dev-mode `console.log` of registration OTP, login OTP, and magic-link
  URL in `osn/core/src/services/auth.ts` to `Effect.logDebug` (S-H21). The values
  stay interpolated into the message string so the redacting logger doesn't scrub
  them — the whole point of these dev branches is to expose the code/URL to the
  developer.

  `createAuthRoutes` and `createGraphRoutes` now accept an optional third
  `loggerLayer: Layer.Layer<never>` parameter (defaulting to `Layer.empty`) which
  is provided to the per-request Effect runtime alongside `dbLayer`. Without this
  wiring `Effect.logDebug` calls inside auth services would be silently dropped
  by Effect's default `Info` minimum log level, breaking local dev UX after the
  migration. `osn/app/src/index.ts` now threads its `observabilityLayer` through
  to both route factories (S-L1). The parameter is optional and backwards
  compatible for any downstream caller.

  Trim the redaction deny-list in `@shared/observability` to only the keys that
  correspond to real object properties in the codebase today: `authorization`,
  the OAuth token fields (`accessToken`/`refreshToken`/`idToken`/`enrollmentToken`

  - snake_case), the WebAuthn `assertion` body, ARC `privateKey`, and the user
    PII fields `email` / `handle` / `displayName`. Removes ~30 speculative entries
    (Signal/E2E keys, password fields, address/SSN/etc.) that were never reached.
    `enrollmentToken` is added because it is a real bearer credential returned by
    `/register/complete` and sent back as `Authorization: Bearer <token>` for
    passkey enrollment (S-M1). Adds a documented criteria block at the top of
    `redact.ts` explaining when to add or remove keys, a lock-step assertion in
    `redact.test.ts` pinning the exact set, a positive assertion for the enrollment
    token, and a behavioural regression anchor (T-S1) that proves previously-
    scrubbed keys now pass through unchanged. Dev-log branch coverage is locked
    with three new `it.effect` tests using a `Logger.replace` capture sink (T-U1).

- Updated dependencies [1cc3aa5]
  - @osn/core@0.7.0
  - @shared/observability@0.2.1

## 0.2.0

### Minor Changes

- cab97ca: Wire `@shared/observability` into OSN Core (auth + social graph) and the
  OSN auth server (`@osn/app`).

  **`@osn/core`**:

  - New `src/metrics.ts` defines typed OSN Core counters and histograms:
    - `osn.auth.register.attempts{step,result}` + `.duration{step}`
    - `osn.auth.login.attempts{method,result}` + `.duration{method}`
    - `osn.auth.token.refresh{result}`
    - `osn.auth.handle.check{result}` (`available` / `taken` / `invalid`)
    - `osn.auth.otp.sent{purpose}` (`registration` / `login`)
    - `osn.auth.magic_link.sent{result}`
    - `osn.graph.connection.operations{action,result}`
    - `osn.graph.block.operations{action,result}`
  - Curried pipe-friendly helpers (`withAuthRegister("begin")`,
    `withAuthLogin("passkey")`, `withGraphConnectionOp("request")`, …)
    attach a span AND record the outcome in a single `.pipe()` call.
    Duration histograms use the standard latency buckets from
    `@shared/observability`.
  - `classifyError()` maps any caught Effect error into the bounded
    `Result` union so metric cardinality stays compile-time enforced.
  - Auth service: `beginRegistration`, `completeRegistration`, `checkHandle`,
    `refreshTokens`, `beginPasskeyLogin`, `completePasskeyLogin`,
    `completePasskeyLoginDirect`, `beginOtp`, `completeOtp`,
    `completeOtpDirect`, `beginMagic`, `verifyMagic`, `verifyMagicDirect`
    are now instrumented with spans + metrics. OTP-sent and magic-link-sent
    counters fire on the happy path inside the relevant flows.
  - Graph service: `sendConnectionRequest`, `acceptConnection`,
    `rejectConnection`, `removeConnection`, `blockUser`, `unblockUser` are
    instrumented with spans + typed graph counters.

  **`@osn/app`**:

  - Entry point now calls `initObservability({ serviceName: "osn-app" })`
    and wires up `observabilityPlugin` + `healthRoutes` (replacing the
    inline `/health` handler). Updated the existing test to match the new
    shared health-route shape (`{ status: "ok", service: "osn-app" }`).
  - Structured boot log via `Effect.logInfo` instead of `console.log`.

  **Under the hood**:

  - `@shared/observability/src/tracing/layer.ts` now imports `NodeSdk`
    directly from the `@effect/opentelemetry/NodeSdk` subpath (not the
    root barrel) so that vitest doesn't eagerly try to resolve the
    optional `@opentelemetry/sdk-trace-web` peer dep the barrel's
    `WebSdk.js` module pulls in.

  **Out of scope for this PR** (deliberately): migration of stray
  `console.*` calls in auth flows (tracked as S-L8), WebSocket
  instrumentation, dashboards and alerts, actual Grafana Cloud endpoint
  provisioning.

### Patch Changes

- Updated dependencies [cab97ca]
- Updated dependencies [cab97ca]
  - @osn/core@0.6.0
  - @shared/observability@0.2.0

## 0.1.7

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

- Updated dependencies [97f35e5]
- Updated dependencies [97f35e5]
  - @osn/core@0.5.0
  - @osn/db@0.5.1

## 0.1.6

### Patch Changes

- Updated dependencies [cf57969]
  - @osn/core@0.4.0

## 0.1.5

### Patch Changes

- 3a0196b: Update CLAUDE.md with complete ARC token usage guidance: when to use ARC vs. direct package import, calling/receiving service patterns with code examples, and service registration steps.
- Updated dependencies [3a0196b]
  - @osn/core@0.3.2

## 0.1.4

### Patch Changes

- Updated dependencies [45248b2]
- Updated dependencies [45248b2]
  - @osn/db@0.5.0
  - @osn/core@0.3.1

## 0.1.3

### Patch Changes

- Updated dependencies [623ad9f]
  - @osn/db@0.4.0
  - @osn/core@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [9caa8c7]
  - @osn/db@0.3.0
  - @osn/core@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [05a9022]
  - @osn/db@0.2.3
  - @osn/core@0.1.1

## 0.1.0

### Minor Changes

- 75f801b: Implement OSN Core auth system.

  - `@osn/core`: new auth implementation — passkey (WebAuthn via @simplewebauthn/server), OTP, and magic-link sign-in flows; PKCE authorization endpoint; JWT-based token issuance and refresh; OIDC discovery; Elysia route factory; sign-in HTML page with three-tab UI; 25 service tests + route integration tests
  - `@osn/osn`: new Bun/Elysia auth server entrypoint at port 4000; imports `@osn/core` routes; dev JWT secret fallback
  - `@osn/db`: schema updated with `users` and `passkeys` tables; migration generated
  - `@osn/client`: `getSession()` now checks `expiresAt` and clears expired sessions; `handleCallback` exposed from `AuthProvider` context
  - `@osn/pulse`: `CallbackHandler` handles OAuth redirect on page load; fix events resource to load without waiting for auth; fix location autocomplete re-triggering search after selection
  - `@osn/api`: HTTP-level route tests for category filter and invalid startTime/endTime

### Patch Changes

- Updated dependencies [75f801b]
  - @osn/core@0.1.0
  - @osn/db@0.2.2
