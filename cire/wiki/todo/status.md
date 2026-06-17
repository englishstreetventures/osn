---
title: "Cire TODO — status + up next"
tags: [todo, status]
related:
  - "[[index]]"
  - "[[invite-builder]]"
last-reviewed: 2026-06-16
---

# Status + Up Next

The single high-churn shard. Update **Current Status** when a major slice lands; tick / append to **Up Next** as priorities shift. All other tracking lives in sibling shards under `wiki/todo/`.

## Current Status

Monorepo built and functional. `cire/db` models families with a shareable `publicId` (e.g. `PATEL-JOY-RK97`) and per-family guests; `cire/api` exposes `POST /api/claim` (publicId-only lookup, mints a session), `POST /api/rsvp` (session-cookie gated, per-person per-event with dietary), `GET /api/organiser/guests`, plus rate-limit middleware on `/api/claim`. Organiser portal split into its own Astro app (`cire/organiser`) with `GuestTable` consuming the new shape. **PR-A** landed events metadata + `imports` table + `guests.externalId`. **PR-B** landed session-cookie auth: a 256-bit `cire_session` token is minted on successful claim and set as `HttpOnly; SameSite=Lax; Path=/` (no `Domain=` — host-scoped); `/api/rsvp` is behind a `sessionAuth` middleware that derives `familyId` from the session, dropping `familyPublicId` from the body; CORS now echoes the configured origin with `credentials: true`. **PR-C** is now in: hand-rolled RFC 4180 CSV parser with formula-injection guards, an Effect-based diff service that reconciles parsed sheets against the live DB (creates / updates / removes per family + per guest + per event-link, plus state-loss warnings for guests with non-default RSVPs), R2-versioned uploads keyed at `imports/<importId>/{events,guests}.csv`, and a `revertImport` path that re-applies a previous snapshot. Routes under `/api/organiser/import/{preview,apply,revert,list}` are gated behind a shared-secret `X-Organiser-Token` header (an interim measure, since deleted — see the OSN-merge paragraph below). Backend is Effect-based with Effect Schema validation; tests co-located `*.test.ts` under `bun test` (132 api, 148 web). Migrations: `0001_initial.sql`, `0002_add_rsvp_dietary.sql`, `0003_events_metadata_and_imports.sql`, `0004_perf_indices.sql`. **PR #28** swaps the fixture mehndi/sangeet/wedding/reception set for the real five-event programme (Catholic 31 Oct → Kitchen Tea 20 Nov → Mehendi 22 Nov → Hindu 25 Nov → Reception 28 Nov), wires real Pinterest moodboards on each, invites the default demo code `PATEL-JOY-RK97` to all events, and reworks `PinterestBoard` from `<iframe>` to the documented script-widget pattern with a "View moodboard on Pinterest" fallback for tracker-blocker users (see [[deferred]] resolved row).

**OSN merge (2026-06):** cire.git was imported into the OSN monorepo as the `cire/` workspace via git subtree — packages are now `cire/web` (:4321), `cire/organiser` (:4322), `cire/api` (:8787), `cire/db` (the old `apps/*` / `packages/*` nesting is gone). Organiser auth is real: the portal signs in with **OSN passkeys** (`@osn/client` + `@osn/ui`), `cire/api` verifies the issued ES256 access JWT (`aud: "osn-access"`) via `osnAuth()` from the new `@shared/osn-auth-client` package, and `weddingOwner()` / `ownedWedding()` enforce ownership against the new multi-tenant scaffold (`weddings` root table; `families`/`events`/`imports` carry `wedding_id` NOT NULL FK; migration `0006_multi_tenant.sql`). The interim `X-Organiser-Token` shared secret is **deleted**. Cire also adopted `@shared/typescript-config` + `@shared/rate-limit`, and `bun run dev:cire` (repo root) runs the full stack incl. `@osn/api`. A 12-probe headless E2E against the live dev stack passed. See `[[wiki/apps/cire]]` + `[[wiki/systems/cire-auth]]` in the root OSN wiki. Next slice: wire the runtime D1 layer + substitute the `usr_REPLACE_BEFORE_PROD` bootstrap owner before any remote D1 push.

---

## Up Next

- [x] ~~Rebase the dependent feature branches onto current main~~ — **Obsolete**: cire.git merged into the OSN monorepo (2026-06); old standalone branches are history, cire.git to be archived
- [x] PR-B — session cookie auth for guest claim (HttpOnly `cire_session` cookie, 30-day TTL)
- [x] Spreadsheet parser — CSV-only (xlsx deferred), group rows by `Family Name`, build canonical `ParsedFamily[]` (PR-C)
- [x] Diff + batched upsert service — empty-DB insert path and incremental reconciliation (PR-C)
- [x] Organiser auth — separate from guest claim flow — landed in the OSN merge as OSN passkey sign-in + `osnAuth()` JWT verification (no magic link; see `[[wiki/systems/cire-auth]]`)
- [x] `POST /api/organiser/import/{preview,apply,revert,list}` endpoints (PR-C; now gated behind `osnAuth()` + `ownedWedding()` since the OSN merge)
- [x] Wire organiser portal upload UI to `/api/organiser/import/*` — inline import panel on the dashboard (preview diff → apply); history/revert UI still deferred (see [[spreadsheet-import]])
- [x] Migrate from `X-Organiser-Token` shared secret to organiser passkey auth — done in the OSN merge; token path deleted
- [x] Inline OSN account creation on the organiser login page — `SignInPanel` toggles `<SignIn>` ⇄ `<Register>` (from `@osn/ui`, via `@osn/client`'s registration client) so organisers without an OSN account can register without leaving cire; first vitest harness for `@cire/organiser`. See `[[wiki/systems/cire-auth]]`
- [x] **Observability standards** — `cire/api` adopted `@shared/observability` (workerd-safe subpaths): redacting logger (`runCire`/`runCireSync` → `cireLoggerLayer`), spans on every service fn, `instrumentedFetch` on the S2S ARC call, and `cire/api/src/metrics.ts` (typed `cire.*` counters/histograms, define-now-export-later). See `[[observability/overview]]` + `[[deferred]]` (export on workerd is the one open item).
- [ ] **Substitute `usr_REPLACE_BEFORE_PROD`** (bootstrap `wed_bootstrap` owner in migration `0006_multi_tenant.sql`) with the real OSN profile id **before applying migrations to remote/production D1**
- [x] Migrate runtime DB layer in `cire/api/src/index.ts` from 503 stub to real D1 — `index.ts` is now a Workers `fetch` handler building a per-request Drizzle-D1 client from `env.DB`; `Db` broadened over `"sync" | "async"` so the same service code runs on bun:sqlite (local/tests) and D1 (prod) via a `dbQuery` bridge. Pure JWK helpers split into DB-free `@shared/crypto/jwk` so the `osnAuth` verify path no longer drags `bun:sqlite` into the Worker bundle (build is green). Still pending before remote push: `usr_REPLACE_BEFORE_PROD` substitution + real `database_id`.
- [x] Per-person per-event RSVP with dietary requirements
- [x] Rate-limit claim attempts to prevent brute force — see [[overview]] for logging rules
- [x] Wire guest-app RSVP modal to `POST /api/rsvp` (PR-F)
- [x] Add-to-calendar links on event cards (Google / Apple / .ics) (PR-G)
- [x] **Invite builder** — organiser-editable hero/story images + copy (`wedding_invite_customisations` table, `cire-assets` R2 bucket, `inviteService` + public/organiser routes, `InviteBuilder` tab, `InviteHeader` guest island). Source of truth for events/guests stays in the CSV import. See `[[invite-builder]]`. ⚠️ create `cire-assets` R2 bucket before deploy.
- [x] **Host invite preview** — "Preview invite" button on the organiser dashboard opens the guest invite with a per-wedding `HOST-*` code that sees every event. Synthetic host family (`families.kind = 'host'`, migration `0010_family_kind.sql`), owner-gated `POST /api/organiser/weddings/:weddingId/preview-code` (`hostCodeService.ensureForWedding`), `preview: true` in the claim response (web shows banner + disables RSVP), host families excluded from the import diff and barred from RSVP. New env `PUBLIC_CIRE_WEB_URL`. See `[[wiki/systems/cire-auth]]` (root, Host preview code).
- [ ] **Invite builder follow-ups** — create the `cire-assets` (+ preview) R2 bucket before first deploy; consider a live preview pane + more slots (footer/RSVP banner) once the basic version proves out.
