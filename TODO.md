# Cire TODO

Progress tracking and deferred decisions. For full spec see README.md. For code patterns see CLAUDE.md.

## Current Status

Monorepo built and functional. `packages/db` has Drizzle schema (guests, events, guestEvents, rsvps, sessions). `apps/api` has Hono + Effect service layer with Effect Schema validation, a claim code route backed by bun:sqlite in-memory DB seeded from JSON, an organiser dashboard route, and 11 passing Vitest tests. `apps/web` has Astro + SolidJS with a mobile-first scrollable invite page — hero (photo + monogram), our story, guest login, conditional event sections, RSVP modal stub, and dress code section. All CSS migrated to Tailwind v4 with `@tailwindcss/vite` plugin. Motion One animations added: unlock reveal sequence (login → welcome → staggered events), animated modal enter/exit for RSVP and Details modals. Local dev runs via `bun run dev`. No auth yet — D1, passkeys, invite groups, and full RSVP are next.

---

## Up Next

- [ ] Invite groups — schema + API: shared claim code for multiple people (couple, family)
- [ ] Per-person per-event RSVP with dietary requirements
- [ ] Update seed data: mehndi, sangeet, wedding (replace reception with sangeet)
- [ ] Passkey (WebAuthn) registration + authentication endpoints
- [ ] Auth middleware — validate passkey session token
- [ ] Wire RSVP modal to `POST /api/rsvp` endpoint
- [ ] Rate-limit claim code attempts
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
- [ ] Replace hero photo placeholder with actual photo
- [ ] Customise monogram with couple's initials
- [ ] Write Our Story content
- [ ] Populate dress code colour palette swatches
- [ ] Embed actual Pinterest board URLs
- [ ] Wire RSVP modal to API (pending invite group backend)
- [ ] Show invite group members in RSVP modal (pending backend)
- [ ] Per-person attendance toggle + dietary input in modal
- [ ] "Open in Maps" button on event cards (Apple Maps / Google Maps)
- [ ] Add-to-calendar links (Google Calendar, Apple Calendar, .ics)
- [ ] Passkey registration + login UI
- [ ] Magic link email fallback UI

---

## apps/api

- [x] Hono app scaffold with Cloudflare Workers wrangler config
- [x] Effect Schema validation on request bodies
- [x] `POST /api/claim` — validate claim code, return guest + event data
- [x] `GET /api/organiser/guests` — return guest list with RSVP status
- [ ] Invite groups table + API (claim code → group → members)
- [ ] Update seed data: mehndi / sangeet / wedding events, invite groups with per-person event assignments
- [ ] `POST /api/rsvp` — per-person per-event RSVP with dietary requirements
- [ ] `GET /api/events` — list events for the wedding
- [ ] Drizzle D1 client setup + first migration
- [ ] Auth middleware — validate passkey session or magic link token
- [ ] Passkey (WebAuthn) registration + authentication endpoints
- [ ] Magic link email dispatch (Resend)
- [ ] Admin endpoints — create guests, generate claim codes, view RSVPs

---

## packages/db

- [x] Drizzle schema: `guests`, `events`, `guestEvents`, `rsvps`, `sessions`
- [ ] Add `invite_groups` table (id, claim_code, name)
- [ ] Add `invite_group_members` table (group_id, guest_id)
- [ ] Add `dietary_requirements` column to rsvps (or separate table for per-event dietary)
- [ ] First D1 migration
- [ ] Seed script for local development

---

## Security Backlog

**High**
- [ ] Claim codes must be cryptographically random — never sequential or predictable
- [ ] Guests must not be able to enumerate other guests or claim codes
- [ ] Passkey credential binding scoped to the guest's own record only
- [ ] Magic link tokens must be single-use and expire (≤15 min)
- [ ] Admin endpoints require separate elevated auth — guest sessions must not suffice
- [ ] Rate-limit claim code attempts to prevent brute force

**Medium**
- [ ] RSVP endpoint must verify the session owns the guest record being updated
- [ ] Invite token in URL must be opaque (UUID/random) — not a guest ID

**Low**
- [ ] Review Cloudflare Worker CSP headers on the web app
- [ ] Confirm all D1 queries go through Drizzle (no raw SQL interpolation anywhere)

---

## Performance Backlog

- [ ] Landing page animations must not block LCP — defer Motion One until after first paint
- [ ] Hero photo must be optimised (WebP/AVIF, responsive srcset)
- [ ] Add-to-calendar data should not require a round-trip if event data is already hydrated in the page
- [ ] .ics generation can be client-side to avoid unnecessary Worker invocation

---

## Deferred Decisions

| Question | Options considered | Deadline / trigger |
|---|---|---|
| Invite group schema | Separate table vs. group_id on guests | Before RSVP endpoint |
| Per-event dietary storage | Column on rsvps vs. separate table | Before RSVP endpoint |
| Pinterest embed approach | oEmbed API vs. iframe vs. static images | Before dress code section is wired up |
| Platformise Cire | Multi-tenant SaaS vs stay bespoke | After friend's wedding ships |
| SMS OTP fallback | Twilio/similar vs email-only | If magic link proves insufficient |
| Seating planner | D1 table arrangement feature | Post-MVP |
| Photo collections | Cloudflare R2 + upload UI | Post-MVP |
| Wishing well | Payment processing (requires ABN) | After business is set up |
| Guest photo sharing | R2 + moderation | Post-MVP |
| iPhone AirDrop sharing | Web Share API + custom payload | After core invite is built |

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
