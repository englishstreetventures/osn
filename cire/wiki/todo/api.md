---
title: "Cire TODO — cire/api"
tags: [todo, api]
related:
  - "[[index]]"
last-reviewed: 2026-06-12
---

# cire/api

Backend feature work. The Elysia + Effect + Drizzle layer in `cire/api`.

- [x] **Hono → Elysia migration** — `cire/api` now matches the platform convention: route factories (`createClaimRoutes` etc.), middleware as Elysia plugins (scoped `derive` + `onBeforeHandle`), organiser auth via the shared `@shared/osn-auth-client/middleware/elysia` adapter. `aot: false` (Workers forbids `new Function`); POST routes use a sentinel `parse` hook so handlers keep the lenient manual `request.json()` semantics. All routes/status codes/bodies/headers preserved; 169-test suite unchanged and green; wrangler dry-run + Miniflare (workerd) smoke-verified
- [x] Surface `guestId` on every claim member + extended event metadata (PR-A)
- [x] Session-cookie auth on `/api/rsvp`; `/api/claim` mints `cire_session` (PR-B)
- [ ] Set `Domain=` on session cookie when production root domain lands; today host-scoped works for same-origin dev.
- [ ] Cron-triggered `DELETE FROM sessions WHERE expires_at < now` — without this the sessions table grows unbounded as tokens expire but rows remain. Cloudflare cron trigger or a sweep on each `createSession`.
- [x] Spreadsheet parser + diff service + import endpoints (PR-C — see [[spreadsheet-import]] for the dedicated breakdown)
- [x] Organiser auth middleware — OSN-merge: `osnAuth()` (via `@shared/osn-auth-client`) verifies OSN passkey-issued access JWTs on `/api/organiser/*`; `weddingOwner()` / `ownedWedding()` enforce wedding ownership; the interim shared-secret `X-Organiser-Token` is deleted. See `[[wiki/systems/cire-auth]]` in the root OSN wiki.
- [x] **`diffAgainstDb` wedding-scoping** — `diffAgainstDb` now takes a `weddingId` and scopes every read to it: `events` / `families` filter on their `wedding_id` column; `guests` / `guest_events` (no `wedding_id` of their own) are reached by an inner join through `families`. The join is load-bearing — a per-table `WHERE wedding_id = ?` can't touch `guest_events` at all and would read another wedding's links as removals. The interim `MultiWeddingImportUnsupported` fail-closed tripwire (and its 409 route mapping) is removed; preview/apply/revert are now tenant-isolated. Multi-tenant isolation tests added in `services/import.test.ts` + `routes/organiser-import.test.ts`.
- [x] **Revert capability for applied imports** — `POST /api/organiser/import/revert` re-fetches the prior `applied` import's CSVs from R2, re-parses, re-diffs, re-applies, and marks the current row `reverted` (PR-C)
- [x] `POST /api/rsvp` — per-person per-event RSVP with dietary requirements (gated behind `sessionAuth` cookie middleware as of PR-B)
- [x] **D1 integration tests** — `src/db/d1-integration.test.ts` runs the services against a real workerd-backed D1 via Miniflare (the rest of the suite is synchronous bun:sqlite). Covers the async driver path (`claim.lookup`, `submitRsvp` upsert) and the D1-only `db.batch` apply path including its atomic rollback. `miniflare` added as a devDependency
- [ ] `GET /api/events` — list events for the wedding
- [x] Drizzle D1 client wired in `src/index.ts` — Workers `fetch` handler builds a per-request `createD1Db(env.DB)` and serves the Hono app (503 when `DB` unbound). `Db` broadened over `"sync" | "async"`; services bridge the split via `dbQuery` / awaited writes so bun:sqlite (local/tests) and D1 (prod) share one code path. `bun run build` (wrangler dry-run) is green after splitting the pure JWK helpers into DB-free `@shared/crypto/jwk`
- [x] ~~Auth middleware — validate passkey session or magic link token~~ — **Obsolete**: superseded by the two-system model (guest `sessionAuth` cookie + organiser `osnAuth` JWT); no cire-local passkey/magic-link layer
- [x] ~~Passkey (WebAuthn) registration + authentication endpoints~~ — **Obsolete**: organisers reuse OSN's passkey infra (`@osn/api` issuer); cire ships no WebAuthn endpoints of its own
- [x] ~~Magic link email dispatch (Resend)~~ — **Obsolete**: no magic-link factor in the two-system model
- [ ] Admin endpoints — view RSVPs, regenerate passwords, deactivate families
