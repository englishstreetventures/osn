---
title: "Cire TODO — apps/api"
tags: [todo, api]
related:
  - "[[index]]"
last-reviewed: 2026-05-05
---

# apps/api

Backend feature work. The Hono + Effect + Drizzle layer in `apps/api`.

- [x] Surface `guestId` on every claim member + extended event metadata (PR-A)
- [x] Session-cookie auth on `/api/rsvp`; `/api/claim` mints `cire_session` (PR-B)
- [ ] Set `Domain=` on session cookie when production root domain lands; today host-scoped works for same-origin dev.
- [ ] Cron-triggered `DELETE FROM sessions WHERE expires_at < now` — without this the sessions table grows unbounded as tokens expire but rows remain. Cloudflare cron trigger or a sweep on each `createSession`.
- [x] Spreadsheet parser + diff service + import endpoints (PR-C — see [[spreadsheet-import]] for the dedicated breakdown)
- [ ] Organiser auth middleware (currently shared-secret `X-Organiser-Token`; passkey auth is the follow-up)
- [x] **Revert capability for applied imports** — `POST /api/organiser/import/revert` re-fetches the prior `applied` import's CSVs from R2, re-parses, re-diffs, re-applies, and marks the current row `reverted` (PR-C)
- [x] `POST /api/rsvp` — per-person per-event RSVP with dietary requirements (gated behind `sessionAuth` cookie middleware as of PR-B)
- [ ] `GET /api/events` — list events for the wedding
- [ ] Drizzle D1 client wired in `src/index.ts` (currently 503 stub)
- [ ] Auth middleware — validate passkey session or magic link token
- [ ] Passkey (WebAuthn) registration + authentication endpoints
- [ ] Magic link email dispatch (Resend)
- [ ] Admin endpoints — view RSVPs, regenerate passwords, deactivate families
