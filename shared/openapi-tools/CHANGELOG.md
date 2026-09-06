# @shared/openapi-tools

## 0.1.2

### Patch Changes

- 00ed19f: Take the latest in-range release of 28 dependencies, raising each declared floor to what the lockfile already resolves to. Runtime: effect 3.22.1, elysia 1.4.30, @effect/platform 0.97.1, solid-js 1.9.15, @solidjs/router 0.16.3, @solidjs/start 2.0.4, @kobalte/core 0.13.13, motion 12.43.0, astro 7.2.9, @astrojs/solid-js 7.0.2, @astrojs/cloudflare 14.2.5, @simplewebauthn/server 13.3.3, @upstash/redis 1.38.3, @growthbook/growthbook 1.7.0, cropperjs 2.2.0. Tooling and types: vite 8.2.2, vitest 4.1.11 (with @vitest/browser, @vitest/browser-playwright and @vitest/coverage-istanbul), wrangler 4.127.1, miniflare 4.20260730.0, happy-dom 20.12.0, turbo 2.10.12, lefthook 2.1.12, portless 0.15.6, @types/leaflet 1.9.22, @types/three 0.185.4.

  No source change. Every gate passes unchanged, including the Miniflare D1 tier and the real-Chromium browser tier.

  Two consequences of the wrangler bump that the version list does not show, recorded here so they are accepted rather than discovered. Wrangler 4.127.1 nests `miniflare@5.20260828.0-alpha` — an alpha build of the local Workers runtime — under both itself and `@cloudflare/vite-plugin`, so `wrangler dev` and the vite plugin now run on a prerelease. The top-level `miniflare` stays stable at 4.20260730.0, so the `test:d1` tier is untouched. The three-day `minimumReleaseAge` soak still applies to the alpha and `minimumReleaseAgeExcludes` is empty, so nothing here skips the gate. Separately, raising `vite` to 8.2.2 raises what vite requires: it now asks for `postcss ^8.5.26` and `picomatch ^4.0.5`, both above the floors the root overrides pin. Those floors are corrected in a later PR in this stack rather than here, because they need a lockfile refresh.

## 0.1.1

### Patch Changes

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

## 0.1.0

### Minor Changes

- 87bd5f8: Generate an OpenAPI document for `@osn/api`, and share the post-processing with `@pulse/api`.

  `@osn/api` now mounts `@elysiajs/openapi` and gains an `openapi:generate` script that boots the real app, fetches its own `/openapi/json`, and writes `shared/openapi/osn.json` — the same pipeline Pulse already used, so the committed spec cannot drift from what the app serves. CI regenerates both documents and fails on a diff.

  The ~290 lines of document post-processing that lived in Pulse's generator script moved to a new `@shared/openapi-tools` package, now covered by tests. `shared/openapi/pulse.json` regenerates byte-identical.

  The ARC-gated internal routes (`/graph/internal/*`, `/organisations/internal/*`, `/internal/*`) are excluded from the OSN document: only other OSN services call them, and they authenticate with signed ES256 tokens rather than a user session.
