# Cire TODO

Progress tracking and deferred decisions. For full spec see README.md. For code patterns see CLAUDE.md.

## Current Status

Monorepo built and functional. `packages/db` has Drizzle schema (guests, events, guestEvents, rsvps, sessions). `apps/api` has Hono + Effect service layer with Effect Schema validation, a claim code route backed by bun:sqlite in-memory DB seeded from JSON, an organiser dashboard route, and 11 passing Vitest tests. `apps/web` has Astro + SolidJS with a forest-green landing page, wax seal SVG, guest code entry → View Transition morph → personalised invite view with event cards, and an organiser dashboard. Local dev runs via `bun run dev`. No auth yet — D1, passkeys, and RSVP are next.

---

## Up Next

- [ ] Tailwind v4 — migrate from plain CSS (`@tailwindcss/vite`, CSS-first config)
- [ ] "Open in Maps" button on event cards (Apple Maps / Google Maps, user-choosable)
- [ ] Add-to-calendar links on event cards (Google Calendar, Apple Calendar, .ics)
- [ ] Passkey (WebAuthn) registration + authentication endpoints
- [ ] Auth middleware — validate passkey session token
- [ ] RSVP route: `POST /api/rsvp` — accept/decline per event
- [ ] Rate-limit claim code attempts

---

## apps/web

- [x] Astro + SolidJS project init
- [x] View Transitions setup (page-level)
- [x] Motion One integration (`@motionone/solid`)
- [x] Skeleton landing page + claim code entry flow
- [x] Personalised invite view (guest name, events)
- [ ] Tailwind v4 migration
- [ ] "Open in Maps" button on event cards
- [ ] Add-to-calendar (Google, Apple, .ics download)
- [ ] RSVP form per event
- [ ] Passkey registration + login UI
- [ ] Magic link email fallback UI
- [ ] Refactor for final design (after receiving brief from friend)

---

## apps/api

- [x] Hono app scaffold with Cloudflare Workers wrangler config
- [x] Effect Schema validation on request bodies
- [x] `POST /api/claim` — validate claim code, return guest + event data
- [x] `GET /api/organiser/guests` — return guest list with RSVP status
- [ ] Drizzle D1 client setup + first migration
- [ ] `POST /rsvp` — submit RSVP for one or more events
- [ ] `GET /events` — list events for the wedding
- [ ] Auth middleware — validate passkey session or magic link token
- [ ] Passkey (WebAuthn) registration + authentication endpoints
- [ ] Magic link email dispatch (Resend)
- [ ] Admin endpoints — create guests, generate claim codes, view RSVPs

---

## packages/db

- [x] Drizzle schema: `guests`, `events`, `guestEvents`, `rsvps`, `sessions`
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
- [ ] Add-to-calendar data should not require a round-trip if event data is already hydrated in the page
- [ ] .ics generation can be client-side to avoid unnecessary Worker invocation

---

## Deferred Decisions

| Question | Options considered | Deadline / trigger |
|---|---|---|
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
