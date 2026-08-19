# @shared/feature-flags

## 0.2.8

### Patch Changes

- Updated dependencies [60e9c51]
  - @shared/observability@0.13.5

## 0.2.7

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

- Updated dependencies [d4553ed]
- Updated dependencies [c87ea88]
- Updated dependencies [9f1b272]
- Updated dependencies [1ddf9bb]
  - @shared/observability@0.13.4

## 0.2.6

### Patch Changes

- Updated dependencies [d50c68e]
  - @shared/observability@0.13.3

## 0.2.5

### Patch Changes

- Updated dependencies [2e8e8ba]
  - @shared/observability@0.13.2

## 0.2.4

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

## 0.2.3

### Patch Changes

- Updated dependencies [0953024]
  - @shared/observability@0.13.0

## 0.2.2

### Patch Changes

- Updated dependencies [307a2c1]
  - @shared/observability@0.12.3

## 0.2.1

### Patch Changes

- Updated dependencies [f57a201]
  - @shared/observability@0.12.2

## 0.2.0

### Minor Changes

- 59b6e26: Add GrowthBook feature flags (key-optional, fail-safe) + wire into `@cire/api`.

  New `@shared/feature-flags` package: GrowthBook evaluation for the Workers
  backends. Flags evaluate offline at the edge (`initSync` on a pre-fetched
  payload — no Node APIs, no per-request network). The only network is a cached
  fetch of the SDK payload, and it fails safe.

  Design mirrors `@shared/turnstile`:

  - **Key-optional.** No `GROWTHBOOK_CLIENT_KEY` ⇒ every flag reads its coded
    default from the `FLAGS` registry with zero network, so this ships and deploys
    safely _before_ a GrowthBook account exists — behaviour is unchanged until the
    key is set.
  - **Fail-safe ladder.** Fresh CDN fetch → last-good cached payload → registry
    default. A flag read never throws and never blocks a request on GrowthBook.
  - **Two-layer cache.** Per-isolate memo + optional shared KV namespace
    (`KV_GB_PAYLOAD`); TTL 60s. KV is a pure optimisation — absent ⇒ per-isolate
    in-memory cache.
  - **Typed registry.** `FLAGS` is the single source of truth for flag keys +
    fail-safe defaults; callers reference flags by a typed key (typo ⇒ compile
    error).

  `@cire/api`: the provider is built once per isolate from
  `GROWTHBOOK_CLIENT_KEY` / `GROWTHBOOK_API_HOST` / optional `KV_GB_PAYLOAD`, and
  injected into the route factories (and decorated onto the Elysia context as
  `flags`). `wrangler.toml` carries the `GROWTHBOOK_API_HOST` var and commented
  `GROWTHBOOK_CLIENT_KEY` + `KV_GB_PAYLOAD` setup (top-level + `env.production`).
  Inert until the client key is set — see the package README for the GrowthBook
  Cloud setup checklist.

  **First gate — OSN account linking.** `cire.account-linking` (default off) gates
  the whole guest "Link your Pulse account" surface: `GET`/`POST /api/account/link`
  answer 503 ("disabled") when the flag is off, and the guest UI (`PulseAccountLink`)
  already hides the section on a 503 probe — so linking stays hidden with no
  frontend change, independent of the ARC keys. The POST guard is defense in depth.
  Turn the flag on in the GrowthBook dashboard to reveal it. Also adds
  `createStaticFlags(overrides)` — a network-free provider for tests / forcing
  flags from code.
