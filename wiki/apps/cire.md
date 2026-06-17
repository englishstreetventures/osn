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
last-reviewed: 2026-06-17
---

# Cire

Cire is a bespoke digital wedding invite — a tactile, animated guest-facing site plus an organiser portal for managing the guest list via spreadsheet import. It started life as a standalone repo (`cire.git`) and was merged into the OSN monorepo as a sibling workspace (`cire/*`, first in the root `workspaces` array). The data model is already multi-tenant (a `weddings` root table) so the bespoke build can platformise later without a schema rewrite.

## Packages

| Package | Dir | Port (dev) | Purpose |
|---|---|---|---|
| `@cire/web` | `cire/web` | 4321 | Guest-facing Astro + SolidJS site (claim code → events → RSVP) |
| `@cire/organiser` | `cire/organiser` | 4322 | Organiser portal (Astro + SolidJS) — guest/event tables, spreadsheet import, OSN passkey sign-in + inline account creation |
| `@cire/api` | `cire/api` | 8787 | Elysia on Cloudflare Workers + Effect services + Drizzle on D1 |
| `@cire/db` | `cire/db` | — | Drizzle schema + D1 SQL migrations |

Note: `@cire/api` runs Elysia with `aot: false` — Elysia's ahead-of-time compilation builds handlers via `new Function`, which Cloudflare Workers forbids. Organiser auth uses the shared Elysia adapter (`@shared/osn-auth-client/middleware/elysia`), same as the other backends. (Migrated from Hono 2026-06-12 — see `[[changelog/completed-features]]`.)

## Auth model (summary)

Two deliberately separate systems — full contract in [[cire-auth]]:

- **Guests** never become OSN account holders. A family claim code (`families.public_id`, e.g. `SHARMA-IVY-QM42`) is exchanged at `POST /api/claim` for a 256-bit session token (SHA-256-hashed at rest), carried in a 30-day HttpOnly `cire_session` cookie. `sessionAuth()` gates `/api/rsvp`.
- **Organisers** sign in with their OSN passkey (via `@osn/client` + `@osn/ui` on the portal), or create a new OSN account inline — the portal's `SignInPanel` toggles between the `<SignIn>` and `<Register>` flows, so an organiser without an account never has to leave to register (the account is still created on OSN, not cire). `cire/api` verifies the resulting ES256 access JWT (`aud: "osn-access"`) against the OSN issuer's JWKS using `osnAuth()` from `@shared/osn-auth-client`; wedding ownership is enforced by `weddingOwner()` / `ownedWedding()` middleware against `weddings.owner_osn_profile_id`.
- **Optional guest account linking** (backend shipped; frontend deferred) — an invitee may attach their seat to an OSN/Pulse account. `POST /api/account/link` is the one dual-credential route (guest cookie + OSN token); it resolves the profile to an account id over ARC and writes `guest_account_links`. Full contract + the 401/dual-credential nuances in [[cire-auth]].

## Data model

- `weddings` is the root table; `families`, `events`, and `imports` carry a `wedding_id` NOT NULL FK (cascade). Multi-tenant scaffold, single wedding in practice today.
- `guest_account_links` records the optional per-invitee OSN link: `guest_id`/`family_id`/`wedding_id` (cascade FKs) + opaque `osn_account_id` / `osn_profile_id` (no cross-DB FK). See [[cire-auth]].
- Ownership is interim single-owner: `weddings.owner_osn_profile_id` stores an opaque OSN profile id (`usr_*` string — **no cross-DB FK**; cire's D1 and OSN's DB are separate databases).
- Migration `0006_multi_tenant.sql` uses a deliberate `__keep_*` snapshot/restore idiom — DROP TABLE under enforced FKs fires ON DELETE CASCADE into children on D1 (the pragma can't be disabled there), verified empirically. Its bootstrap row `wed_bootstrap` ships with an **inert sentinel owner** `usr_unclaimed_bootstrap` — no real profile, so the ownership gate fails CLOSED. The real owner is **not** baked into the migration: it comes from the `BOOTSTRAP_OWNER_PROFILE_ID` env var. `resolveBootstrapOwnerProfileId` (`cire/api/src/db/setup.ts`) feeds the local/test seed (dev default `usr_dev_bootstrap_owner` when `OSN_ENV` is local), and `ensureBootstrapOwner` (`cire/api/src/index.ts`) runs once per isolate to repoint the D1 row off the sentinel in a deployed environment. A missing / placeholder / non-`usr_*` value in any deployed tier THROWS → the worker answers 503 (fail loud). Set `BOOTSTRAP_OWNER_PROFILE_ID` (the real organiser `usr_*` id) as a wrangler secret before the first deployed-D1 boot.

## Local dev

```bash
bun run dev:cire   # @cire/api (:8787) + @cire/web (:4321) + @cire/organiser (:4322) + @osn/api (:4000)
```

`@osn/api` is included because organiser sign-in needs the OSN issuer (passkey ceremony + JWKS). The osn/api local-dev CORS fallback includes `http://localhost:4322` for the portal.

### Resetting / seeding the local DB

```bash
bun run db:reset                          # root: resets every app DB (osn/pulse/zap/cire)
bun run --cwd cire/db db:reset            # cire only: wipe local D1 → db:push → seed
bun run --cwd cire/db db:seed             # seed only (runs scripts/cire-db-seed.sh)
```

`scripts/cire-db-seed.sh` seeds the local miniflare D1 and then re-points the
bootstrap wedding (`wed_bootstrap`, which migration `0006` seeds with the inert
sentinel owner `usr_unclaimed_bootstrap`) to `CIRE_DEV_OWNER_PROFILE_ID` so
the wedding is owned by your signed-in dev account. Set it in `cire/db/.env`:

```bash
CIRE_DEV_OWNER_PROFILE_ID=usr_<your-osn-profile-id>
```

The `cire/api` dev server (`local.ts`) applies the same re-point against its
own **in-memory** seeded DB (not the persistent D1), so `bun run dev:cire` shows
the wedding under your account without a separate seed step. Both paths are
dev-only — neither runs in the deployed Worker (entry `src/index.ts`).
`cire/db` drizzle.config points `db:studio` at the local D1 sqlite (override via
`CIRE_DATABASE_URL`; the content-hashed path changes on `db:reset`).

## Deployment

The cire stack deploys via a **GitHub Actions workflow** (`.github/workflows/deploy.yml`,
PR #128): gated on a build/test job, it applies the remote cire D1 migrations, then
deploys the **cire-api Worker** and the **cire-web Pages** project. Prod wrangler config
is wired (PR #121): the real D1 `database_id` (`e0ebc94c-77df-47a6-af52-40a8c39b3afb`),
the organiser-portal origin in the prod `WEB_ORIGIN` allowlist, the OSN issuer/JWKS URLs
flagged required-before-prod, and D1 + R2 bindings redeclared under `[env.production]`
(named envs don't inherit top-level bindings). The full secret/var checklist, migration
+ bootstrap-owner steps, and post-deploy smoke checks live in the
[[production-deploy]] runbook.

## Cire-internal docs

Cire keeps its own knowledge graph: `cire/CLAUDE.md` is the AI entry point and `cire/wiki/` is the Obsidian vault (architecture, conventions, observability, per-area TODO shards under `cire/wiki/todo/`). This page and [[cire-auth]] cover the OSN-facing integration surface only.

## Future integrations

- **Pulse event feed** — surface cire weddings in Pulse's event feed. Mechanism undecided: ARC-token pull from `cire/api` vs push-on-publish into `pulse/db` (Deferred Decisions in `wiki/TODO.md`).
- **Multi-owner weddings** — replace `owner_osn_profile_id` with a `wedding_owners(wedding_id, osn_profile_id, role owner/editor/viewer)` join table.
- **Guest account-linking frontend** — backend shipped (see [[cire-auth]]); the guest-site "link my Pulse account" affordance is the remaining piece. Once invitees are linked, the Pulse event-feed integration above can surface their invitations.

## Compliance

Guest data (family/guest names, RSVP status, **special-category dietary
free-text**, claim codes) lives in cire's own Cloudflare D1 + R2 and is
recorded in the OSN compliance programme:

- [[data-map]] — cire section (fields, lawful basis, recipients); dietary Art. 9(2)(a) consent captured (C-H2 (cire dietary), PR #123); residual C-H1 R2 retention + C-L1 age-gate note
- [[dpia/cire-guest-data]] — Art. 35 DPIA (dietary special-category; gating consent mitigation RESOLVED PR #123, sign-off pending residual C-H1)
- [[retention]] — cire rows: guest data swept at 1 year (PR #132) + expired guest sessions swept daily (PR #127); R2-object lifecycle still open (C-H1)
- [[subprocessors]] — Cloudflare D1/R2 (guest-PII volume) + Pinterest embed (C-H3)
- privacy notice — guest site publishes `/privacy` + `/terms` (PR #124, C-H4); see [[changelog/compliance-fixes]]
- [[dsar]] — cross-DB reachability + orphan-tolerance decision (C-M1)
- [[access-control]] — cire D1/R2 operator access + the two cire credential classes (C-M3)
- [[soc2]] — `@cire/api` observability exception; redaction deny-list interim guard (C-M2)

## Related

- [[cire-auth]] — the two-auth-system contract (guest sessions + organiser OSN passkeys)
- [[identity-model]] — OSN accounts/profiles that organiser auth builds on
- [[passkey-primary]] — the passkey-only login model organisers use
