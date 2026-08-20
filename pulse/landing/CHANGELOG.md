# @pulse/landing

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

- 04b279e: Add `@pulse/landing` — the Pulse events marketing site. A new static Astro +
  SolidJS + Tailwind v4 package, same stack as `@cire/landing`, with a colourful,
  energetic identity that follows the Pulse design system (`pulse/DESIGN.md`):
  Instrument Serif / Geist / Geist Mono type, the coral/ember accent family, a
  warm-light base and a vivid multi-colour category palette.

  Signature visuals are two self-contained Solid islands: a `PulseField` backdrop
  of colourful pulsing dots / radiating rings (echoing the app's pulsing-coral-dot
  mark) and a `PulseHero` with an editorial italic-accent headline and lively
  floating chips. Both honour `prefers-reduced-motion` and render statically
  without JS.

  Sections (Promise, Features, How-it-works, the colourful Categories showcase, a
  Venues lineup teaser, FAQ, Final CTA) plus `SiteFooter` and draft privacy /
  terms pages. Copy is grounded in real Pulse features (discovery by
  location/category/friends, "today near you", effortless RSVPs, calendar + iCal
  export, venue pages, event group chats, organiser tools, hidden attendance).
  CTA target + categories live in `lib/site.ts` (`PUBLIC_APP_URL` baked at build).

  Fully static, no external images / first-party API calls, so it carries the same
  tight CSP (`_headers`) and `data-reveal` scroll-reveal primitive as
  `@cire/landing`. Dev/preview on port **4325**; root script `dev:pulse-landing`.
  See `[[wiki/apps/pulse-landing]]`.
