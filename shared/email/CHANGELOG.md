# @shared/email

## 0.8.1

### Patch Changes

- Updated dependencies [f756993]
  - @shared/observability@0.18.0

## 0.8.0

### Minor Changes

- 46023fa: Gate passkey deletion and email change on credential provenance, not on wall clock alone

  A passkey registered a minute ago under an emailed code minted a step-up token indistinguishable from one the user had held for a year, so the narrow allow-lists on `passkey_delete` and `email_change` constrained only the direct path. Registering a credential and asserting it reached both gates in two hops.

  `passkeys.provenance_amr` now records the effective strength of the ceremony chain behind each credential, inherited so the pivot cannot be laundered by another hop, and `accounts.last_recovered_at` opens a 72-hour window after any recovery. A credential that predates the recovery acts immediately; one the recovery produced waits. Adds `POST /recovery/disown`, the single-use "this wasn't me" lever carried by the recovery notice, which revokes the credentials that recovery enrolled, every session on the account, and the window itself.

  The disown route answers the same `202` on every branch a caller without the token can reach, and a `500` on one they cannot: a database failure after the token has matched. That branch is the difference between the lever having fired and not, so it is reported rather than hidden, and the token is put back for a second attempt. A token reaches only the recovery it was minted for — a later recovery keeps its own credentials and its own window.

### Patch Changes

- Updated dependencies [46023fa]
  - @shared/observability@0.17.0

## 0.7.0

### Minor Changes

- 5e47301: Email and TOTP account recovery routes

  The three public endpoints that let a locked-out user back in, each ending in the
  restricted recovery session the audience work built:
  `POST /login/recovery/email/{begin,complete}` and
  `POST /login/recovery/totp/complete`. Neither factor is a login factor and
  neither mints an ordinary session — both produce an `osn-recovery` token that
  can enrol a passkey and nothing else, and enrolling one is what lifts the
  restriction.

  `begin` takes an **email address, not a handle**. `/login/passkey/begin` accepts
  a handle because it sends nothing; this endpoint puts mail in somebody's inbox,
  and a handle is public, so accepting one would turn a public identifier into a
  way to mail a stranger. The check is syntactic and never touches the database,
  so refusing a handle discloses nothing.

  **A uniform 202 is not enough, because the send is the oracle.** Every existing
  OTP send awaits the provider, and a Resend round trip is hundreds of
  milliseconds against a sub-millisecond database probe — so response latency
  separates a resolving identifier from a non-resolving one however identical the
  body is. The send is dispatched detached with a timeout, and the non-resolving
  branch makes the same number of store round trips, so both return at probe cost.
  A test parks the transport on a gate, asserts the response returns anyway, then
  releases it and asserts the mail actually went — the second half is what stops a
  fibre that never runs from passing like one that works.

  **And closing that at `begin` alone would only move it to `complete`.** `begin`
  answers 202 either way but parks a code only for an address that resolves, so
  the attack is two calls: `begin` for a candidate address, then `complete` with a
  wrong code, timed. Every store here is an HTTP hop to Upstash in each tier but
  `local`, so a branch that makes two hops answers measurably sooner than one that
  makes four. All three routes therefore pin a fixed count on every branch —
  `begin` two, `/login/recovery/email/complete` four, and
  `/login/recovery/totp/complete` whatever `checkTotpCode` costs — padded to the
  costliest real branch rather than the cheapest, since padding down is the same
  oracle upside down. The TOTP route matters most: it takes an email address as
  readily as a handle, so a cheap non-resolving branch there lets a stranger ask
  whether an address has an OSN account at all. Its padding lives beside
  `checkTotpCode` as `burnTotpCheckCost`, so a round trip added to one is added
  where the other will be read. The padding is reads even where it stands in for a
  write — what a caller can time is the number of hops, and a probe write would
  leave a counter key behind per request. Wall-clock assertions would be flaky and
  would pin nothing against an in-memory store, so the guard counts calls: the
  stores are wrapped and every branch is asserted to make the same number.

  **The recipient is the victim**, so the flood control is per resolved account (3
  per 24 h) as well as per IP: the address is the account holder's own, a rotating
  fleet already defeats per-IP keys at this issuer, and an endpoint that trains a
  user to expect unsolicited recovery mail is doing a phisher's groundwork. The
  cap is keyed on the resolved `accountId` and never on the submitted identifier,
  or it would double as an existence oracle, and a capped call returns without
  parking a code — replacing the code the user is holding would be a denial of
  service dressed as flood control.

  Completion matches `consumeRecoveryCode` rather than inventing a second, quieter
  ceremony: every session on the account is revoked and an `account_recovered`
  audit row is written in the same batch, before the new session exists, and a
  `recovery-used` notice is detached afterwards.

  Two things beyond the issue, both found by attacking the plan before writing it:

  - **The TOTP lockout counter is now scoped by ceremony.** `checkTotpCode` is
    shared with `POST /step-up/totp/complete`, which is authenticated; the new
    recovery route is not, and it accepts a public handle. On a shared counter,
    five requests from anyone who knew a handle would have locked that account's
    step-up for fifteen minutes — taking `passkey_register`, `recovery_generate`,
    `totp_enroll`, `totp_disable`, `account_delete` and `account_export` with it
    for any user whose only non-passkey factor is TOTP — repeatedly and
    indefinitely. `checkTotpCode` now takes a required `scope` and keys the two
    surfaces apart; the lockout metric gains a bounded `scope` attribute so a
    dashboard can tell which surface is under attack.
  - **A failed `complete` with no pending code does not move the lockout
    counter.** It is not a guess against anything, and counting it would hand
    anyone who knows the identifier a lever to lock the owner out of their own
    recovery without ever trying a digit.

  `AuthMethod` gains `email_recovery` and `totp_recovery`. That union is pinned by
  a test whose whole purpose is to stop OTP primary login creeping back, so the
  pin now carries the argument rather than just the members: what separates these
  from the factor `[[passkey-primary]]` removed is not the name but the audience —
  a restricted session refused by all seven verifiers, accepted by one resolver,
  and dead in fifteen minutes.

### Patch Changes

- Updated dependencies [5e47301]
  - @shared/observability@0.16.0

## 0.6.0

### Minor Changes

- d287d72: TOTP enrolment, verification and disable on osn-api

  An account can now enrol an authenticator app, use it to satisfy a step-up
  ceremony, and remove it. TOTP is a step-up factor only — it is not a login
  factor, and passkeys remain the sole primary one.

  The shared secret is the one credential in the schema that cannot be hashed,
  because RFC 6238 verification needs the raw HMAC key back. It is AES-256-GCM
  encrypted under a new `OSN_TOTP_ENCRYPTION_KEY` Worker secret, with the account
  id as additional authenticated data. **osn-api refuses to boot in a deployed
  tier without that secret**, so it has to be provisioned before this ships;
  local dev generates an ephemeral key, exactly as the JWT signing pair does.
  That key **cannot be rotated**: rows carry a `key_version` and the service holds
  exactly one key, so installing a new one makes every enrolled credential
  unverifiable. The column is there so adding rotation later needs no migration.

  `verifyTotpCode` in `@shared/crypto/totp` now returns the step it matched
  (`{ step } | null`) rather than a boolean. RFC 6238 §5.2 single use is not
  enforceable without it, and the alternative — refusing every code for the rest
  of the drift window after a success — would fail a legitimate second ceremony
  ninety seconds later. Breaking, and free: nothing outside its own test consumed
  it.

  Also: a `totp` AMR value, `totp_enroll` and `totp_disable` step-up purposes,
  `totp_enrolled` / `totp_disabled` security events and notification emails, five
  new rate-limiter slots, a `TotpClient` in `@osn/client`, and a `totp` section in
  the DSAR export.

  `passkeyDeleteAllowedAmr` stays WebAuthn-only and the email-change gate keeps an
  allow-list of its own, so neither admits a `totp` AMR **directly**. Neither is a
  boundary against a TOTP seed, and neither was one before this branch: any factor
  those gates' sibling `passkeyRegisterAllowedAmr` admits can register a passkey
  and assert it, arriving with the `webauthn` AMR both lists accept. Closing that
  needs credential provenance and is tracked separately.

### Patch Changes

- Updated dependencies [d287d72]
  - @shared/observability@0.15.0

## 0.5.3

### Patch Changes

- b2b6b70: Clean up the `house/no-tracker-ref-in-comment` mechanical majority (xchromo/osn#924).

  Every finding-tag, phase-code, and narrative-phrase reference flagged by the rule in a short comment block is now gone from these packages: a bare parenthetical tag deleted, a leading label stripped and the remainder capitalized into its own sentence, or a "used to be" narration rewritten forward to state the current, still-true fact. No behavior changes anywhere — every edit is comment text.

  A handful of leftover `osn-tracker#N` citations that predated both this batch and the separate tracker-number-refs cleanup (xchromo/osn#930) are also gone from `@osn/api` and `@pulse/api`, using the same treatment established there.

- Updated dependencies [b2b6b70]
  - @shared/observability@0.14.3

## 0.5.2

### Patch Changes

- Updated dependencies [b78deb7]
  - @shared/observability@0.14.2

## 0.5.1

### Patch Changes

- Updated dependencies [6474854]
  - @shared/observability@0.14.1

## 0.5.0

### Minor Changes

- d3af349: Move every Effect dependency to 4.0.0-rc.112 and convert the service keys.

  `effect`, `@effect/vitest` and `@effect/opentelemetry` are pinned to one exact
  version, because v4 releases the ecosystem under a single version number and is
  still pre-GA — a caret range would let an install move the target mid-migration.
  `@effect/platform` is dropped: v4 merged it into core, and nothing here imported
  it.

  `Context.Tag` no longer exists. Class declarations become
  `Context.Service<Self, Shape>()(id)` — note the argument order flips — and the
  `Context.Tag<any, A>` parameter types in `@shared/db-utils` become
  `Context.Key<any, A>`. Every service identifier string is unchanged, since those
  are the runtime lookup keys. Call sites are untouched: a v4 service key still
  extends `Effect`, so `yield* Db` works as before.

  This is the first phase of the Effect v4 migration and does not stand alone —
  the tree does not type-check until the `Schema` work lands.

### Patch Changes

- d3af349: Apply the Effect v4 combinator renames and the Cause/Runtime rework.

  Renames resolved from upstream's generated reference: `catchAllDefect` →
  `catchDefect`, `catchAllCause` → `catchCause`, `catchAll` → `catch`, `either` →
  `result`, `forkDaemon` → `forkDetach`, `zipRight` → `andThen`, `dieMessage` →
  `die(new Error(…))`, `Layer.scoped` → `Layer.effect`, `Cause.failureOption` →
  `Cause.findErrorOption`. The `Either` module became `Result`, whose variants are
  tagged `Success`/`Failure` and carry `success`/`failure` rather than
  `right`/`left`.

  `Runtime.isFiberFailure` and `FiberFailureCauseId` are gone: v4's runner rejects
  with `Cause.squash(cause)`, which is the typed failure itself, so the two
  osn-api error-shaping helpers no longer unwrap anything. That changes one thing
  on a security path — `Cause.squash` surfaces a _defect_ where v3's
  `Cause.failureOption` returned `None` — and both helpers now document it.

  Adds a test asserting the Redis layer's finalizer runs on scope close. The
  `Layer.scoped` → `Layer.effect` rewrite would have leaked connections silently
  if the scope had been dropped: it type-checks either way, and nothing covered it.

  Second phase of the Effect v4 migration; the tree does not type-check until the
  `Schema` work lands.

- d3af349: Rebuild the logger for Effect v4, and fix a secret leak in annotation redaction.

  `redact()` matches the deny-list against an object's **keys**, and the v3 logger
  mapped over each annotation **value** — so it only ever saw a bare scalar with no
  key attached and passed it through. `Effect.annotateLogs({ accessToken })`
  reached the sink in clear, along with every other deny-listed key, on every tier.
  The record is now passed whole.

  v4 moved annotations off the logger's `Options` and onto the fiber, so redaction
  moves to the output side, wrapping `Logger.formatStructured`. `Logger.layer`
  replaces the whole active set, so `Logger.tracerLogger` is listed explicitly —
  omitting it drops log-to-span correlation silently. `LogLevel` is now string
  literals (`"Warn"`, not v3's `"Warning"`), and the minimum level is a
  `References.MinimumLogLevel` service rather than `Logger.minimumLogLevel`.

  Adds `PrettyLoggerLive` for the dev-server entrypoints, replacing v3's
  `Logger.pretty`. It exists as one export rather than eleven inline
  `Logger.layer([…])` arrays so `tracerLogger` has a single place to be got right.

  Local output loses ANSI colour for an indented structured rendering:
  `consolePretty` is opaque, so there is no seam to redact through it, and one
  redaction point covering every tier is the better trade.

  **The JSON severity field is now `level`, not `logLevel`.** Grafana queries,
  panels and alerts filtering on the old name match nothing and must be updated in
  Grafana Cloud by hand.

- Updated dependencies [d3af349]
- Updated dependencies [d3af349]
- Updated dependencies [d3af349]
- Updated dependencies [d3af349]
- Updated dependencies [d3af349]
  - @shared/observability@0.14.0

## 0.4.12

### Patch Changes

- Updated dependencies [8fca0c0]
  - @shared/observability@0.13.8

## 0.4.11

### Patch Changes

- 00ed19f: Take the latest in-range release of 28 dependencies, raising each declared floor to what the lockfile already resolves to. Runtime: effect 3.22.1, elysia 1.4.30, @effect/platform 0.97.1, solid-js 1.9.15, @solidjs/router 0.16.3, @solidjs/start 2.0.4, @kobalte/core 0.13.13, motion 12.43.0, astro 7.2.9, @astrojs/solid-js 7.0.2, @astrojs/cloudflare 14.2.5, @simplewebauthn/server 13.3.3, @upstash/redis 1.38.3, @growthbook/growthbook 1.7.0, cropperjs 2.2.0. Tooling and types: vite 8.2.2, vitest 4.1.11 (with @vitest/browser, @vitest/browser-playwright and @vitest/coverage-istanbul), wrangler 4.127.1, miniflare 4.20260730.0, happy-dom 20.12.0, turbo 2.10.12, lefthook 2.1.12, portless 0.15.6, @types/leaflet 1.9.22, @types/three 0.185.4.

  No source change. Every gate passes unchanged, including the Miniflare D1 tier and the real-Chromium browser tier.

  Two consequences of the wrangler bump that the version list does not show, recorded here so they are accepted rather than discovered. Wrangler 4.127.1 nests `miniflare@5.20260828.0-alpha` — an alpha build of the local Workers runtime — under both itself and `@cloudflare/vite-plugin`, so `wrangler dev` and the vite plugin now run on a prerelease. The top-level `miniflare` stays stable at 4.20260730.0, so the `test:d1` tier is untouched. The three-day `minimumReleaseAge` soak still applies to the alpha and `minimumReleaseAgeExcludes` is empty, so nothing here skips the gate. Separately, raising `vite` to 8.2.2 raises what vite requires: it now asks for `postcss ^8.5.26` and `picomatch ^4.0.5`, both above the floors the root overrides pin. Those floors are corrected in a later PR in this stack rather than here, because they need a lockfile refresh.

- Updated dependencies [00ed19f]
  - @shared/observability@0.13.7

## 0.4.10

### Patch Changes

- Updated dependencies [965c2ee]
  - @shared/observability@0.13.6

## 0.4.9

### Patch Changes

- Updated dependencies [60e9c51]
  - @shared/observability@0.13.5

## 0.4.8

### Patch Changes

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

- Updated dependencies [d4553ed]
- Updated dependencies [c87ea88]
- Updated dependencies [9f1b272]
- Updated dependencies [1ddf9bb]
  - @shared/observability@0.13.4

## 0.4.7

### Patch Changes

- Updated dependencies [d50c68e]
  - @shared/observability@0.13.3

## 0.4.6

### Patch Changes

- Updated dependencies [2e8e8ba]
  - @shared/observability@0.13.2

## 0.4.5

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
  - @shared/observability@0.13.1

## 0.4.4

### Patch Changes

- Updated dependencies [0953024]
  - @shared/observability@0.13.0

## 0.4.3

### Patch Changes

- Updated dependencies [307a2c1]
  - @shared/observability@0.12.3

## 0.4.2

### Patch Changes

- Updated dependencies [f57a201]
  - @shared/observability@0.12.2

## 0.4.1

### Patch Changes

- Updated dependencies [f951187]
  - @shared/observability@0.12.1

## 0.4.0

### Minor Changes

- 945702c: Add enquiry transactional templates (enquiry-new, enquiry-reply, enquiry-quote) for cire Vendors S4 enquiries.

## 0.3.4

### Patch Changes

- 6a38d0f: Add `org:read` to the register-service permitted-scopes allowlist in `@osn/api` so downstream services (cire-api) can resolve OSN org membership over ARC for the Vendors feature. Add the `vendor-claim-invite` transactional email template to `@shared/email` (fail-soft: sent on claim-token minting; missing `RESEND_API_KEY` degrades to a logged no-op).

## 0.3.3

### Patch Changes

- Updated dependencies [6b14961]
  - @shared/observability@0.12.0

## 0.3.2

### Patch Changes

- Updated dependencies [630e98f]
  - @shared/observability@0.11.2

## 0.3.1

### Patch Changes

- Updated dependencies [5d6a97c]
  - @shared/observability@0.11.1

## 0.3.0

### Minor Changes

- 0880d75: Add Resend as osn-api's preferred transactional-email transport.

  `@shared/email` gains `ResendEmailLive` (`makeResendEmailLive`) — POSTs to Resend's HTTP API (`https://api.resend.com/emails`, bearer-authed), works on workerd with no paid Workers plan. It reuses the exact template/render path of `CloudflareEmailLive` and matches its instrumented-fetch, span, metric, and non-2xx → tagged-failure semantics (429 → `rate_limited`, other non-2xx → `dispatch_failed`, fetch reject → `api_unreachable`). The `RESEND_API_KEY` is placed only in the `Authorization` header — never in a URL, span/metric attribute, log, or `EmailError.cause`.

  `osn/api`'s `selectEmailLayer` now prefers Resend: precedence is **Resend → Cloudflare (legacy fallback) → local Log → `OSN_EMAIL_OPTIONAL` Noop → throw**. `RESEND_API_KEY` is added to the Worker `Env` type. Key-optional / non-breaking: with no key, behaviour is exactly as before. With Resend configured, `OSN_EMAIL_OPTIONAL` is no longer needed (a future Resend outage then fails closed like any normal misconfig).

## 0.2.7

### Patch Changes

- f2c1351: Allow osn-api to boot in non-local environments WITHOUT Cloudflare email as an explicit opt-in.

  By default osn-api still fails closed at startup when `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` are absent in a non-local env. Setting the new non-secret boolean `OSN_EMAIL_OPTIONAL=true` now lets it boot with a no-op email transport (`makeNoopEmailLive` in `@shared/email`) that discards transactional mail and emits a loud, redacted startup warning instead of throwing. Cloudflare creds always win when present. Transport selection is centralised in `osn/api/src/lib/email-layer.ts` (shared by the Bun and Workers entries).

- Updated dependencies [5055e1a]
- Updated dependencies [130e6c5]
  - @shared/observability@0.11.0

## 0.2.6

### Patch Changes

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

- Updated dependencies [d04dc20]
- Updated dependencies [04e0bf2]
  - @shared/observability@0.10.1

## 0.2.5

### Patch Changes

- Updated dependencies [c3cca40]
  - @shared/observability@0.10.0

## 0.2.4

### Patch Changes

- Updated dependencies [9f6874b]
  - @shared/observability@0.9.2

## 0.2.3

### Patch Changes

- Updated dependencies [073238d]
  - @shared/observability@0.9.1

## 0.2.2

### Patch Changes

- Updated dependencies [9de67a2]
  - @shared/observability@0.9.0

## 0.2.1

### Patch Changes

- ac7312b: Add cross-device login: QR-code mediated session transfer allowing authentication on a new device by scanning a QR code from an already-authenticated device.
- Updated dependencies [ac7312b]
  - @shared/observability@0.8.1

## 0.2.0

### Minor Changes

- d431e9d: Switch email transport from Worker-proxy to Cloudflare Email Service REST API.

  `@shared/email` `CloudflareEmailLive` now POSTs directly to `https://api.cloudflare.com/client/v4/accounts/{id}/email-service/send` with a bearer token. Removes the ARC-token-signing intermediary and the `@shared/crypto` dependency. Error reason `worker_unreachable` renamed to `api_unreachable`.

  `@osn/email-worker` is deleted — the Cloudflare Worker middleman is no longer needed since the REST API is available from any runtime, not just Workers.

  `@osn/api` replaces `OSN_EMAIL_WORKER_URL` with `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` env vars.
