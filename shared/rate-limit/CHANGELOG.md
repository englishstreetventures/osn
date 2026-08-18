# @shared/rate-limit

## 0.3.2

### Patch Changes

- d50c68e: Comments only: repoint every "tracked in wiki/TODO.md" reference at GitHub
  Issues. Findings keep their IDs and now name the private `xchromo/osn-tracker`;
  planned work points at open issues in `xchromo/osn`. No behaviour change.

## 0.3.1

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

## 0.3.0

### Minor Changes

- dbed689: Rate-limit + IP-trust hardening for osn-api behind Cloudflare.

  - **Client-IP trust (security fix):** the non-local Workers runtime now keys per-IP rate limiting on `cf-connecting-ip` exclusively (`trustCloudflare: true`), never the spoofable `x-forwarded-for`. This closes the bypass where an attacker forged XFF to rotate past the per-IP auth limits. Local Bun dev keeps socket-peer keying; `TRUSTED_PROXY_COUNT` is now ignored in deployed tiers. Unresolved IPs still deny (429), never bucket-share.
  - **Native Workers rate limiting:** the 60-second-window per-IP auth limiters move off Upstash onto the Cloudflare Workers native Rate Limiting binding (global + atomic at the edge, fail-closed). The three 1-hour-window per-IP limiters (recovery generate/complete, email-change-begin), every per-user/per-account limiter, and every stateful store stay on Upstash. `createWorkersRateLimiter` + `WorkersRateLimitBinding` are now shared from `@shared/rate-limit`.
  - **Workers observability:** `[observability]` enabled in `osn/api/wrangler.toml` (and every named env) so Workers Logs/invocations are captured in the Cloudflare dashboard.

  Per-colo trade-off accepted: native rate limiting is counted per Cloudflare location, not globally. osn-api must be redeployed for the new bindings + observability to take effect.

- 5055e1a: Harden client-IP resolution for rate limiting (S-M34).

  `getClientIp` now accepts an optional `ClientIpOptions { trustedProxyCount?, trustCloudflare?, socketIp? }` and resolves the keying IP under an explicit trust policy that **fails closed**:

  - `trustCloudflare` → trust `cf-connecting-ip` only (never falls back to `x-forwarded-for`); missing/invalid → unresolved.
  - `trustedProxyCount > 0` → take the entry N-from-the-right of `x-forwarded-for` (spoofing-resistant); missing/short/malformed → unresolved.
  - otherwise (direct/dev) → trust the transport socket peer (`socketIp`) only; absent/invalid → unresolved.

  New exports: `UNRESOLVED_IP`, `isUnresolvedIp(ip)`, `isValidIp(value)`, and the `ClientIpOptions` type. The legacy no-options call form (`getClientIp(headers)`) is preserved and marked `@deprecated` — it keeps the old left-most-XFF / `"unknown"` behaviour so consumers can migrate incrementally; the hardened behaviour is opt-in via the options argument.

  `@osn/api` adopts the hardened path at its auth + profile rate-limit call sites: the composition root reads `TRUSTED_PROXY_COUNT` (validated integer, default 0 = direct/socket-peer mode), wires Bun's `server.requestIP` as `socketIp`, and emits a startup warning when a non-local deploy leaves it unset. Requests whose IP is unresolved are denied (429) rather than sharing a single bucket. Session-IP persistence uses the same resolved IP.

## 0.2.2

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

## 0.2.1

### Patch Changes

- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).

## 0.2.0

### Minor Changes

- 1d9be5a: Extract `createRateLimiter`, `getClientIp`, and `RateLimiterBackend` into a new `@shared/rate-limit` package. `@zap/api` now imports directly from `@shared/rate-limit` and no longer depends on `@osn/core`.
