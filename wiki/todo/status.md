---
title: "Cire TODO — status + up next"
tags: [todo, status]
related:
  - "[[index]]"
last-reviewed: 2026-05-05
---

# Status + Up Next

The single high-churn shard. Update **Current Status** when a major slice lands; tick / append to **Up Next** as priorities shift. All other tracking lives in sibling shards under `wiki/todo/`.

## Current Status

Monorepo built and functional. `packages/db` models families with a shareable `publicId` (e.g. `PATEL-JOY-RK97`) and per-family guests; `apps/api` exposes `POST /api/claim` (publicId-only lookup, mints a session), `POST /api/rsvp` (session-cookie gated, per-person per-event with dietary), `GET /api/organiser/guests`, plus rate-limit middleware on `/api/claim`. Organiser portal split into its own Astro app (`apps/organiser`) with `GuestTable` consuming the new shape. **PR-A** landed events metadata + `imports` table + `guests.externalId`. **PR-B** landed session-cookie auth: a 256-bit `cire_session` token is minted on successful claim and set as `HttpOnly; SameSite=Lax; Path=/` (no `Domain=` — host-scoped); `/api/rsvp` is behind a `sessionAuth` middleware that derives `familyId` from the session, dropping `familyPublicId` from the body; CORS now echoes the configured origin with `credentials: true`. **PR-C** is now in: hand-rolled RFC 4180 CSV parser with formula-injection guards, an Effect-based diff service that reconciles parsed sheets against the live DB (creates / updates / removes per family + per guest + per event-link, plus state-loss warnings for guests with non-default RSVPs), R2-versioned uploads keyed at `imports/<importId>/{events,guests}.csv`, and a `revertImport` path that re-applies a previous snapshot. Routes under `/api/organiser/import/{preview,apply,revert,list}` are gated behind a shared-secret `X-Organiser-Token` header (interim until passkey auth lands). Backend is Effect-based with Effect Schema validation; tests co-located `*.test.ts` under `bun test` (120 api, 48 web). Migrations: `0001_initial.sql`, `0002_add_rsvp_dietary.sql`, `0003_events_metadata_and_imports.sql`, `0004_perf_indices.sql`. Next slice: organiser portal upload UI + migrate from shared-secret to organiser passkey auth, plus wiring the guest-app RSVP modal (PR-F) to the live endpoint.

---

## Up Next

- [ ] Rebase the dependent feature branches onto current main
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
- [x] Wire guest-app RSVP modal to `POST /api/rsvp` (PR-F)
- [ ] Add-to-calendar links on event cards (Google / Apple / .ics) (PR-G)
