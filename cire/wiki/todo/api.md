---
title: "Cire TODO — cire/api"
tags: [todo, api]
related:
  - "[[index]]"
last-reviewed: 2026-06-10
---

# cire/api

Backend feature work. The Hono + Effect + Drizzle layer in `cire/api`.

- [x] Surface `guestId` on every claim member + extended event metadata (PR-A)
- [x] Session-cookie auth on `/api/rsvp`; `/api/claim` mints `cire_session` (PR-B)
- [ ] Set `Domain=` on session cookie when production root domain lands; today host-scoped works for same-origin dev.
- [ ] Cron-triggered `DELETE FROM sessions WHERE expires_at < now` — without this the sessions table grows unbounded as tokens expire but rows remain. Cloudflare cron trigger or a sweep on each `createSession`.
- [x] Spreadsheet parser + diff service + import endpoints (PR-C — see [[spreadsheet-import]] for the dedicated breakdown)
- [x] Organiser auth middleware — OSN-merge: `osnAuth()` (via `@shared/osn-auth-client`) verifies OSN passkey-issued access JWTs on `/api/organiser/*`; `weddingOwner()` / `ownedWedding()` enforce wedding ownership; the interim shared-secret `X-Organiser-Token` is deleted. See `[[wiki/systems/cire-auth]]` in the root OSN wiki.
- [ ] **`diffAgainstDb` wedding-scoping — MUST land before any second wedding exists.** `services/import.ts` reads events/families/guests/links UNSCOPED by `wedding_id`; import *writes* are scoped, but the diff would cross-contaminate with a second wedding's rows. Needs join-based scoping — a naive per-table `WHERE wedding_id = ?` would mis-detect the other wedding's guest-event links as removals. Also tracked in root `wiki/TODO.md` Cire section.
- [x] **Revert capability for applied imports** — `POST /api/organiser/import/revert` re-fetches the prior `applied` import's CSVs from R2, re-parses, re-diffs, re-applies, and marks the current row `reverted` (PR-C)
- [x] `POST /api/rsvp` — per-person per-event RSVP with dietary requirements (gated behind `sessionAuth` cookie middleware as of PR-B)
- [ ] `GET /api/events` — list events for the wedding
- [ ] Drizzle D1 client wired in `src/index.ts` (currently 503 stub)
- [x] ~~Auth middleware — validate passkey session or magic link token~~ — **Obsolete**: superseded by the two-system model (guest `sessionAuth` cookie + organiser `osnAuth` JWT); no cire-local passkey/magic-link layer
- [x] ~~Passkey (WebAuthn) registration + authentication endpoints~~ — **Obsolete**: organisers reuse OSN's passkey infra (`@osn/api` issuer); cire ships no WebAuthn endpoints of its own
- [x] ~~Magic link email dispatch (Resend)~~ — **Obsolete**: no magic-link factor in the two-system model
- [ ] Admin endpoints — view RSVPs, regenerate passwords, deactivate families
