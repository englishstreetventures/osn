---
title: "Monorepo Structure"
tags: [architecture]
related: [[contributing]], [[index]]
last-reviewed: 2026-08-07
---

# Monorepo Structure

Cire lives inside the **OSN monorepo** as the `cire/` workspace directory (merged from the standalone cire.git via git subtree, 2026-06). Packages are flat siblings — the old standalone `apps/*` / `packages/*` nesting is gone. Root workspace globs include `cire/*` and packages are named `@cire/*`.

## Directory Tree

```
<osn repo root>/
├── cire/
│   ├── web/             # @cire/invites — Astro + SolidJS guest site — Cloudflare Pages, port 4321
│   │   ├── src/
│   │   │   ├── pages/       # .astro page shells
│   │   │   ├── components/  # SolidJS islands
│   │   │   └── layouts/
│   │   ├── astro.config.mjs
│   │   └── package.json
│   ├── organiser/       # @cire/host — Astro + SolidJS organiser portal, port 4322
│   │   └── src/             # OSN sign-in by OIDC redirect via @shared/rp-auth
│   ├── api/             # @cire/api — Elysia on Cloudflare Workers, port 8787 (local)
│   │   ├── src/
│   │   │   ├── routes/      # One route factory per domain
│   │   │   ├── services/    # Business logic (Effect-based)
│   │   │   ├── middleware/  # sessionAuth, osnAuth, weddingOwner, rate-limit (Elysia plugins)
│   │   │   └── index.ts     # Worker entry (builds the Elysia app per request)
│   │   ├── wrangler.toml
│   │   └── package.json
│   ├── db/              # @cire/db — Drizzle schemas + D1 migrations
│   │   ├── src/
│   │   │   └── schema.ts
│   │   ├── migrations/      # D1 SQL migrations (0001 … 0006_multi_tenant)
│   │   ├── drizzle.config.ts
│   │   └── package.json
│   ├── wiki/            # Obsidian knowledge graph (this directory)
│   ├── CLAUDE.md
│   └── README.md
├── osn/ pulse/ zap/     # Sibling OSN domains
├── shared/              # @shared/* cross-cutting packages (osn-auth-client, rate-limit, …)
└── package.json         # OSN root workspace config
```

## Workspace Conventions

- Package manager: **bun** — always use `bun run`, `bunx --bun`, `bun add`.
- Workspaces defined in the **OSN root** `package.json`: `cire/*` alongside `osn/*`, `pulse/*`, `zap/*`, `shared/*`.
- Scope commands with `--cwd` from the repo root: e.g., `bun run --cwd cire/api test`.
- `bun run dev:cire` (repo root) starts `@cire/api` + `@cire/invites` + `@cire/host` + `@osn/api` (organiser sign-in redirects to the OSN issuer). Local sign-in also needs an `oauth_clients` row in the local OSN D1 and `CIRE_OIDC_CLIENT_SECRET` in `cire/api/.dev.vars` — without them `/api/auth/oidc/*` answers 503 and the rest of cire works as normal.

## Dependency Flow

```
cire/invites ──fetch──▶ cire/api          (runtime, via HTTP)
cire/host ──fetch──▶ cire/api    (runtime, via HTTP; cire_org_session cookie)
cire/host ──import──▶ @shared/rp-auth   (redirect sign-in + session reads)
cire/api ──redirect──▶ osn/api        (OIDC authorize + server-side code exchange)

cire/invites ──import──▶ cire/db          (schema types only)
cire/api ──import──▶ cire/db          (schema + query building)
cire/api ──import──▶ @shared/osn-auth-client, @shared/rate-limit
```

- `web / organiser → api`: runtime dependency via `fetch` calls. No direct import.
- `web + api → db`: both import Drizzle schema types. Only `api` runs queries.
- Effect is backend + DB only — never import it in `cire/invites` or `cire/host`.

## Ports (Local Dev)

| App              | Port | Command                              |
| ---------------- | ---- | ------------------------------------ |
| `cire/invites`       | 4321 | `bun run --cwd cire/invites dev`         |
| `cire/host` | 4322 | `bun run --cwd cire/host dev`   |
| `cire/api`       | 8787 | `bun run --cwd cire/api dev` (wrangler dev) |
| `@osn/api`       | 4000 | `bun run --cwd osn/api dev` (issuer for organiser sign-in) |
