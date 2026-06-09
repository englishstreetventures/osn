---
title: "Monorepo Structure"
tags: [architecture]
related: [[contributing]], [[index]]
last-reviewed: 2026-05-05
---

# Monorepo Structure

Cire is a bun-workspaced monorepo with two apps and one shared package.

## Directory Tree

```
cire/
├── apps/
│   ├── web/             # Astro + SolidJS — Cloudflare Pages, port 4321
│   │   ├── src/
│   │   │   ├── pages/       # .astro page shells
│   │   │   ├── components/  # SolidJS islands
│   │   │   └── layouts/
│   │   ├── astro.config.mjs
│   │   └── package.json
│   └── api/             # Hono — Cloudflare Workers, port 8787 (local)
│       ├── src/
│       │   ├── routes/      # One file per domain
│       │   ├── services/    # Business logic (Effect-based)
│       │   ├── middleware/
│       │   └── index.ts     # Hono app entry
│       ├── wrangler.toml
│       └── package.json
├── packages/
│   └── db/              # Drizzle schemas + D1 migrations
│       ├── src/
│       │   └── schema.ts
│       ├── migrations/      # D1 SQL migrations
│       ├── drizzle.config.ts
│       └── package.json
├── wiki/                # Obsidian knowledge graph (this directory)
├── CLAUDE.md
├── README.md
├── package.json         # Root workspace config
└── tsconfig.json
```

## Workspace Conventions

- Package manager: **bun** — always use `bun run`, `bunx --bun`, `bun add`.
- Workspaces defined in root `package.json`: `apps/*`, `packages/*`.
- Scope commands with `--cwd`: e.g., `bun --cwd apps/api run test`.

## Dependency Flow

```
apps/web ──fetch──▶ apps/api    (runtime, via HTTP)

apps/web ──import──▶ packages/db  (schema types only)
apps/api ──import──▶ packages/db  (schema + query building)
```

- `web → api`: runtime dependency via `fetch` calls. No direct import.
- `web + api → db`: both import Drizzle schema types. Only `api` performs queries.
- Effect is backend + DB only — never import it in `apps/web`.

## Ports (Local Dev)

| App        | Port | Command                                     |
| ---------- | ---- | ------------------------------------------- |
| `apps/web` | 4321 | `bun --cwd apps/web run dev`                |
| `apps/api` | 8787 | `bun --cwd apps/api run dev` (wrangler dev) |
