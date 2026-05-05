# Cire TODO

Progress tracking and deferred decisions. For full spec see README.md. For code patterns see CLAUDE.md.

## Current Status

Monorepo built and functional. `packages/db` now models families (one per household, with a shared shareable `publicId` like `PRADHEEP-JOY-RK97` and a password hash) and per-family guests; `apps/api` exposes a credential-based `POST /api/claim` (publicId + passphrase) and a guest-listing `GET /api/organiser/guests`. Backend service layer is Effect-based with Effect Schema validation; tests are co-located `*.test.ts` running under `bun test` (38 passing across api, 40 in web). First D1 migration committed under `packages/db/migrations`. The next slice is the organiser-portal spreadsheet upload that drives reconciliation against this schema.

---

## Up Next

- [ ] Spreadsheet parser — accept CSV/TSV paste or .xlsx, group rows by `Family Name`, build canonical `ParsedFamily[]`
- [ ] Diff + batched upsert service — empty-DB insert path and incremental reconciliation
- [ ] Organiser auth — separate from guest claim flow (passkey + magic link)
- [ ] `POST /api/organiser/import/{preview,apply}` endpoints
- [ ] Organiser portal upload UI (paste sheet / upload .xlsx, preview diff, confirm)
- [ ] Frontend rework — two-input login (publicId + password), family-aware welcome + RSVP, organiser table consuming new shape
- [ ] Migrate runtime DB layer in `apps/api/src/index.ts` from 503 stub to real D1
- [ ] Per-person per-event RSVP with dietary requirements
- [ ] Rate-limit claim attempts to prevent brute force

---

## Organiser Spreadsheet Import

Source spreadsheet has these columns: `Family ID, Guest First Name, Guest Last Name, Family Name, Catholic Wedding, Hindu Wedding, Reception, Mehndi`. Row grouping is by `Family Name`; only the last row of each family carries a Family ID in the source sheet (we ignore that — Cire generates its own `publicId`). Each guest row has booleans per event.

### Schema (packages/db) ✓ this PR

- [x] `families` (id, public_id, family_name, password_hash, timestamps)
- [x] `guests` (id, family_id FK, first_name, last_name, sort_order, timestamps)
- [x] `guest_events` retargeted to new `guests.id`
- [x] `sessions` retargeted to `family_id`
- [x] First D1 migration `0001_initial.sql` + `meta/_journal.json`

### Generation service (apps/api) ✓ this PR

- [x] `generatePublicId(familyName)` → `SURNAME-WORD-HASH` (Crockford Base32 hash, no I/L/O/U)
- [x] `generatePassword()` → 4-word lowercase passphrase (`amber-cedar-violin-ridge`)
- [x] `hashPassword` / `verifyPassword` via PBKDF2-SHA256 / WebCrypto, encoded as `pbkdf2$sha256$<iter>$<salt>$<hash>`
- [x] Curated wordlists: 64 three-letter words for IDs, 256 4–7 letter words for passphrases (~32 bits entropy; expand to ≥1024 from EFF short list for ≥40 bits before launch)
- [x] Constant-time hash comparison; constant-time equal-length check guarded by length prefix
- [x] Dummy hash on lookup miss derived at module load from `PBKDF2_ITERATIONS` so format never desyncs from real hashes

### Spreadsheet ingestion (apps/api)

- [ ] `services/spreadsheet.ts` — `parseTsv` / `parseCsv` / `parseXlsx`; reject formula-injection cells (cells starting with `=`, `+`, `-`, `@`)
- [ ] `services/import.ts` — `diffAgainstDb(parsed)` returns `ImportPlan` (creates / updates / removes per family + per guest); `applyImport(plan)` executes in batched D1 transactions
- [ ] `schemas/import.ts` — Effect Schema for the parsed row shape and the import response
- [ ] Plan should preserve generated `publicId` + password for existing families; only assign new ones to brand-new families
- [ ] Per-guest event invitations from boolean columns drive `guestEvents` rows

### Organiser portal (apps/web + apps/api)

- [ ] Organiser auth model (passkey + magic link, separate `organisers` table)
- [ ] Auth middleware that rejects guest sessions on organiser endpoints
- [ ] `/organiser/import` page — paste / upload, preview diff table, confirm
- [ ] Extend `OrganiserView` to display family-grouped guests with shareable publicId + password (show password only at family creation, hash thereafter — surface a "regenerate password" action)

### Cloudflare wiring

- [x] `migrations_dir = "../../packages/db/migrations"` added to `wrangler.toml`
- [ ] Replace `bun:sqlite` runtime in `apps/api/src/index.ts` with `drizzle(env.DB)` on D1
- [ ] `bunx wrangler d1 migrations apply cire-db --local` in dev script
- [ ] `bunx wrangler types` after binding changes
- [ ] Batch import respects 50ms CPU / 30s wall-time Worker limits — chunk inserts to ~100 rows; consider Durable Objects or Queues for guest lists ≥ ~500 families

---

## apps/web

### Done

- [x] Astro + SolidJS project init
- [x] View Transitions setup (page-level)
- [x] Motion One integration (`@motionone/solid`)
- [x] Mobile-first scrollable page structure
- [x] Hero section (photo placeholder + monogram overlay)
- [x] Our Story section
- [x] Guest login section (claim code entry, refactored from ClaimFlow)
- [x] Conditional event sections (shown after auth, per invited events)
- [x] Event cards with time, place, and RSVP button
- [x] RSVP response modal (stub — invite group members + attendance + dietary)
- [x] Dress code section (colour palette + Pinterest embed placeholder)
- [x] Tailwind v4 migration — all CSS converted to utility classes, global.css with @theme tokens
- [x] Unlock reveal animation — login form fades out, welcome fades in, events slide up with staggered cards
- [x] Animated modal enter/exit — backdrop fade + panel slide-up/scale with Motion One

### To Do

- [ ] Rework `LoginSection` for two inputs (publicId + password) and update `types.ts` / `utils.ts` to consume the new claim response shape
- [ ] Rework `OrganiserView` to consume the new `OrganiserGuestRow` shape (publicId / firstName / lastName instead of `name` + `code` + `claimed`)
- [ ] Reconsider `parseMembers` — now redundant given `members` array in claim response
- [ ] Replace hero photo placeholder with actual photo
- [ ] Customise monogram with couple's initials
- [ ] Write Our Story content
- [ ] Populate dress code colour palette swatches
- [ ] Embed actual Pinterest board URLs
- [ ] Wire RSVP modal to API (pending invite group backend)
- [ ] Show family members in RSVP modal from claim response
- [ ] Per-person attendance toggle + dietary input in modal
- [ ] "Open in Maps" button on event cards (Apple Maps / Google Maps)
- [ ] Add-to-calendar links (Google Calendar, Apple Calendar, .ics)
- [ ] Passkey registration + login UI
- [ ] Magic link email fallback UI

---

## apps/api

- [x] Hono app scaffold with Cloudflare Workers wrangler config
- [x] Effect Schema validation on request bodies
- [x] `POST /api/claim` — validate (publicId, password), return family + members + events
- [x] `GET /api/organiser/guests` — return one row per guest with family publicId, names, events
- [x] Family ID + password generation service (PBKDF2 + WebCrypto)
- [ ] Spreadsheet parser + diff service + import endpoints (see Organiser Spreadsheet Import above)
- [ ] Organiser auth middleware
- [ ] `POST /api/rsvp` — per-person per-event RSVP with dietary requirements
- [ ] `GET /api/events` — list events for the wedding
- [ ] Drizzle D1 client wired in `src/index.ts` (currently 503 stub)
- [ ] Auth middleware — validate passkey session or magic link token
- [ ] Passkey (WebAuthn) registration + authentication endpoints
- [ ] Magic link email dispatch (Resend)
- [ ] Admin endpoints — view RSVPs, regenerate passwords, deactivate families

---

## packages/db

- [x] Drizzle schema: `families`, `guests`, `events`, `guestEvents`, `rsvps`, `sessions`
- [x] First D1 migration (`0001_initial.sql`)
- [x] `drizzle.config.ts` for future migration generation
- [ ] Add `organisers` + `organiser_sessions` tables once auth lands
- [ ] Add `dietary_requirements` column to rsvps (or separate table for per-event dietary)
- [ ] Seed script for local development that exercises real `generatePublicId` / `generatePassword` (currently uses fixed JSON fixtures so tests stay deterministic)

---

## Security Backlog

**Critical**

- [ ] `GET /api/organiser/guests` is currently unauthenticated and exposes every family's `publicId` — must be gated behind organiser auth (or removed from the deployed app) before any public launch. With ~32-bit passphrase entropy this halves the credential.
- [ ] Rate-limit `POST /api/claim` (Turnstile / Cloudflare rate-limit binding / KV-backed limiter) — without it, the timing-flat dummy hash on miss also acts as a free PBKDF2 DoS amplifier.

**High**

- [x] Family `publicId` must be cryptographically random — never sequential or derivable from family_name alone (the SURNAME prefix is enumerable; entropy lives in the word + Crockford hash)
- [x] Family password must be hashed with a Workers-compatible KDF (PBKDF2-SHA256 via WebCrypto, 100k iter)
- [x] Constant-time hash comparison on verify (`verifyPassword`); dummy hash on lookup miss to avoid timing-based family enumeration (`claimService.lookup`, derived from `PBKDF2_ITERATIONS` at module load)
- [ ] Organiser import endpoints must require organiser session — never guest session
- [ ] Spreadsheet parser must reject formula-injection cells (leading `=`, `+`, `-`, `@`)
- [ ] Magic link tokens must be single-use and expire (≤15 min)

**Medium**

- [ ] RSVP endpoint must verify the session owns the family the guest belongs to
- [ ] Invite token in URL (if any) must be opaque (UUID/random) — not a guest or family id
- [ ] On password regeneration, invalidate existing sessions for that family

**Low**

- [ ] Review Cloudflare Worker CSP headers on the web app
- [ ] Confirm all D1 queries go through Drizzle (no raw SQL interpolation anywhere)
- [ ] Expand passphrase wordlist to ≥1024 entries for ≥40 bits of entropy

---

## Performance Backlog

- [x] `claimService.lookup` collapsed from 4 D1 queries (incl. unbounded `guest_events` scan) to 2 via a single filtered join
- [x] `claimService.getAllGuests` collapsed from 3 full-table fetches + in-memory join to one DB-side join
- [x] `guest_events.event_id` index added for reverse lookups
- [ ] PBKDF2 100k iterations + dummy-hash-on-miss is ~20-40ms per request on Workers. Pairs with rate limiting (above) before public launch — once that's in place, consider lowering iterations to 25-50k for a wedding-scale threat model.
- [ ] `getAllGuests` paginate / cursor once organiser UI is built — current single-join is fine at 100 guests, problematic past a few thousand
- [ ] Landing page animations must not block LCP — defer Motion One until after first paint
- [ ] Hero photo must be optimised (WebP/AVIF, responsive srcset)
- [ ] Add-to-calendar data should not require a round-trip if event data is already hydrated in the page
- [ ] .ics generation can be client-side to avoid unnecessary Worker invocation
- [ ] Spreadsheet import on Workers: chunk inserts (≤100 rows per batch) to stay under 50ms CPU per request; offload large diffs to a Queue-driven worker

---

## Deferred Decisions

| Question                                  | Options considered                                                                                        | Deadline / trigger                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Event invitations per-family vs per-guest | Per-guest matches sheet exactly (current schema); per-family simpler but loses fidelity                   | After first import lands and real spreadsheet variation is observed |
| Spreadsheet input format                  | TSV paste only / CSV / .xlsx via SheetJS                                                                  | Before upload UI is built                                           |
| Organiser auth model                      | Reuse passkey infra with role flag vs. separate `organisers` table                                        | Before `/api/organiser/import` is hardened                          |
| Surname collision handling in publicId    | Accept multiple `PATEL-*-*` IDs (different word/hash disambiguates) vs. enforce uniqueness on family_name | Stay on current accept-multiple unless aesthetic problem reported   |
| Per-event dietary storage                 | Column on rsvps vs. separate table                                                                        | Before RSVP endpoint                                                |
| Pinterest embed approach                  | oEmbed API vs. iframe vs. static images                                                                   | Before dress code section is wired up                               |
| Platformise Cire                          | Multi-tenant SaaS vs stay bespoke                                                                         | After friend's wedding ships                                        |
| SMS OTP fallback                          | Twilio/similar vs email-only                                                                              | If magic link proves insufficient                                   |
| Seating planner                           | D1 table arrangement feature                                                                              | Post-MVP                                                            |
| Photo collections                         | Cloudflare R2 + upload UI                                                                                 | Post-MVP                                                            |
| Wishing well                              | Payment processing (requires ABN)                                                                         | After business is set up                                            |
| Guest photo sharing                       | R2 + moderation                                                                                           | Post-MVP                                                            |
| iPhone AirDrop sharing                    | Web Share API + custom payload                                                                            | After core invite is built                                          |

---

## Future

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
