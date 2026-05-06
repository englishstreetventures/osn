---
title: "Cire TODO"
tags: [todo, progress]
related:
  - "[[index]]"
  - "[[monorepo-structure]]"
  - "[[overview]]"
  - "[[contributing]]"
last-reviewed: 2026-05-05
---

# Cire TODO

Progress tracking and deferred decisions. For full spec see README.md. For code patterns see CLAUDE.md.

## Current Status

Monorepo built and functional. `packages/db` models families with a shareable `publicId` (e.g. `PATEL-JOY-RK97`) and per-family guests; `apps/api` exposes `POST /api/claim` (publicId-only lookup, mints a session), `POST /api/rsvp` (session-cookie gated, per-person per-event with dietary), `GET /api/organiser/guests`, plus rate-limit middleware on `/api/claim`. Organiser portal split into its own Astro app (`apps/organiser`) with `GuestTable` consuming the new shape. **PR-A** landed events metadata + `imports` table + `guests.externalId`. **PR-B** landed session-cookie auth: a 256-bit `cire_session` token is minted on successful claim and set as `HttpOnly; SameSite=Lax; Path=/` (no `Domain=` — host-scoped); `/api/rsvp` is behind a `sessionAuth` middleware that derives `familyId` from the session, dropping `familyPublicId` from the body; CORS now echoes the configured origin with `credentials: true`. **PR-C** is now in: hand-rolled RFC 4180 CSV parser with formula-injection guards, an Effect-based diff service that reconciles parsed sheets against the live DB (creates / updates / removes per family + per guest + per event-link, plus state-loss warnings for guests with non-default RSVPs), R2-versioned uploads keyed at `imports/<importId>/{events,guests}.csv`, and a `revertImport` path that re-applies a previous snapshot. Routes under `/api/organiser/import/{preview,apply,revert,list}` are gated behind a shared-secret `X-Organiser-Token` header (interim until passkey auth lands). Backend is Effect-based with Effect Schema validation; tests co-located `*.test.ts` under `bun test` (120 api, 48 web). Migrations: `0001_initial.sql`, `0002_add_rsvp_dietary.sql`, `0003_events_metadata_and_imports.sql`, `0004_perf_indices.sql`. Next slice: organiser portal upload UI + migrate from shared-secret to organiser passkey auth, plus wiring the guest-app RSVP modal (PR-F) to the live endpoint.

---

## Up Next

- [ ] Rebase the 5 dependent feature branches (`spreadsheet-parser`, `pinterest-embeds`, `dress-code-swatches`, `rsvp-modal-wire`, `calendar-links`) onto this PR-A schema
- [x] PR-B — session cookie auth for guest claim (HttpOnly `cire_session` cookie, 30-day TTL)
- [x] Spreadsheet parser — CSV-only (xlsx deferred), group rows by `Family Name`, build canonical `ParsedFamily[]` (PR-C)
- [x] Diff + batched upsert service — empty-DB insert path and incremental reconciliation (PR-C)
- [ ] Organiser auth — separate from guest claim flow (passkey + magic link)
- [x] `POST /api/organiser/import/{preview,apply,revert,list}` endpoints (PR-C; gated behind `X-Organiser-Token` shared secret)
- [ ] Wire organiser portal upload UI to `/api/organiser/import/*` — preview diff table with warnings, apply, list, revert
- [ ] Migrate from `X-Organiser-Token` shared secret to organiser passkey auth
- [ ] Migrate runtime DB layer in `apps/api/src/index.ts` from 503 stub to real D1
- [x] Per-person per-event RSVP with dietary requirements
- [x] Rate-limit claim attempts to prevent brute force — see [[overview]] for logging rules
- [ ] Wire guest-app RSVP modal to `POST /api/rsvp` (PR-F)
- [ ] Add-to-calendar links on event cards (Google / Apple / .ics) (PR-G)

---

## Organiser Spreadsheet Import

Source spreadsheet has these columns: `Family ID, Guest First Name, Guest Last Name, Family Name, Catholic Wedding, Hindu Wedding, Reception, Mehndi`. Row grouping is by `Family Name`; only the last row of each family carries a Family ID in the source sheet (we ignore that — Cire generates its own `publicId`). Each guest row has booleans per event.

### Spreadsheet ingestion (apps/api)

- [x] `services/spreadsheet.ts` — `parseEventsCsv` / `parseGuestsCsv` (hand-rolled RFC 4180); rejects formula-injection cells (cells starting with `=`, `+`, `-`, `@`) (PR-C)
- [x] `services/import.ts` — `diffAgainstDb(parsed)` returns `ImportPlan` (creates / updates / removes per family + per guest); `applyImport(plan)` executes in dependency order with per-statement chunking (PR-C)
- [x] `services/r2-imports.ts` — R2Service Context tag + `storeUpload` / `fetchUpload` (PR-C)
- [x] `services/revert.ts` — `revertImport` re-fetches prior CSVs from R2, re-parses, re-diffs, re-applies (PR-C)
- [x] `schemas/import.ts` — Effect Schema for `ParsedEvent`, `ParsedFamily`, `ImportPlan`, request/response shapes (PR-C)
- [x] Plan preserves `publicId` for matched families (case+whitespace-insensitive on `family_name`); only mints new IDs for brand-new families (PR-C)
- [x] Per-guest event invitations from boolean columns drive `guestEvents` rows (PR-C)
- [ ] When the source sheet adds a stable `Guest ID` column, populate `guests.externalId` from it (already in schema as of PR-A)

### Organiser portal (apps/web + apps/api)

- [ ] Organiser auth model (passkey + magic link, separate `organisers` table)
- [ ] Auth middleware that rejects guest sessions on organiser endpoints
- [ ] `/organiser/import` page — paste / upload, preview diff table, confirm
- [ ] Extend `OrganiserView` to display family-grouped guests with shareable publicId + password (show password only at family creation, hash thereafter — surface a "regenerate password" action)

### Cloudflare wiring

- [ ] Replace `bun:sqlite` runtime in `apps/api/src/index.ts` with `drizzle(env.DB)` on D1
- [ ] `bunx wrangler d1 migrations apply cire-db --local` in dev script
- [ ] `bunx wrangler types` after binding changes
- [ ] **Provision R2 bucket `cire-sheets` (and `cire-sheets-preview`) before first deploy** — `bunx wrangler r2 bucket create cire-sheets`. Binding `SHEETS` is already declared in `apps/api/wrangler.toml` as of PR-A.
- [ ] Batch import respects 50ms CPU / 30s wall-time Worker limits — chunk inserts to ~100 rows; consider Durable Objects or Queues for guest lists ≥ ~500 families

---

## apps/web

- [x] Per-event metadata in `EventSummary` shape (calendar / dress-code / address / Pinterest / Maps fields landed in PR-A)
- [x] Rework `OrganiserView` to consume the new `OrganiserGuestRow` shape — moved to `apps/organiser/src/components/GuestTable.tsx`
- [ ] Replace hero photo placeholder with actual photo
- [ ] Customise monogram with couple's initials
- [ ] Write Our Story content
- [ ] Populate dress code colour palette swatches from `event.dressCodePalette` (PR-E)
- [ ] Embed actual Pinterest board URLs via `event.pinterestUrl` (PR-D)
- [ ] Wire RSVP modal to API using surfaced `guestId` per member (PR-F)
- [ ] "Open in Maps" button on event cards driven by `event.mapsUrl`
- [ ] Add-to-calendar links (Google Calendar, Apple Calendar, .ics) sourced from `event.startAt` / `endAt` / `timezone` (PR-G)
- [ ] Passkey registration + login UI
- [ ] Magic link email fallback UI

---

## apps/api

- [x] Surface `guestId` on every claim member + extended event metadata (PR-A)
- [x] Session-cookie auth on `/api/rsvp`; `/api/claim` mints `cire_session` (PR-B)
- [ ] Set `Domain=` on session cookie when production root domain lands; today host-scoped works for same-origin dev.
- [ ] Cron-triggered `DELETE FROM sessions WHERE expires_at < now` — without this the sessions table grows unbounded as tokens expire but rows remain. Cloudflare cron trigger or a sweep on each `createSession`.
- [x] Spreadsheet parser + diff service + import endpoints (PR-C — see Organiser Spreadsheet Import above)
- [ ] Organiser auth middleware (currently shared-secret `X-Organiser-Token`; passkey auth is the follow-up)
- [x] **Revert capability for applied imports** — `POST /api/organiser/import/revert` re-fetches the prior `applied` import's CSVs from R2, re-parses, re-diffs, re-applies, and marks the current row `reverted` (PR-C)
- [x] `POST /api/rsvp` — per-person per-event RSVP with dietary requirements (gated behind `sessionAuth` cookie middleware as of PR-B)
- [ ] `GET /api/events` — list events for the wedding
- [ ] Drizzle D1 client wired in `src/index.ts` (currently 503 stub)
- [ ] Auth middleware — validate passkey session or magic link token
- [ ] Passkey (WebAuthn) registration + authentication endpoints
- [ ] Magic link email dispatch (Resend)
- [ ] Admin endpoints — view RSVPs, regenerate passwords, deactivate families

---

## packages/db

See [[monorepo-structure]] for how this package fits into the dependency graph.

- [x] Events: `startAt`, `endAt`, `timezone`, `address`, `dressCodeDescription`, `dressCodePalette`, `pinterestUrl`, `mapsUrl`, `sortOrder` (PR-A)
- [x] `imports` table for spreadsheet-upload tracking with R2 keys + status lifecycle (PR-A)
- [x] `guests.externalId` nullable column for forward-looking spreadsheet stable IDs (PR-A)
- [ ] Add `organisers` + `organiser_sessions` tables once auth lands
- [x] Add `dietary_requirements` column to rsvps (added as `dietary` text NOT NULL DEFAULT '' in migration `0002_add_rsvp_dietary.sql`; per-event dietary lives on `rsvps` row)
- [ ] Retire deprecated `events.date` / `events.location` columns (kept in 0003 for backwards compatibility — D1 is forward-only so this needs a separate copy-and-drop migration)
- [ ] Seed script for local development that exercises real `generatePublicId` / `generatePassword` (currently uses fixed JSON fixtures so tests stay deterministic)

---

## Security Backlog

See [[overview]] for observability rules that apply to all security-sensitive code paths. See [[review-findings]] for severity prefix conventions.

**Critical**

- [ ] `GET /api/organiser/guests` is currently unauthenticated and exposes every family's `publicId` — must be gated behind organiser auth (or removed from the deployed app) before any public launch.
- [x] Rate-limit `POST /api/claim` — KV-backed limiter via `apps/api/src/middleware/rate-limit.ts`

**High**

- [ ] Organiser import endpoints must require organiser session — never guest session (currently gated behind shared-secret `X-Organiser-Token` as MVP interim — PR-C)
- [x] Spreadsheet parser must reject formula-injection cells (leading `=`, `+`, `-`, `@`) (PR-C; trim-resilient as of PR-C review)
- [x] X-Organiser-Token compared in constant time (PR-C review)
- [x] Formula-injection guard checks trimmed cell, not raw cell (PR-C review)
- [ ] Magic link tokens must be single-use and expire (≤15 min)

**Medium**

- [x] RSVP endpoint must verify the session owns the family the guest belongs to (PR-B: `sessionAuth` middleware sets `familyId` from cookie; route validates each `guestId` belongs to that family)
- [ ] Invite token in URL (if any) must be opaque (UUID/random) — not a guest or family id
- [ ] On password regeneration, invalidate existing sessions for that family
- [x] `decodePalette` emits a structured warning (no PII) on malformed JSON or shape mismatch so corrupted rows don't fail silently (PR-A review)
- [x] Session tokens hashed at rest — `sessions.token` stores SHA-256 hex of the raw token; cookie still carries the raw value (PR-B review)
- [x] `/preview` rejects > 1MB body via Content-Length pre-check (PR-C review)
- [x] CSV parser enforces ≤5000 rows + ≤10_000 chars/cell + rejects unterminated-quote at EOF (PR-C review)

**Low**

- [ ] Review Cloudflare Worker CSP headers on the web app
- [ ] Confirm all D1 queries go through Drizzle (no raw SQL interpolation anywhere)
- [ ] Expand passphrase wordlist to ≥1024 entries for ≥40 bits of entropy
- [ ] CI guard: fail deploy if `apps/api/wrangler.toml` still has the literal `database_id = "placeholder-replace-after-d1-create"` (PR-A review)
- [ ] Frontend `href` validator — when `pinterestUrl` / `mapsUrl` / `address` start being rendered as links, run them through `new URL(...)` + `protocol === 'https:'` to block `javascript:` URIs (PR-D / PR-E / PR-G)
- [ ] Whitelist 422 `MalformedSpreadsheet` reason strings — currently safe (only static literals are surfaced) but document the constraint so future contributors don't interpolate cell contents into the `reason` field (PR-C review)

---

## Performance Backlog

See [[review-findings]] for severity prefix conventions.

- [x] Split joined events from per-guest rows in `claim.lookup` to drop the duplicated `dressCodePalette` payload (PR-A review)
- [x] Drop redundant ownership `SELECT` in `rsvpService.submitRsvp` (route validates once for the bulk batch) (PR-A review)
- [x] Add `events.sortOrder` and `(guests.familyId, guests.sortOrder)` indices (PR-A review, migration 0004)
- [x] `lefthook` pre-push runs typecheck + test in parallel (PR-A review)
- [ ] PBKDF2 100k iterations + dummy-hash-on-miss is ~20-40ms per request on Workers. Pairs with rate limiting (above) before public launch — once that's in place, consider lowering iterations to 25-50k for a wedding-scale threat model.
- [ ] `getAllGuests` paginate / cursor once organiser UI is built — current single-join is fine at 100 guests, problematic past a few thousand
- [ ] Batch `rsvpService.submitRsvp` upserts via `db.batch([...])` once D1 runtime is wired (currently still N round-trips, just no longer 2N) — PR-A review follow-up
- [ ] `claim.lookup` could pipeline its 3 D1 queries via `Effect.all`; today they are sequential which adds ~2 round-trips of latency on the hot path — PR-A review follow-up
- [ ] Landing page animations must not block LCP — defer Motion One until after first paint
- [ ] Hero photo must be optimised (WebP/AVIF, responsive srcset)
- [ ] Add-to-calendar data should not require a round-trip if event data is already hydrated in the page
- [ ] .ics generation can be client-side to avoid unnecessary Worker invocation
- [ ] Spreadsheet import on Workers: chunk inserts (≤100 rows per batch) to stay under 50ms CPU per request; offload large diffs to a Queue-driven worker
- [x] `/list` paginated with `limit` + `uploadedAt` cursor (PR-C review)
- [ ] Cache the parsed `ImportPlan` on the imports row to avoid re-parse + re-diff on `/apply` and `/revert` (currently re-runs both as TOCTOU defence). Consider once organiser sheet exceeds ~600 rows or revert latency becomes user-visible (PR-C review)

---

## Deferred Decisions

| Question                                  | Options considered                                                                                        | Deadline / trigger                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Event invitations per-family vs per-guest | Per-guest matches sheet exactly (current schema); per-family simpler but loses fidelity                   | After first import lands and real spreadsheet variation is observed |
| Organiser auth model                      | Reuse passkey infra with role flag vs. separate `organisers` table                                        | Before `/api/organiser/import` is hardened                          |
| Surname collision handling in publicId    | Accept multiple `PATEL-*-*` IDs (different word/hash disambiguates) vs. enforce uniqueness on family_name | Stay on current accept-multiple unless aesthetic problem reported   |
| Astro → Solid Start migration             | Keep Astro+islands vs migrate guest-facing app to Solid Start for tighter SPA flows                       | Post-platformisation — only if SaaS direction is taken              |
| Platformise Cire                          | Multi-tenant SaaS vs stay bespoke                                                                         | After friend's wedding ships                                        |
| SMS OTP fallback                          | Twilio/similar vs email-only                                                                              | If magic link proves insufficient                                   |
| Seating planner                           | D1 table arrangement feature                                                                              | Post-MVP                                                            |
| Photo collections                         | Cloudflare R2 + upload UI                                                                                 | Post-MVP                                                            |
| Wishing well                              | Payment processing (requires ABN)                                                                         | After business is set up                                            |
| Guest photo sharing                       | R2 + moderation                                                                                           | Post-MVP                                                            |
| iPhone AirDrop sharing                    | Web Share API + custom payload                                                                            | After core invite is built                                          |

### Resolved

| Question                 | Resolution                                                                                                                                              | Resolved   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Pinterest embed approach | iframe for MVP (good-enough preview, no API rate limits); upgrade to static-image board snapshots post-launch                                           | 2026-05-05 |
| Spreadsheet input format | CSV-only for MVP (two sheets: events + guests). `.xlsx` deferred — would need SheetJS, slower upload, and most organisers can export CSV from any tool. | 2026-05-05 |

---

## Future

- Astro → Solid Start migration for the guest-facing app (post-platformisation, only if SaaS path is taken)
- Apple Wallet pass generation for each event
- Magic link email fallback (Resend)
- D1 migration + wrangler deploy path
- Platformise as multi-tenant wedding invite SaaS
- General wedding planning — guest list management, seating charts
- Physical + digital hybrid: QR codes on printed invites linking to digital counterparts
- Wishing well with payment processing
- Photo collection and guest photo uploads
- iPhone tip-to-tip AirDrop invite sharing
- White-label / custom domain support per wedding
