# @osn/landing

## 0.1.13

### Patch Changes

- 59ad324: Move the root `svgo` override from `^4.0.2` to `^4.1.0`, clearing
  GHSA-w27v-7q3p-w38r. `svgo` reaches these packages through Astro, which runs it
  over SVG assets at build time, so the optimiser they build with changes.

  The version-less `@cire/*` Astro packages take the same upgrade and are not
  named here, because a changeset may not mix versioned and version-less
  packages.

## 0.1.12

### Patch Changes

- b78deb7: Rewrite every private-tracker comment reference in these packages to state the durable constraint directly (xchromo/osn#924's highest-priority batch).

  A comment citing `osn-tracker#N` (or the shorter `tracker#N` spelling, also found live and now caught by `house/no-tracker-ref-in-comment` too) means nothing to a reader who cannot open the private tracker, and stops resolving once the finding closes — this repo is public, the tracker is not, so the number was a disclosure as well as a dead end. Every citation is now the fact it stood for: which D1 bind-parameter cap a query respects and why, which cookie-scoping attack a `__Host-` prefix defeats, which reflow guard a `resize-none` textarea keeps sound, why a response is never cached. One citation (`#130`) is to a finding that is still **open** — its replacement states the constraint as a live rule rather than implying a fix that hasn't happened, and links nothing.

  Nineteen of the twenty tracker issues behind these citations are closed and fixed; none of that fix history is repeated here — only the fact that survives it. No behavior changed anywhere in this changeset: every edit is comment text.

  Every rewrite was independently adversarially verified against the real diff and the current code (not the original finding's problem description) before being accepted; two of thirty-seven were caught wrong on the first pass — one a factual overstatement carried over from the finding's language rather than the code as implemented, one a bare `#N` left behind by an earlier pass — and both were corrected.

## 0.1.11

### Patch Changes

- 7212689: P-I8 (tracker #619) — split from the cire-side changeset because `@osn/landing`
  and `@pulse/landing` are versioned packages and changesets refuses to mix a
  versioned package with the unversioned `@cire/*` apps in one file.

  Both apps' `build` script now chains `scripts/guard-bundle-size.sh . static
<threshold>` (previously bare `astro build`, no guard at all), and `ci.yml`
  carries an explicit per-app step for the same reason cire/invites' own guard
  does: a Turborepo cache replay of `build` never runs the chained script. See
  `wiki/conventions/bundle-size-guards.md` for the measured baseline and
  threshold each app was set from.

## 0.1.10

### Patch Changes

- d96da64: Clear six new high advisories and refresh a lockfile that had drifted behind its own ranges.

  `fast-uri` 3.1.5 → 3.1.7. Four high advisories against 3.1.5 landed on 2026-09-02 (GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp — two SSRF, two host confusion) and the pre-push `bun audit` gate went red. Taking 3.1.6, which is what those four advisories name as fixed, would have left two more: 3.1.7 also fixes GHSA-qw65-cvwx-89v3 (authority injection via an unvalidated port in `serialize()`) and GHSA-58mr-gqgx-xq4g (host confusion via unbalanced IP-literal brackets), neither of which is in the public advisory database yet, so no audit tool reports them. Reachability is the Astro language server only — `ajv` appears once in the lockfile, under `@astrojs/check`, and no deployed Worker or shipped bundle contains it. `smol-toml` 1.6.1 → 1.8.0 is the same shape: 1.7.1 carries the fix for GHSA-7w5x-hrqm-74c2, also absent from the database.

  The rest is lockfile lag. The dependency sweep in this stack raised every declared range, but `bun.lock` stayed behind versions those ranges already admitted: `esbuild` 0.28.2, `postcss` 8.5.26, `picomatch` 4.0.7, `sharp` 0.35.4 (libvips 1.3.3), `js-yaml` 4.3.2, `ws` 8.21.3, `devalue` 5.9.2, `happy-dom` 20.12.2, `@cloudflare/workers-types` 5.20260903.1. Two are worth knowing about rather than just taking: `ws` 8.21.1 **lowers the `maxBufferedChunks` and `maxFragments` defaults** and counts empty fragments toward the limit, which is a behaviour change inside a patch and touches Zap's WebSocket surface; `picomatch` 4.0.5–4.0.7 are all matching-semantics fixes, so glob-driven config can shift.

  `astro` 7.2.9 → 7.2.10 is the one with deployed consequences. It fixes an SSR manifest placeholder not being replaced when the server build is minified, which caused a runtime `Invalid URL` crash at server boot. It is pinned to 7.2.10 rather than left to float: 7.3.0 and 7.3.1 clear the three-day soak but not the fourteen-day rule for a minor, so they wait.

  Two overrides were correcting themselves in the wrong direction and are fixed here. `undici` was pinned `^7.29.0` while `jsdom` 30 declares `undici ^8.9.0` and `unifont` 0.7.5 declares `^8.0.0` — a floor being used as a ceiling, holding both consumers a whole major below what they were written for and cutting the tree off from undici 8 security fixes. Raised to `^8.9.0` (resolves 8.10.1). Because top-level `miniflare` 4 pins undici at exactly 7.28.0 and the wrangler-nested miniflare 5 alpha pins 7.29.0, this was verified rather than assumed: type check, the full test suite, the Miniflare D1 tier, all four Worker builds, and a real `wrangler dev --local` boot of `osn-api` on workerd, which serves 200 on `/health`, `/.well-known/jwks.json` and `/` with no errors. `postcss` and `picomatch` were likewise below what `vite` 8.2.2 asks for (`^8.5.26` and `^4.0.5`), a floor gap opened by raising vite earlier in this stack.

  Also: the `protobufjs` override matched nothing in the lockfile and is removed, and `bunfig.toml`'s note on the removed `fast-uri` soak exclusion claimed the package "parses URIs on the request path via ajv", which is not true of this tree and would have mispriced exactly the decision this changeset had to make.

  One source change, in `cire/api/tests/index.test.ts`: `@cloudflare/workers-types` 5.20260903.1 makes `recordException` a required member of `Span`, so the test's `StubSpan` gains it, typed off the interface rather than restated so the next daily types release cannot drift it.

- 39ee28c: Take jsdom 30.0.1 (from 29.1.1). It is a test-only dependency — the environment the Astro landing sites' unit tests parse HTML in.

  Note what the root `undici` override does to this bump: jsdom 30 declares `undici ^8.9.0`, and the override pins `^7.29.0`, so jsdom runs against an HTTP stack one major older than the one it was written for. That is a floor being used as a ceiling, and it is tracked separately — it is not a property of jsdom 30 and is not fixed here. Reachability is test-only: no deployed Worker or shipped bundle contains undici from this path.

- effefd7: Take motion 13.1.1 (from 12.43.0). The bundled `framer-motion` alias moves to 13.1.1 with it. The four landing and invite surfaces use only `animate`, `stagger` and `inView`, none of which changed signature. Verified through the real-Chromium browser tier rather than the mocked unit tests — see the accompanying `@cire/*` changeset for why that distinction matters here.
- 00ed19f: Take the latest in-range release of 28 dependencies, raising each declared floor to what the lockfile already resolves to. Runtime: effect 3.22.1, elysia 1.4.30, @effect/platform 0.97.1, solid-js 1.9.15, @solidjs/router 0.16.3, @solidjs/start 2.0.4, @kobalte/core 0.13.13, motion 12.43.0, astro 7.2.9, @astrojs/solid-js 7.0.2, @astrojs/cloudflare 14.2.5, @simplewebauthn/server 13.3.3, @upstash/redis 1.38.3, @growthbook/growthbook 1.7.0, cropperjs 2.2.0. Tooling and types: vite 8.2.2, vitest 4.1.11 (with @vitest/browser, @vitest/browser-playwright and @vitest/coverage-istanbul), wrangler 4.127.1, miniflare 4.20260730.0, happy-dom 20.12.0, turbo 2.10.12, lefthook 2.1.12, portless 0.15.6, @types/leaflet 1.9.22, @types/three 0.185.4.

  No source change. Every gate passes unchanged, including the Miniflare D1 tier and the real-Chromium browser tier.

  Two consequences of the wrangler bump that the version list does not show, recorded here so they are accepted rather than discovered. Wrangler 4.127.1 nests `miniflare@5.20260828.0-alpha` — an alpha build of the local Workers runtime — under both itself and `@cloudflare/vite-plugin`, so `wrangler dev` and the vite plugin now run on a prerelease. The top-level `miniflare` stays stable at 4.20260730.0, so the `test:d1` tier is untouched. The three-day `minimumReleaseAge` soak still applies to the alpha and `minimumReleaseAgeExcludes` is empty, so nothing here skips the gate. Separately, raising `vite` to 8.2.2 raises what vite requires: it now asks for `postcss ^8.5.26` and `picomatch ^4.0.5`, both above the floors the root overrides pin. Those floors are corrected in a later PR in this stack rather than here, because they need a lockfile refresh.

- Updated dependencies [00ed19f]
  - @shared/legal@0.0.2

## 0.1.9

### Patch Changes

- 853367f: Pin browserslist to ^4.28.8 via a root override, clearing two high-severity advisories (GHSA-c83g-rgw3-j3cx unbounded query-cache growth, GHSA-73wf-gq98-2v4g crash and prototype write on untrusted browserslist-stats.json). Both affect <= 4.28.6, and the tree resolved 4.28.2 transitively through the @babel/core that vite-plugin-solid and @astrojs/solid-js pull in. Every package listed here sits on that chain. Build output is byte-identical.

## 0.1.8

### Patch Changes

- 981ea54: Move every remaining colocated test file into its package's `tests/` tree, the
  layout `wiki/conventions/testing-patterns.md` has documented all along.

  `osn/landing` and `pulse/landing` kept their suites beside the source in `src/`
  (and `pulse/landing` a third under `functions/`); those now mirror `src/` under
  `tests/`. The three API packages' Miniflare-backed D1 suites move from
  `src/d1-integration.test.ts` to `tests/d1/d1-integration.test.ts` — they used to
  sit outside the vitest `include` glob by accident of living in `src/`, and are
  now excluded from it explicitly by path, so `bun run test:d1` stays the only
  thing that runs them. `tsconfig.json` gains `tests/**/*` wherever the tests were
  previously type-checked only because they lived under `src/`.

  No test bodies changed; only their location and the relative paths inside them.

## 0.1.7

### Patch Changes

- 70ac0f3: Drop the unused `@testing-library/jest-dom` devDependency from every package that declared it but imports no matcher, now that `vite-plugin-solid` no longer injects its setup file. Guard the suppression markers in CI, and list the marker file under turbo's `globalDependencies` so an edit to it can no longer be served from cache.

## 0.1.6

### Patch Changes

- 7d3bdbf: Stop the draft banner from going out from under a field that is still a token.

  `LEGAL_DETAILS_PENDING` is derived from three identity fields — the entity name,
  the postal address and the contact email. Every page gated its draft banner on
  that flag alone, including the three `@cire/landing` pages that also publish the
  merchant of record, and the privacy notice that also publishes the retention
  sentence. Both of those are still `{{PLACEHOLDER}}`.

  So filling in the operator's name would have taken the banner off all three
  pages while they went on printing a live `{{MERCHANT_OF_RECORD}}` to the reader,
  highlighted in gold and no longer labelled a draft. Filling in the first field
  was enough to publish the unfilled ones. This is the failure `pendingAny` was
  written for, and nothing ever called it.

  `pendingAny` is now `draftPending`, which checks the identity half itself and
  takes the extra fields the page publishes on top:

  ```ts
  const draft = draftPending(LEGAL_ENTITY.merchantOfRecord, LEGAL_ENTITY.accountDataRetention);
  ```

  All thirteen pages pass every field they name, so no page can go un-flagged for
  a detail it has not filled in.

  Also on the app frontends: the dotted underline marking an unfilled detail read
  the page-wide flag, so it would have marked a filled entity name as pending
  while some other field was outstanding. It now checks the field it underlines.

- Updated dependencies [7d3bdbf]
  - @shared/legal@0.0.1

## 0.1.5

### Patch Changes

- fe3ee5d: Run the devloop behind portless: named HTTPS hosts instead of ports, and one stack per worktree.

  Every app's `dev` script is now `portless`, which reads that package's own `"portless"` key and runs its real command (`dev:app`) behind the proxy. `@osn/api` answers on `https://id.musubi.localhost`, `@pulse/web` on `https://pulse.localhost`, and so on — twelve port numbers nobody has to remember, and no clash when two things want 4321. The names mirror production hostnames.

  The nesting under a shared parent is load-bearing rather than cosmetic. A WebAuthn RP ID has to be the origin's host or a registrable suffix of it, so passkeys created on `@osn/social` are only verifiable by `@osn/api` if both sit under one parent: `musubi.localhost` and `id.musubi.localhost`, RP ID `musubi.localhost`. Flat names would have put every local passkey out of reach of the API that checks it.

  In a linked worktree portless prepends the branch, so `bun run dev` in two worktrees gives two complete, independent stacks. That is also why no app can be told where its siblings live from a committed `.env` — the answer differs per worktree. The new `@shared/dev-urls` package derives it instead: its `dev-env` launcher fronts each `dev:app`, reads the app's own `PORTLESS_URL`, splits off the shared worktree prefix and TLD, and rebuilds every sibling's origin from them. It exports the same env vars the deployed tiers set (`OSN_ISSUER_URL`, `OSN_RP_ID`, `OSN_ORIGIN`, `PULSE_CORS_ORIGIN`, `PUBLIC_API_URL`, …), so no app source knows portless exists.

  Two posture changes worth naming. `OSN_RP_ID` was the bare `localhost`, which every app on the machine shares; it is now `musubi.localhost`, so a local passkey is scoped to the account family — existing `localhost` passkeys will not resolve and need re-enrolling. And `DEV_LOGIN_RETURN_ORIGINS`, which the Bun devloop left unset (closed: every `return_to` a 400), now carries the same four frontend origins `wrangler.toml` already set for `wrangler dev`. The route still only mounts when `DEV_LOGIN_SECRET` is set.

  `PORTLESS=0 bun run dev` still gives the old fixed-port devloop. The ports the frontends lost from their `dev` scripts moved into their configs behind `devPort()`, which prefers the `PORT` portless assigns and falls back to the old literal, so the bypass keeps working and the four Astro apps do not all land on 4321.

## 0.1.4

### Patch Changes

- b057690: One source of truth for the operator's published identity, and the missing terms
  sections.

  Every legal page carried its own `{{LEGAL_ENTITY}}`, `{{CONTACT_EMAIL}}`,
  `{{POSTAL_ADDRESS}}`, `{{REGULATOR}}`, `{{RETENTION}}` and
  `{{MERCHANT_OF_RECORD}}` placeholder plus a hand-written "Draft — replace every
  highlighted value" banner. All of it was live in production, because filling the
  values in meant eight coordinated edits by someone holding all of them. The new
  `@shared/legal` package holds them once; the draft banner is derived from whether
  they are still placeholders, so a page cannot be left half-published and the
  banner cannot outlive the values.

  The two marketing terms pages had no governing-law clause at all, no consumer-law
  carve-out, and no changes clause. They have all three now, and their liability
  paragraph no longer reads as excluding guarantees the Australian Consumer Law does
  not allow to be excluded. Governing law is stated at country level on all four
  terms pages.

  `@pulse/landing`'s privacy notice disclosed "basic, privacy-respecting analytics"
  that the package does not run. Describing collection that does not happen is still
  a wrong notice; the line now says what the static host actually keeps.

## 0.1.3

### Patch Changes

- aaeec93: Self-host the typefaces instead of linking `fonts.googleapis.com`.

  `@osn/landing` (Inter, Space Grotesk) and `@pulse/landing` (Geist, Geist Mono,
  Instrument Serif) use Astro's font pipeline: `fontProviders.google()` downloads
  each face at build time, serves it from our own origin, emits the preload links,
  and generates the metric-matched fallback so the swap does not shift layout.
  Both drop the Google origins from `style-src` and `font-src` in
  `public/_headers`, and both gain a test asserting they stay gone.

  `@pulse/web` is SolidStart, which has no equivalent pipeline, so its faces are
  written out in `src/app.css` over `@fontsource` — latin and latin-ext only, and
  `.woff2` only. Importing fontsource's whole-family entrypoints instead would
  have put every published subset on the critical path (Geist Mono ships six) and
  let Vite base64-inline the sub-4 KB legacy `.woff` files straight into the
  stylesheet.

  This removes the last render-blocking third-party request from all three, and
  with it the transmission of every visitor's IP and user-agent to Google LLC (US)
  — which no consent gate covered, because the `<link>` sat in the server-rendered
  `<head>`.

## 0.1.2

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

## 0.1.1

### Patch Changes

- f951187: Astro 7 + vite 8 migration: `astro ^6.4.6 → ^7.1.1`, `@astrojs/solid-js ^6.0.1 → ^7.0.1` (all astro sites), `@astrojs/cloudflare ^13.7.0 → ^14.1.3` (guest site). Clears the three astro XSS advisories (GHSA-4g3v-8h47-v7g6, GHSA-f48w-9m4c-m7f5, GHSA-7pw4-f3q4-r2p2). Root `vite` override raised `^7.3.5 → ^8.0.13` (astro 7 requires vite 8) with workspace devDeps restored to `^8.0.13`, and the `esbuild` override floor raised `^0.25.0 → ^0.27.0`. `compressHTML: true` pinned in all astro configs to preserve Astro 6 whitespace output.

## 0.1.0

### Minor Changes

- 04b279e: Build out `@osn/landing` — the OSN marketing site — from a bare scaffold into a
  full static Astro + SolidJS + Tailwind v4 brochure, mirroring `@cire/landing`'s
  stack and conventions.

  Dark-grey, "your social graph, your control" identity built on a dotted /
  network motif. Signature visuals are two self-contained Solid islands: a
  `ConstellationCanvas` backdrop (an animated dot-network evoking the social
  graph, mounted behind every page) and a `ConnectionsHero` whose person-graph
  edges draw in on mount. Both honour `prefers-reduced-motion` (still field /
  instant reveal) and degrade gracefully without a canvas context.

  Sections (Promise, Features, How-it-works, Apps, Principles, FAQ, Final CTA)
  plus a `SiteFooter` and draft privacy / terms legal pages. All copy is grounded
  in real OSN features (own your graph, one identity → many profiles, apps
  opt-in/out, passkey-only login, E2E privacy, data transparency); the ecosystem
  section cross-sells Pulse, Zap and Cire. CTA targets and site metadata are
  centralised in `lib/site.ts` (`PUBLIC_APP_URL` baked at build).

  Fully static, no external images and no first-party API calls, so it ships the
  same tight CSP (`_headers`) and `data-reveal` scroll-reveal primitive as
  `@cire/landing`. Fonts: Space Grotesk + Inter. Dev/preview on port **4324**.
  See `[[wiki/apps/osn-landing]]`.

## 0.0.7

### Patch Changes

- d4c74ee: Bump `astro` `^6.4.2` → `^6.4.6` to clear the high-severity Host-header
  SSRF advisory (`GHSA-2pvr-wf23-7pc7`) in the prerendered error-page fetch,
  plus the bundled spread-prop XSS (`GHSA-jrpj-wcv7-9fh9`).

## 0.0.6

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

## 0.0.5

### Patch Changes

- 31957b4: Bump `drizzle-orm` 0.45.0 → 0.45.2 (SQL injection fix in `sql.identifier()` / `sql.as()` escaping) and `astro` 6.1.5 → 6.1.9 (unsafe HTML insertion + prototype-key safeguards in error handling).
- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).

## 0.0.4

### Patch Changes

- 098fd01: Upgrade vite from v6 to v8 with devtools, bump astro to 6.1.5

## 0.0.3

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).

## 0.0.2

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.
