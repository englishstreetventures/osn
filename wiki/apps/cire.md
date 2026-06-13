---
title: Cire
description: Wedding-invite stack (guest site, organiser portal, API, DB)
tags: [app, weddings]
status: active
packages:
  - "@cire/web"
  - "@cire/organiser"
  - "@cire/api"
  - "@cire/db"
related:
  - "[[cire-auth]]"
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[data-map]]"
  - "[[dpia/cire-guest-data]]"
last-reviewed: 2026-06-12
---

# Cire

Cire is a bespoke digital wedding invite — a tactile, animated guest-facing site plus an organiser portal for managing the guest list via spreadsheet import. It started life as a standalone repo (`cire.git`) and was merged into the OSN monorepo as a sibling workspace (`cire/*`, first in the root `workspaces` array). The data model is already multi-tenant (a `weddings` root table) so the bespoke build can platformise later without a schema rewrite.

## Packages

| Package | Dir | Port (dev) | Purpose |
|---|---|---|---|
| `@cire/web` | `cire/web` | 4321 | Guest-facing Astro + SolidJS site (claim code → events → RSVP) |
| `@cire/organiser` | `cire/organiser` | 4322 | Organiser portal (Astro + SolidJS) — guest/event tables, spreadsheet import, OSN passkey sign-in |
| `@cire/api` | `cire/api` | 8787 | Elysia on Cloudflare Workers + Effect services + Drizzle on D1 |
| `@cire/db` | `cire/db` | — | Drizzle schema + D1 SQL migrations |

Note: `@cire/api` runs Elysia with `aot: false` — Elysia's ahead-of-time compilation builds handlers via `new Function`, which Cloudflare Workers forbids. Organiser auth uses the shared Elysia adapter (`@shared/osn-auth-client/middleware/elysia`), same as the other backends. (Migrated from Hono 2026-06-12 — see `[[changelog/completed-features]]`.)

## Auth model (summary)

Two deliberately separate systems — full contract in [[cire-auth]]:

- **Guests** never become OSN account holders. A family claim code (`families.public_id`, e.g. `SHARMA-IVY-QM42`) is exchanged at `POST /api/claim` for a 256-bit session token (SHA-256-hashed at rest), carried in a 30-day HttpOnly `cire_session` cookie. `sessionAuth()` gates `/api/rsvp`.
- **Organisers** sign in with their OSN passkey (via `@osn/client` + `@osn/ui` on the portal). `cire/api` verifies the resulting ES256 access JWT (`aud: "osn-access"`) against the OSN issuer's JWKS using `osnAuth()` from `@shared/osn-auth-client`; wedding ownership is enforced by `weddingOwner()` / `ownedWedding()` middleware against `weddings.owner_osn_profile_id`.

## Data model

- `weddings` is the root table; `families`, `events`, and `imports` carry a `wedding_id` NOT NULL FK (cascade). Multi-tenant scaffold, single wedding in practice today.
- Ownership is interim single-owner: `weddings.owner_osn_profile_id` stores an opaque OSN profile id (`usr_*` string — **no cross-DB FK**; cire's D1 and OSN's DB are separate databases).
- Migration `0006_multi_tenant.sql` uses a deliberate `__keep_*` snapshot/restore idiom — DROP TABLE under enforced FKs fires ON DELETE CASCADE into children on D1 (the pragma can't be disabled there), verified empirically. Its bootstrap row `wed_bootstrap` ships with placeholder owner `usr_REPLACE_BEFORE_PROD`, which **must** be substituted with the real OSN profile id before the migration is applied to remote/production D1.

## Local dev

```bash
bun run dev:cire   # @cire/api (:8787) + @cire/web (:4321) + @cire/organiser (:4322) + @osn/api (:4000)
```

`@osn/api` is included because organiser sign-in needs the OSN issuer (passkey ceremony + JWKS). The osn/api local-dev CORS fallback includes `http://localhost:4322` for the portal.

## Cire-internal docs

Cire keeps its own knowledge graph: `cire/CLAUDE.md` is the AI entry point and `cire/wiki/` is the Obsidian vault (architecture, conventions, observability, per-area TODO shards under `cire/wiki/todo/`). This page and [[cire-auth]] cover the OSN-facing integration surface only.

## Future integrations

- **Pulse event feed** — surface cire weddings in Pulse's event feed. Mechanism undecided: ARC-token pull from `cire/api` vs push-on-publish into `pulse/db` (Deferred Decisions in `wiki/TODO.md`).
- **Multi-owner weddings** — replace `owner_osn_profile_id` with a `wedding_owners(wedding_id, osn_profile_id, role owner/editor/viewer)` join table.
- **Guest claim-code → optional OSN account linking** — let a guest attach their claimed family to an OSN account later.

## Compliance

Guest data (family/guest names, RSVP status, **special-category dietary
free-text**, claim codes) lives in cire's own Cloudflare D1 + R2 and is
recorded in the OSN compliance programme:

- [[data-map]] — cire section (fields, lawful basis, recipients); C-H1 retention + C-L1 age-gate note
- [[dpia/cire-guest-data]] — Art. 35 DPIA (dietary special-category; sign-off pending on consent capture, C-H2)
- [[retention]] — cire rows (no purge / sweeper / R2 lifecycle yet — C-H1)
- [[subprocessors]] — Cloudflare D1/R2 (guest-PII volume) + Pinterest embed (C-H3)
- [[dsar]] — cross-DB reachability + orphan-tolerance decision (C-M1)
- [[access-control]] — cire D1/R2 operator access + the two cire credential classes (C-M3)
- [[soc2]] — `@cire/api` observability exception; redaction deny-list interim guard (C-M2)

## Related

- [[cire-auth]] — the two-auth-system contract (guest sessions + organiser OSN passkeys)
- [[identity-model]] — OSN accounts/profiles that organiser auth builds on
- [[passkey-primary]] — the passkey-only login model organisers use
