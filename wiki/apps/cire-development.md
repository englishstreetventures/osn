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
  - "[[commands]]"
last-reviewed: 2026-08-21
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

## Related

- [[cire]] — what cire is, its packages, data model and deployment
- [[cire-auth]] — the two-system auth contract and the role matrix
- [[cire-workerd]] — what cire's observability does differently on workerd
- [[cire-platform-plan]] — where the product is going
- [[frontend-patterns]] — the Solid/Motion/Tailwind gotchas cire found the hard way
