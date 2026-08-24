# @osn/ui

## 1.10.0

### Minor Changes

- 5159096: Remove the deprecated `bx()` identity function. Write `base:`-prefixed classes directly in source strings instead.

## 1.9.1

### Patch Changes

- Updated dependencies [e18a5e1]
  - @osn/client@2.13.3

## 1.9.0

### Minor Changes

- 3dfde85: Move `@osn/*` and `@pulse/web` off `solid-toast` and onto `@shared/toast`, and
  drop the dependency from the workspace.

  Call sites are unchanged — `toast.success(message)` / `toast.error(message)` —
  but each app now maps its own design tokens onto the package's `--toast-*`
  contract, so toasts are the surface of the app they appear in rather than the
  library's white pill. `@osn/ui` drops its `solid-toast` peer dependency for a
  workspace one, so consumers no longer have to supply the implementation
  themselves.

  Both apps alias the shadcn ramp (`--popover`, `--destructive`, `--border`,
  `--ring`) and add a success green and a warning amber per ramp, since neither had
  either token; every value clears 4.5:1 on its own ramp's `--popover`. Warning is a
  real amber rather than the muted ink it started as — a lab bench showed `warning`
  and `info` rendering identically, which leaned the whole distinction on the glyph
  shape alone.

  With this, `solid-toast` is gone from every `package.json` and from the lockfile.

### Patch Changes

- Updated dependencies [3ce5044]
  - @shared/toast@0.1.0

## 1.8.4

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

- 04df26e: Type the WebAuthn challenge options through the step-up chain, and close the
  anti-slop ratchet at 12 of 15 rules.

  `StepUpClient.passkeyBegin` resolved with `{ options: unknown }` and the
  `@osn/ui` ceremony props took `unknown`, so every host had to assert its way
  back to a usable type. Three `@osn/social` call sites carried a byte-identical
  `options as Parameters<typeof startAuthentication>[0]["optionsJSON"]`, and the
  `RunPasskeyCeremony` doc comment told callers to write it.

  `passkeyBegin` now returns the standard lib.dom
  `PublicKeyCredentialRequestOptionsJSON` — the same shape
  `PasskeysClient.registerBegin` already returns for the enrolment half of the
  same flow — and `RunPasskeyCeremony` / `RunPasskeyRegistration` take the
  matching request/creation types.

  One assertion per ceremony kind has to survive: `@simplewebauthn/browser`
  re-declares both dictionaries with narrower members (`userVerification` as
  `UserVerificationRequirement` rather than lib.dom's `string`, `hints` as
  `PublicKeyCredentialHint[]` rather than `string[]`), so lib.dom is not
  assignable to it. Both now live in one documented `@osn/social` adapter,
  `src/lib/webauthn.ts`, imported by the two lazy Settings chunks — so
  `@simplewebauthn/browser` still stays out of the main bundle (P-I1).

  The three remaining anti-slop rules are marked non-adopted rather than
  deferred, with measured src/test counts and a rationale each:
  `require-safety-comment-for-type-assertion` (636/2158) would mandate 636
  hand-written comments; `no-runtime-typeof` (378/137) fires on ordinary inline
  narrowing and SSR capability probes, and its `allowInTypeGuards` option spares
  only 40; `no-unknown-parameters` (149/134) fires on type-guard predicates,
  whose parameter must be `unknown` to guard anything, and exposes no options to
  say so.

- Updated dependencies [587f561]
- Updated dependencies [c87ea88]
- Updated dependencies [9f1b272]
- Updated dependencies [1ddf9bb]
- Updated dependencies [04df26e]
  - @osn/client@2.13.2

## 1.8.3

### Patch Changes

- a45c14a: Restore passkey enrollment during registration, and stop the create-account
  dialog reappearing after sign-out.

  `Register` used to adopt the new session the moment the OTP was accepted, one
  step before the passkey ceremony. Adopting publishes a signed-in user to the
  whole app, and `@osn/social` acts on that: `AuthDialogs` renders each dialog
  with `open={props.showRegister && !session()}`, so the session arriving
  unmounted the registration dialog mid-flow. The passkey step never appeared and
  accounts were created with zero WebAuthn credentials — the exact thing the
  "every account has at least one passkey" invariant exists to prevent.

  The session is now parked in a local signal and adopted only after
  `passkeyRegisterComplete` succeeds. Nothing in the flow needed a published
  session anyway: enrollment authenticates with the access token returned by
  `/register/complete`, passed explicitly. A cancelled or failed ceremony now
  leaves the user signed out on the passkey step, able to try again, rather than
  signed in to a half-made account.

  Second fix, same area: a controlled `Dialog` never fires `onOpenChange` when its
  `open` prop flips on its own, so the `!session()` guard hid the sheet without
  ever clearing the shell's `showRegister` flag. Left set, that flag re-opened the
  create-account modal the next time the session went away — sign out, and there
  it was. `AuthDialogs` now clears both flags from `Register`'s `onSuccess` and
  from an effect on any arriving session, whatever its source (this flow, another
  tab, a cookie bootstrap).

## 1.8.2

### Patch Changes

- Updated dependencies [fd4c2f1]
  - @osn/client@2.13.1

## 1.8.1

### Patch Changes

- Updated dependencies [4e0509f]
  - @osn/client@2.13.0

## 1.8.0

### Minor Changes

- 6f743e7: Add a shared `UsernameInput` component (`@osn/ui/ui/username-input`) — a text
  field with a fixed "@" ahead of the box, wired to an optional debounced
  availability `status` (`checking | available | taken | invalid | error`). This
  replaces the near-identical hand-rolled "@" + status-message block that had
  been duplicated between `Register.tsx` and `CreateProfileForm.tsx`; both now
  consume the shared component.

## 1.7.8

### Patch Changes

- Updated dependencies [25ee66c]
  - @osn/client@2.12.2

## 1.7.7

### Patch Changes

- Updated dependencies [d5443a0]
  - @osn/client@2.12.1

## 1.7.6

### Patch Changes

- Updated dependencies [73c3c89]
  - @osn/client@2.12.0

## 1.7.5

### Patch Changes

- Updated dependencies [dea594b]
  - @osn/client@2.11.1

## 1.7.4

### Patch Changes

- Updated dependencies [94ab93e]
  - @osn/client@2.11.0

## 1.7.3

### Patch Changes

- Updated dependencies [60c58c0]
  - @osn/client@2.10.0

## 1.7.2

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

- Updated dependencies [46a301d]
  - @osn/client@2.9.0

## 1.7.1

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
  - @osn/client@2.8.1

## 1.7.0

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
  - @osn/client@2.8.0

## 1.6.1

### Patch Changes

- Updated dependencies [40100ad]
  - @osn/client@2.7.0

## 1.6.0

### Minor Changes

- 0953024: Wire recovery codes into the settings UI, and fix the generate call that could never succeed.

  `generateRecoveryCodes` in `@osn/client` posted an empty body and no step-up token, so `POST /recovery/generate` answered 403 `step_up_required` every time. It now forwards the token, and `RecoveryCodesView` runs the passkey/OTP ceremony that mints it — the same `StepUpDialog` flow `PasskeysView` uses.

  Binds the generate gate to a purpose (S-M1). `POST /recovery/generate` now requires a step-up token minted with `purpose: "recovery_generate"`, so a token from another ceremony — an email change, a passkey delete — cannot be replayed against the one action that destroys an account's whole existing set. `StepUpDialog` gained a `purpose` prop and `@osn/client` forwards it through both `/complete` routes; a purposeless token is refused, with no legacy fallback.

  Adds `GET /recovery/status`, which reports how many codes an account has left and when the set was minted. It carries counts only, never a code, so it needs no step-up — gating it would be circular, since the answer is what tells a user whether starting a ceremony is worth it. The view leads with it, and says outright when an account has no codes at all.

  `RecoveryCodesView` is now mounted in Settings → Security in `@osn/social` (it previously rendered nowhere).

### Patch Changes

- Updated dependencies [0953024]
  - @osn/client@2.6.0

## 1.5.2

### Patch Changes

- f951187: Astro 7 + vite 8 migration: `astro ^6.4.6 → ^7.1.1`, `@astrojs/solid-js ^6.0.1 → ^7.0.1` (all astro sites), `@astrojs/cloudflare ^13.7.0 → ^14.1.3` (guest site). Clears the three astro XSS advisories (GHSA-4g3v-8h47-v7g6, GHSA-f48w-9m4c-m7f5, GHSA-7pw4-f3q4-r2p2). Root `vite` override raised `^7.3.5 → ^8.0.13` (astro 7 requires vite 8) with workspace devDeps restored to `^8.0.13`, and the `esbuild` override floor raised `^0.25.0 → ^0.27.0`. `compressHTML: true` pinned in all astro configs to preserve Astro 6 whitespace output.

## 1.5.1

### Patch Changes

- Updated dependencies [e01206c]
  - @osn/client@2.5.1

## 1.5.0

### Minor Changes

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
  - @osn/client@2.5.0

## 1.4.6

### Patch Changes

- Updated dependencies [f62784d]
  - @osn/client@2.4.0

## 1.4.5

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

- Updated dependencies [368e3e8]
  - @osn/client@2.3.4

## 1.4.4

### Patch Changes

- Updated dependencies [f4b9c6b]
  - @osn/client@2.3.3

## 1.4.3

### Patch Changes

- Updated dependencies [0a297de]
  - @osn/client@2.3.2

## 1.4.2

### Patch Changes

- c981dee: Fix organiser login loop: reset the Turnstile widget after every token-consuming
  auth call so a single-use token is never replayed.

  Once the production Turnstile sitekey + secret went live, `@osn/ui`'s `SignIn`
  identifier-bound passkey form gated `/login/passkey/begin` on a Turnstile token.
  Cloudflare tokens are **single-use**, and the component never retired the token
  after `/begin` redeemed it — Cloudflare only auto-refreshes on the ~300s expiry,
  not on consumption. So any retry (a cancelled WebAuthn ceremony, the wrong
  passkey, a transient network error) re-submitted the already-redeemed token, the
  server rejected it `timeout-or-duplicate` → `turnstile_failed`, and the user
  bounced back to the login screen. Loop.

  - `TurnstileWidget` now accepts an `onReady({ reset })` callback that hands the
    parent a bound `reset()` — it drops the stale token (`onToken(null)`) and asks
    Cloudflare for a fresh challenge.
  - `SignIn` and `Register` call `reset()` immediately after each begin/register
    call that redeems the token, so the next submit always carries a fresh,
    unconsumed token. Removes the stale "the widget auto-refreshes" assumption in
    `Register.resendCode` that had the same latent single-use bug.

  Regression tests: `SignIn` retries with a fresh token after a failed ceremony
  (never replays the redeemed one); `TurnstileWidget.onReady` reset drops the token
  and resets the widget instance.

## 1.4.1

### Patch Changes

- Updated dependencies [1dd9f6d]
  - @osn/client@2.3.1

## 1.4.0

### Minor Changes

- 47c83a6: `<PasskeysView>` / `<StepUpDialog>`: add a `passkeyOnly` mode and new-device help.

  - `<StepUpDialog>` gains a `passkeyOnly` prop. When set, the OTP ("email me a
    code") factor is suppressed entirely and the passkey ceremony auto-starts on
    mount, with a retry affordance on failure. This is for hosts where
    transactional email is degraded (e.g. an osn-api running with
    `OSN_EMAIL_OPTIONAL=true`) so the user is never offered a code that will never
    arrive. Every passkey-management gate accepts a passkey step-up, so the flow
    stays fully functional without email.
  - `<PasskeysView>` forwards `passkeyOnly` to its step-up dialog and now renders a
    collapsible **"Signing in somewhere new?"** help disclosure that explains the
    three real ways onto a device with no passkey yet (backed-up/synced passkey,
    password-manager cross-device QR, recovery code) — surfacing the existing
    cross-device path without building a new system.

  No server changes; the add/rename/delete passkey endpoints already accept a
  passkey step-up token.

## 1.3.0

### Minor Changes

- d81383d: Add Cloudflare Turnstile bot protection to the OSN auth surface (key-optional, fail-closed).

  New `@shared/turnstile` package exposes `createTurnstileVerifier(secret?)` — a key-optional, fail-closed siteverify helper. When the `TURNSTILE_SECRET_KEY` secret is **unset** the verifier is `null` and every gate is skipped (flows behave exactly as before — safe to merge before the widget exists). When **set**, it POSTs the token to Cloudflare's managed `siteverify` endpoint via `instrumentedFetch`, passing the caller's `cf-connecting-ip` as `remoteip`, and rejects on any missing / invalid / expired / duplicate (single-use) token or unreachable endpoint. The secret is never logged or returned to the client.

  - **`@osn/api`**: `/register/begin` and `/login/passkey/begin` are gated. The verifier is built once per isolate in `build-deps.ts` from `env.TURNSTILE_SECRET_KEY` and threaded through `createAuthRoutes`; a configured gate fails closed with `400 turnstile_failed`. New bounded metric `osn.auth.turnstile.rejected{endpoint}`.
  - **`@osn/client`**: `RegistrationClient.beginRegistration` and `LoginClient.passkeyBegin` accept an optional `turnstileToken`, sent on the begin call (omitted cleanly when absent — the no-Turnstile call shape is unchanged, and the silent conditional-UI passkey ceremony carries no token).
  - **`@osn/ui`**: new `TurnstileWidget` (Solid) renders Cloudflare's widget only when a `siteKey` prop is provided (lazy-loads `api.js`, `data-action="turnstile-spin-v1"`); `Register` + `SignIn` take an optional `turnstileSiteKey` prop and gate submit on a solved challenge. Omitted ⇒ no widget, no gate.

  The sitekey is public (embedded in client HTML at build time via `PUBLIC_TURNSTILE_SITEKEY`); the secret is a `wrangler secret` on osn-api. Both halves are optional and graceful, mirroring the maps-embed key and `OSN_EMAIL_OPTIONAL` precedents.

### Patch Changes

- Updated dependencies [d81383d]
  - @osn/client@2.3.0

## 1.2.0

### Minor Changes

- 8aeddf1: Organisers can now create a new OSN account directly from the cire login
  page, not just sign in. `SignInPanel` toggles between the `SignIn` and
  `Register` flows from `@osn/ui/auth`; a freshly-created account is signed
  in immediately and lands on the dashboard. `Register` gains an optional
  `onSuccess` callback (fired once the account exists and its first passkey
  is enrolled) so standalone login pages can own the post-signup redirect.

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

- Updated dependencies [04e0bf2]
  - @osn/client@2.2.1

## 1.1.2

### Patch Changes

- Updated dependencies [c3cca40]
  - @osn/client@2.2.0

## 1.1.1

### Patch Changes

- Updated dependencies [073238d]
  - @osn/client@2.1.1

## 1.1.0

### Minor Changes

- 1d68593: Let users add additional biometrics (passkeys) after registration. Registration already required enrolling a first passkey; Settings now exposes a Security tab with an "Add passkey" button that runs the step-up-gated WebAuthn registration ceremony, plus the existing list / rename / delete surface. `PasskeysClient` gains `registerBegin` / `registerComplete` so the Settings surface can call `/passkey/register/begin` + `/complete` directly.

### Patch Changes

- Updated dependencies [1d68593]
  - @osn/client@2.1.0

## 1.0.1

### Patch Changes

- 31957b4: Fix oxlint warnings: hoist helpers that don't capture parent scope, replace `Array#sort()` with `Array#toSorted()` in tests, parallelise independent session evictions, route pulse-api boot error through the observability layer, and de-shadow `token` in `OrgDetailPage`.
- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).
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

- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
  - @osn/client@2.0.1

## 1.0.0

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
  - @osn/client@2.0.0

## 0.11.0

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
  - @osn/client@1.1.0

## 0.10.1

### Patch Changes

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

- Updated dependencies [c04163d]
  - @osn/client@1.0.0

## 0.10.0

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
  - @osn/client@0.10.0

## 0.9.0

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
  - @osn/client@0.9.0

## 0.8.0

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
  - @osn/client@0.8.0

## 0.7.4

### Patch Changes

- Updated dependencies [2d5cce9]
  - @osn/client@0.7.0

## 0.7.3

### Patch Changes

- Updated dependencies [2a7eb82]
  - @osn/client@0.6.0

## 0.7.2

### Patch Changes

- Updated dependencies [ac6a86c]
  - @osn/client@0.5.1

## 0.7.1

### Patch Changes

- Updated dependencies [e2e010e]
  - @osn/client@0.5.0

## 0.7.0

### Minor Changes

- e2f4c25: Add DropdownMenu component to @osn/ui; redesign Pulse header with full-width layout, expanding create-event button, and avatar dropdown menu

## 0.6.0

### Minor Changes

- d691034: Add 6-digit OTP input component with visual status states and fix login endpoints to return snake_case OAuth token format.

## 0.5.2

### Patch Changes

- 09a2a60: Add four-tier environment model (local/dev/staging/production). Local env gets debug log level and OTP codes printed to terminal; all other environments default to info. Disable SO_REUSEPORT on all servers so stale processes cause EADDRINUSE errors instead of silently intercepting requests. Add email validation message to registration form. Remove Vite devtools plugin.

## 0.5.1

### Patch Changes

- aa256af: Inline base: variant prefixes for Tailwind v4 JIT compatibility; add cursor-pointer to Button; deprecate bx(). Add @source directive for UI library scanning; wrap auth forms in Dialog modals with mutual exclusion.

## 0.5.0

### Minor Changes

- 33c6ba6: Multi-account P5: Profile UI components

  Add ProfileSwitcher (popover with profile list, switch, delete, create), CreateProfileForm, and ProfileOnboarding components to @osn/ui. Integrate ProfileSwitcher into Pulse event list header and ProfileOnboarding into Pulse settings page.

## 0.4.2

### Patch Changes

- Updated dependencies [fcd8e8f]
  - @osn/client@0.4.0

## 0.4.1

### Patch Changes

- Updated dependencies [f2fbc2a]
  - @osn/client@0.3.2

## 0.4.0

### Minor Changes

- 7030545: Migrate UI components to Zaidan (shadcn-style component library for SolidJS)

  Adds Kobalte-backed headless UI primitives (Button, Input, Label, Card, Badge, Dialog, Popover, Tabs, RadioGroup, Checkbox, Textarea, Avatar) to @osn/ui as the shared design system. Replaces inline Tailwind class patterns across both @osn/ui auth components and @pulse/app with these reusable primitives.

## 0.3.1

### Patch Changes

- 5520d90: Rename all "user" data structure references to "profile" terminology — User→Profile, PublicUser→PublicProfile, LoginUser→LoginProfile, PulseUser→PulseProfile. Login wire format key renamed from `user` to `profile`. "User" now exclusively means the actual person, never a data structure.
- Updated dependencies [5520d90]
  - @osn/client@0.3.1

## 0.3.0

### Minor Changes

- f5c1780: feat: add multi-account schema foundation (accounts table, userId → profileId rename)

  Introduces the `accounts` table as the authentication principal (login entity) and renames
  `userId` to `profileId` across all packages to establish the many-profiles-per-account model.

  Key changes:

  - New `accounts` table with `id`, `email`, `maxProfiles`
  - `users` table gains `accountId` (FK → accounts) and `isDefault` fields
  - `passkeys` re-parented from users to accounts (`accountId` FK)
  - All `userId` columns/fields renamed to `profileId` across schemas, services, routes, and tests
  - Seed data expanded: 21 accounts, 23 profiles (including 3 multi-account profiles), 2 orgs
  - Registration flow creates account + first profile atomically

### Patch Changes

- Updated dependencies [f5c1780]
  - @osn/client@0.3.0

## 0.2.2

### Patch Changes

- 098fd01: Upgrade vite from v6 to v8 with devtools, bump astro to 6.1.5

## 0.2.1

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).
- Updated dependencies [8732b5a]
  - @osn/client@0.2.1

## 0.2.0

### Minor Changes

- 97f35e5: Add shared in-app sign-in and registration across the OSN stack.

  **`@osn/core`** — new first-party `/login/*` endpoints that return a
  `Session + PublicUser` directly, mirroring the existing `/register/*`
  flow with no PKCE round-trip:

  - `POST /login/passkey/{begin,complete}`
  - `POST /login/otp/{begin,complete}` (enumeration-safe: `begin` always
    returns `{ sent: true }`)
  - `POST /login/magic/{begin}` + `GET /login/magic/verify?token=…`

  Service layer refactored to extract `verifyPasskeyAssertion`,
  `verifyOtpCode`, and `consumeMagicToken` helpers so the direct-session
  variants (`completePasskeyLoginDirect`, `completeOtpDirect`,
  `verifyMagicDirect`) share verification logic with the existing
  code-issuing variants. The hosted `/authorize` HTML + PKCE path is
  unchanged and remains the third-party OAuth entry point.

  **`@osn/client`** — new `createLoginClient({ issuerUrl })` factory
  mirroring `createRegistrationClient`, with `passkeyBegin/Complete`,
  `otpBegin/Complete`, `magicBegin/Verify` methods. Throws `LoginError`
  on non-2xx. Returned sessions are already parsed via `parseTokenResponse`
  and ready to pass to `AuthProvider.adoptSession`.

  **`@osn/ui`** — new shared SolidJS components under `@osn/ui/auth`:

  - `<Register />` — migrated from `@pulse/app` with a new `client` prop
    so it's decoupled from any specific app's env config.
  - `<SignIn />` — new three-tab sign-in (passkey / OTP / magic) driving
    the new `/login/*` endpoints through an injected `LoginClient`. Auto-
    falls-back to OTP when WebAuthn is unsupported.
  - `<MagicLinkHandler />` — invisible root-level component that exchanges
    a `?token=…` query param for a session and clears the URL.

  Package now pulls in the SolidJS + Vitest + @simplewebauthn/browser
  devDeps it needs to actually host these components.

  **`@pulse/app`** — replaces the old `useAuth().login()` redirect to
  `/authorize` with an in-app `<SignIn />` modal. Imports `<Register>`,
  `<SignIn>`, and `<MagicLinkHandler>` from `@osn/ui/auth/*`; shared
  `RegistrationClient` and `LoginClient` instances live in
  `src/lib/authClients.ts` and are injected as props.

### Patch Changes

- 97f35e5: Fix Register form showing "1–30 chars…" format error when the OSN handle availability check fails for network/server reasons. The local regex check already runs before the fetch, so any thrown error from `checkHandle` is by definition not a format problem; it now surfaces as a distinct "Couldn't check availability — try again" message instead of misleadingly blaming the user's input.
- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

- Updated dependencies [97f35e5]
- Updated dependencies [97f35e5]
  - @osn/client@0.2.0
