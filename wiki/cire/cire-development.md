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
  - "[[cire-registry]]"
last-reviewed: 2026-09-25
---

# Cire development guide

What is true of cire and not of the rest of the monorepo. Everything else — branch
strategy, changesets, commit signing, hooks, the issue workflow, the wiki rules —
comes from the root `AGENTS.md` and the platform pages, which are authoritative.

> **This page is the per-product pattern.** A product with enough of its own build
> conventions to be worth writing down gets `wiki/<product>/<product>-development.md`,
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
| `wedding-member.ts` | reads + invite preview — every role carrying the `member` capability (`editor`, `viewer`; **not** `helper`) |
| `wedding-run-sheet.ts` | the day-of run sheet — every role including `helper`. Standalone: mount it INSTEAD OF `wedding-member.ts`, never after it |
| `wedding-role.ts` | not a gate — the policy the three role gates ask. Exhaustive over the role enum, so a new role fails `check` until decided |
| `rate-limit.ts`, `turnstile.ts` | abuse gates |

Pick the gate from the roles matrix in [[cire-auth]], not by guessing from the
route name. Never add a role check inside a route handler: the roles live in
`wedding-role.ts` so that adding one to the column is a compile error at every
place that decides, and a check written in a handler is invisible to that.

## Tests

Platform conventions are in [[testing-patterns]]; the real-Chromium tier is in
[[browser-tests]]. Cire specifics:

- Test files live in `tests/` at the package root, mirroring `src/` — never
  beside their source. `cire/api/src/services/import.ts` pairs with
  `cire/api/tests/services/import.test.ts`, and test-only support code sits
  there too (`cire/api/tests/test-helpers/`, `cire/host/tests/test-support/`).
  The Miniflare-backed D1 tier is cire's alone: `cire/api/tests/db/`, run on its
  own with `bun run --cwd cire/api test:d1`. Unlike the vitest packages, which
  exclude that tier by path, `@cire/api` runs on `bun test` and so picks it up in
  the package's ordinary `test` script as well — expect workerd to boot there.
- **Exercising the upgrade checkout locally** needs TWO `stripe listen`
  forwarders, because there are two endpoints: `--forward-connect-to` for gift
  events (which happen on a couple's connected account) and `--forward-to` for
  the platform's own (an upgrade, where cire is the merchant). One `stripe
  listen` prints ONE signing secret for everything it forwards, so locally
  `STRIPE_WEBHOOK_SECRET` and `STRIPE_PLATFORM_WEBHOOK_SECRET` carry the same
  value; deployed tiers have two dashboard endpoints and two different secrets.
  The full command is in `wiki/cire/cire-upgrades.md`.
- **Integration tests run against a local D1 via `wrangler dev` — do not mock the
  database.**
- **`*.ssr.test.tsx` renders an island through Solid's server build**, the way
  the guest site's Worker does before hydration (`@cire/invites` only, its `ssr`
  Vitest project: Node environment, `solidPlugin({ ssr: true })`). Use it for
  anything the island does during the server render, above all a request: the
  `unit` project resolves `solid-js` to the browser build and cannot see one. It
  runs in `bun run --cwd cire/invites test` beside `unit`. Why it matters:
  [[frontend-patterns#Server-rendered islands]].
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
  Aligning it is an open issue in `englishstventures/osn`.

## Type-check configs

Two cire packages check their shipped source under a narrower config than their
tests, so the compiler rejects what the runtime lacks. Each package's `check`
script runs both configs, and the test config sits at `tests/tsconfig.json` so
the editor finds it for test files (see [[testing-patterns#Rules]]).

| Package | `tsconfig.json` (shipped source) | `tests/tsconfig.json` |
|---|---|---|
| `@cire/api` | The Worker: Workers types only, `lib` ES2023. Leaves out `src/local.ts` and `src/db/setup.ts`, the two files that only run under Bun | Adds `bun-types`; includes the tests and those two files |
| `@cire/invites` | `lib` ES2022 + DOM, set in the file rather than inherited, which the browser floor in the root `.browserslistrc` implements (see [[frontend-patterns#Supported browsers]]) | `lib` ES2023, for `toSorted` and `toReversed` in tests |

What this does and does not catch:

- A `Bun.*` call or a `bun:*` import in `cire/api` Worker source fails `check`.
  `process` and the Node globals do not: `@cloudflare/workers-types` declares
  `process` as `any`, and `@elysiajs/cors` pulls in `@types/node` through
  `undici-types`. So a `process.env` read at module load — empty on workerd at
  deploy-time evaluation, see [[backend-patterns]] — is still a review rule, not a
  compiler one.
- An ES2023 method such as `toSorted` in `cire/invites/src` (a `.ts`, `.tsx` or
  `.astro` file) fails `check`. The same call in a workspace package the guest site
  imports (`@cire/theme`, `@cire/invite-designs`, `@cire/dietary`, `@shared/legal`,
  `@shared/design-tokens`) does not: those packages check at ES2023 because the
  Worker uses them too, and `astro check` reports only the files in its own
  project. Astro also builds the client bundle at `esnext`, so nothing lowers
  newer syntax for old browsers either.
- In the editor, `cire/api/src/local.ts` and `src/db/setup.ts` belong to neither
  package config and fall back to the repo-root `tsconfig.json`. `check` is still
  right for them.

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

### Adding a column

Generating a migration here is `db:generate`, not `db:migrate` — cire is the one
`*/db` package where `db:migrate:local|dev|prod` *applies* a migration to a tier
rather than emitting one:

```bash
bun run --cwd cire/db db:generate --name rsvp_dietary_presets
```

Pass `--name`. Without it drizzle-kit invents one, and the journal entry's `tag`
is the emitted filename — renaming the file by hand afterwards fails the first
assertion in `cire/api/tests/db/ddl-lockstep.test.ts`.

**A cire column has three DDL surfaces, not two.** The migration and
`cire/db/src/schema.ts` are the two an agent reaches for; the third is the test
DDL in `cire/api/src/db/setup.ts`, which the whole `@cire/api` suite boots
against. Miss it and `bun test cire/api/tests/` fails in the lockstep test with
the column's own name, after every other gate has passed. Full contract for the
mirror is in [[cire-platform-plan]] §Code map.

**A field the guest site reads is optional there.** `deploy-cire-invites` has no
`needs:` edge on `deploy-cire-api` in `deploy.yml`, so the site can reach
production before the API that serves a new field. `isValidClaimResponse`
(`cire/invites/src/components/utils.ts`) is read as "no session" by both its
callers when it returns `false`, so a field it requires sends every signed-in
household back to the code form for that window. Give the field `?` in the type
(`cire/invites/src/components/types.ts`), check its type in the guard only when
it is present, and let the reader supply a default that fails closed — as the two
dietary fields on `RsvpSummary` do. If the page also writes the field back, an
API older than the column accepts the write and drops the field, so a value
entered in that window is not stored.

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

## Portal security headers

The organiser portal (`@cire/host`) and the vendor portal (`@cire/vendor`) are
static Astro builds on Cloudflare Pages. Every response header they send comes
from `public/_headers`, which Pages applies to every path. `astro dev` does
not read that file, so the devloop runs with no CSP at all.

**The committed file is the production policy.** Its `connect-src`, `img-src`,
`report-uri` and `Reporting-Endpoints` name `https://api.cireweddings.com` and
nothing else. After `astro build`, the integration in `src/lib/tier-headers.ts`
rewrites the copy in `dist/`: every production cire-api origin becomes the
origin of the `PUBLIC_CIRE_API_URL` the bundle was built with. So:

| Build | The policy in `dist/_headers` names |
|---|---|
| Production (`deploy.yml` sets `https://api.cireweddings.com`) | The committed file, byte for byte |
| Dev (`deploy.yml` sets `https://api.dev.cireweddings.com`) | The dev API and the dev API's CSP report collector |
| Local, env unset | `http://localhost:8787`, for `wrangler pages dev dist` |

The integration reads the env from Vite's resolved config, the same object that
fills `import.meta.env.PUBLIC_*` in the bundle, and resolves it through
`resolveApiUrl` in `src/lib/api-origin.ts`, the same chain `src/lib/osn.ts`
uses. It fails the build in three cases, so a mismatch surfaces in CI rather
than as a blocked API on a deployed tier:

- `_headers` no longer names the production origin
- `PUBLIC_CIRE_API_URL` does not parse as an http(s) URL. An empty value counts.
- No `.js` file in `dist/` contains the origin the header now names

So write only the production origin in `public/_headers`, never a dev or
loopback one; `tests/lib/headers.test.ts` in each portal fails on either.

**Both policies are still report-only.** Each file has two CSP headers: an
enforced one with the three directives that cannot break a page
(`frame-ancestors`, `object-src`, `base-uri`), and the full policy as
`Content-Security-Policy-Report-Only`. Enforcing the full policy is a rename of
that header plus deleting the three-directive line. Two things come first:

- **A real-browser pass on the dev tier that files no report.** For
  `@cire/host`: sign-in, the invite builder, image cropping, the registry's shop
  link picker and the CSV export. For `@cire/vendor`: sign-in, the claim link
  and the enquiry list. Reports from the dev tier go to the dev API's collector
  (`POST /api/csp-report`, logged by the dev Worker), never production's.
- **The organiser portal's `img-src`.** The registry's shop link picker shows
  candidate images straight from each shop's own host (see [[cire-registry]],
  "Link preview"), which the policy does not allow. Enforcing it as written
  blanks the picker.

A profile avatar can come from any host, and neither policy allows one. Both
avatar components fall back to the account's initial when the image fails to
load, a CSP block included.

The guest site (`cire/invites`) solves the same problem another way. It is an
SSR Worker, so its CSP is built by middleware from constants in
`src/lib/security-headers.ts`, and it keeps loopback origins in its production
policy so local runs work. It does not yet derive the API origin per build, so
its dev tier's policy still names the production API.

## Guest-site SSR bundle size

Tracker #619 generalised this guard out of cire/invites: it is now
`scripts/guard-bundle-size.sh` (repo root, `worker` mode for this app), shared
with a `static`-mode measurement for the five non-SSR Astro apps. The
cross-app mechanism — where it runs, why it runs twice, every app's current
threshold — lives in [[bundle-size-guards]]. What stays here is what is
genuinely cire/invites-only: WHY its bundle is shaped the way it is.

In `worker` mode the script sums the gzip size of each file under
`cire/invites/dist/server` on its own, because `no_bundle: true` ships each
chunk as its own module. It leaves out only the adapter's top-level
`wrangler.json` and real source maps — a `.map` beside the chunk it is named
after that parses as a source map. Any other `.map`-named file is counted, so
the total can run above what wrangler uploads but never below it. It also
fails if any `.map` file turns up under `dist/client`, which is served
publicly as Static Assets — see the source-map warning below.

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
