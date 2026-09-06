---
title: Cire development guide
description: Cire's own build conventions — backend patterns, the test tiers, and the commands that differ from the platform defaults
tags: [app, weddings, cire, conventions, development]
status: active
packages:
  - "@cire/invites"
  - "@cire/host"
  - "@cire/vendor"
  - "@cire/api"
  - "@cire/db"
related:
  - "[[cire]]"
  - "[[cire-auth]]"
  - "[[backend-patterns]]"
  - "[[frontend-patterns]]"
  - "[[testing-patterns]]"
  - "[[browser-tests]]"
  - "[[d1-read-replication]]"
  - "[[commands]]"
  - "[[bundle-size-guards]]"
last-reviewed: 2026-09-06
---

# Cire development guide

What is true of cire and not of the rest of the monorepo. Everything else — branch
strategy, changesets, commit signing, hooks, the issue workflow, the wiki rules —
comes from the root `CLAUDE.md` and the platform pages, which are authoritative.

> **This page is the per-product pattern.** A product with enough of its own build
> conventions to be worth writing down gets `wiki/apps/<product>-development.md`,
> and its overview page links to it. Cire is the only one so far; pulse, zap and
> social still fit inside the platform pages. Put a fact here only when it is
> genuinely cire-only — if it applies to any other Solid or Workers package, it
> belongs in [[frontend-patterns]], [[backend-patterns]] or [[testing-patterns]]
> instead, where the person who needs it will actually find it.

Start at [[cire]] for what cire *is*, and [[cire-auth]] for the two-system auth
contract every route sits behind.

## Backend — Elysia on Workers, Effect in the service layer

The platform shape is in [[backend-patterns]]. Cire's departures:

- **`createApp` uses `aot: false`.** Elysia's ahead-of-time compilation builds
  handlers with `new Function`, which Cloudflare Workers forbids. This is not a
  tuning knob — the Worker fails to boot without it.
- **POST routes pass a sentinel `parse` hook** (`{ parse: () => ({}) }`) and read
  `request.json()` by hand, so malformed JSON degrades to the schema's own 400
  rather than a framework parse error.
- **Routes live in `cire/api/src/routes/`**, one route factory per domain (claim,
  rsvp, organiser, import), composed by `createApp` in `src/app.ts`. Handlers
  delegate to `cire/api/src/services/` and hold no logic.
- **Services return `Effect.Effect<A, E>`**; route handlers unwrap with
  `runCire` / `runCireSync`, never bare `Effect.runPromise` — the wrappers install
  the redacting logger ([[cire-workerd]]).
- **Errors are tagged classes** extending `Data.TaggedError`. Nothing in the
  service layer throws.
- **D1 access is Drizzle only** — no raw SQL string construction.
- **The Drizzle handle is built over the session-routing shim**, never over
  `env.DB` directly, and each Worker invocation opens exactly one D1 session at
  the entry point — see [[d1-read-replication]].
- **Effect is backend and DB only.** Never import it in `cire/invites`,
  `cire/host` or `cire/vendor`.
- **Cloudflare bindings are typed from `wrangler types`** output
  (`worker-configuration.d.ts`); regenerate after any schema or binding change.

### Middleware

Elysia plugins in `cire/api/src/middleware/`, all scoped `derive` + `onBeforeHandle`:

| File | Gate |
|---|---|
| `auth.ts` | `sessionAuth` — the guest claim-code cookie |
| `osn-auth.ts` | `osnAuth` — organiser JWT, via the shared Elysia adapter |
| `wedding-owner.ts` | owner only — codes, settings, removing/demoting a co-host, delete |
| `wedding-editor.ts` | owner or `editor` — module writes, the RSVP-by date, adding a co-host |
| `wedding-member.ts` | any role including `viewer` — reads + invite preview |
| `rate-limit.ts`, `turnstile.ts` | abuse gates |

Pick the gate from the roles matrix in [[cire-auth]], not by guessing from the
route name. (An `ownedWedding` "single owned wedding" middleware existed before
multi-wedding; it went when organisers could own several.)

## Tests

Platform conventions are in [[testing-patterns]]; the real-Chromium tier is in
[[browser-tests]]. Cire specifics:

- Test files sit beside their source as `*.test.ts`.
- **Integration tests run against a local D1 via `wrangler dev` — do not mock the
  database.**
- **`*.browser.test.tsx` runs in real Chromium**, not jsdom, for anything needing
  computed CSS, layout, paint or stacking order, sticky behaviour, or media
  emulation. Opt-in, with its own CI step. `@cire/host` has a browser tier too
  (added 2026-08-06): its ink tokens are translucent and it ships two ramps, so
  what a token measures as authored and what it measures as painted are different
  numbers. jsdom parses no stylesheet and reports zeroed rects — a class-contract
  assertion in the fast tier and a measurement in the browser tier are
  complements, not duplicates.
- The animation and layout bug classes that make the browser tier necessary are
  written up in [[frontend-patterns]] § Rendering and animation gotchas.
- **Cire does not yet use the platform `it.effect` + `createTestLayer()` idiom.**
  Aligning it is an open issue in `xchromo/osn`.

## Commands

Run from the OSN repo root. General commands are in [[commands]]; dev servers
answer on portless hostnames rather than ports ([[devloop-urls]]).

```bash
# Dev — cire API + guest + organiser, plus @osn/api (organiser sign-in needs the issuer)
bun run dev:cire
bun run --cwd cire/invites dev       # guest site only    → https://invite.cire.localhost
bun run --cwd cire/host dev          # organiser portal   → https://host.cire.localhost
bun run --cwd cire/api dev           # API only (Bun.serve entry; wrangler via dev:wrangler)

# Test
bun run --cwd cire/api test
bun run --cwd cire/invites test:browser   # real-Chromium tier
bun run --cwd cire/host test:browser
bun run test:browser                      # every package with a browser tier (turbo)

# Database — wrangler.toml lives in cire/api
cd cire/api && bunx wrangler d1 migrations apply cire-db --local
cd cire/api && bunx wrangler d1 migrations apply cire-db
cd cire/api && bunx wrangler types
```

Local sign-in also needs an `oauth_clients` row in the local OSN D1 and
`CIRE_OIDC_CLIENT_SECRET` in `cire/api/.dev.vars`. Without them `/api/auth/oidc/*`
answers 503 and the rest of cire works as normal.

### Deploying by hand

CI does this on merge ([[production-deploy]]). By hand:

```bash
cd cire/api && bunx wrangler deploy --env production
```

**Never a bare `wrangler deploy`** — the config blocks it, deliberately.

The **guest site is a Worker, not Pages.** The adapter emits `dist/server` +
`dist/client` and a generated `dist/server/wrangler.json` extending
`cire/invites/wrangler.jsonc`; CI strips the unsupported `legacy_env` field first
(see `deploy.yml`).

```bash
bun run --cwd cire/invites build
cd cire/invites && bunx wrangler deploy --config dist/server/wrangler.json
```

## Guest-site SSR bundle size

Tracker #619 generalised this guard out of cire/invites: it is now
`scripts/guard-bundle-size.sh` (repo root, `worker` mode for this app), shared
with a `static`-mode measurement for the five non-SSR Astro apps. The
cross-app mechanism — where it runs, why it runs twice, every app's current
threshold — lives in [[bundle-size-guards]]. What stays here is what is
genuinely cire/invites-only: WHY its bundle is shaped the way it is.

In `worker` mode the script measures the gzip size of every deployable file
under `cire/invites/dist/server` (excluding the adapter's generated
`wrangler.json` and, since tracker #616's source-map follow-up, `.map` files —
`no_bundle: true` ships each chunk as its own module, so the sum of each
file's own gzip size is what actually crosses the wire). It also fails if any
`.map` file turns up under `dist/client`, which is served publicly as Static
Assets — see the source-map warning below.

`cire/invites/package.json`'s `build` script chains it on
(`… && ../../scripts/guard-bundle-size.sh .`), so it fires wherever the build
actually executes: the by-hand deploy above, and any local build. `ci.yml` and
both `deploy.yml` jobs also invoke it as their own step ([[bundle-size-guards]]
has the reason — a Turborepo cache replay of `build` never runs the chained
script). The mode and threshold are no longer arguments anywhere — every
caller looks its app up by name in `scripts/bundle-size-budgets.txt`, the one
place a re-baseline touches. See that file's own comment for the exact steps.

The headroom is deliberately smaller than the mistake the guard exists to
catch, and that is the part worth getting right. `motion` costs **21261 bytes
gzip in the minified build** — the size of its own already-minified client
vendor chunk, `dist/client/_astro/animate.*.js`, and the same figure you get by
rebuilding with `stubMotionForSsr()` removed. A threshold set to "measured plus
one motion" would put a fresh library of exactly that class *under* the line,
which is how the first version of this number went wrong: it carried 47657
bytes, motion's cost back when the build was unminified. The arithmetic is
spelled out in the comment above `threshold=` so the next reader can check it
without rebuilding.

Three tracker follow-ups (#618, #616, #617) to the original size audit
(#287) cut the bundle from 285 KB to 163 KB gzip:

- **Sessions off (#618).** Astro's session config accepts `session: false`
  (`astro/dist/core/session/config.js`), and `@astrojs/cloudflare`'s
  KV-binding auto-provisioning is gated on that same literal
  (`@astrojs/cloudflare/dist/index.js`, `if (session !== false && ...)`), so
  turning sessions off entirely — rather than pinning the in-memory driver —
  drops the session runtime and `unstorage` from `dist/server` with no KV
  binding required. Safe here because the guest site never reads or writes
  `Astro.session`.
- **SSR minification (#616).** `vite: { build: { minify: true } }` in
  `astro.config.mjs` does nothing for the server build: Astro's
  `createViteBuildConfig` (`astro/dist/core/build/vite-build-config.js`)
  spreads the user's `vite.build` and then hard-sets `minify: false`
  afterward for build-performance reasons, and separately replaces the `ssr`
  environment's whole `build` key, dropping any environment-scoped
  `minify` too. The fix is a small inline Astro integration hooking
  `astro:build:setup`, which Astro runs once (`target: "server"`) after that
  config exists, and whose `updateConfig` merges on top of it — the `prerender`
  and `ssr` environments inherit the resulting top-level `minify: true`; the
  `client` environment doesn't, because its own `minify` is set independently,
  so the client bundle is unaffected. The minifier under this Astro (Vite 8 /
  rolldown-vite) is OXC — pass `minify: true`, not `"esbuild"`.
- **Source maps, server-side only.** Minifying the server build means a
  production Worker exception no longer names a real source line, so this ships
  with `sourcemap: true` set **through the same `astro:build:setup` hook** as
  `minify`, plus `upload_source_maps: true` in `cire/invites/wrangler.jsonc` —
  the adapter never sets that key itself, so it has to come from the checked-in
  config the generated `dist/server/wrangler.json` extends. Both CI rewrite
  steps that touch that generated file (`deploy.yml`, dev and prod) only delete
  `legacy_env` and set `name`/`routes`, so the key survives into the deployed
  config untouched.

  > [!warning] Never set `sourcemap` as a plain `vite.build` value here.
  > Unlike `minify`, it is not overridden — it reaches the top level *and* the
  > client environment reads it
  > (`astro/dist/core/build/vite-build-config.js:135`), so the client build
  > emits `dist/client/_astro/*.js.map` too. `dist/client` is this Worker's
  > Static Assets directory (the adapter writes
  > `"assets": { "directory": "../client" }` into the generated wrangler
  > config) and Cloudflare serves everything in it verbatim, so those maps
  > publish the guest site's unminified source at `/_astro/<chunk>.js.map` to
  > anyone who asks. The plain form was written that way first and caught in
  > review; `guard-bundle-size.sh` now fails the build if any `.map` file appears
  > under `dist/client`.
- **`zod` stays (#617).** Traced to Astro's own actions request handler
  (`actions/handler.js` → `actions/runtime/server.js`, top-level
  `import * as z from "zod/v4/core"`), which `core/routing/handler.js` calls
  on every non-prerendered request whether or not the app defines any
  actions (`src/actions` doesn't exist here). There's no app-level config to
  skip that code path, so unlike `motion` (see the SSR-stub comment in
  `astro.config.mjs`) this is not stubbed — it's a real, reachable Astro core
  dependency, not dead weight from an unreachable path.

## Related

- [[cire]] — what cire is, its packages, data model and deployment
- [[cire-auth]] — the two-system auth contract and the role matrix
- [[cire-workerd]] — what cire's observability does differently on workerd
- [[cire-platform-plan]] — where the product is going
- [[frontend-patterns]] — the Solid/Motion/Tailwind gotchas cire found the hard way
