# @osn/landing

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
