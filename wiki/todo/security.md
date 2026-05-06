---
title: "Cire TODO — security backlog"
tags: [todo, security]
related:
  - "[[index]]"
  - "[[overview]]"
  - "[[review-findings]]"
last-reviewed: 2026-05-05
---

# Security Backlog

See [[overview]] for observability rules that apply to all security-sensitive code paths. See [[review-findings]] for severity prefix conventions.

## Critical

- [ ] `GET /api/organiser/guests` is currently unauthenticated and exposes every family's `publicId` — must be gated behind organiser auth (or removed from the deployed app) before any public launch.
- [x] Rate-limit `POST /api/claim` — KV-backed limiter via `apps/api/src/middleware/rate-limit.ts`

## High

- [ ] Organiser import endpoints must require organiser session — never guest session (currently gated behind shared-secret `X-Organiser-Token` as MVP interim — PR-C)
- [x] Spreadsheet parser must reject formula-injection cells (leading `=`, `+`, `-`, `@`) (PR-C; trim-resilient as of PR-C review)
- [x] X-Organiser-Token compared in constant time (PR-C review)
- [x] Formula-injection guard checks trimmed cell, not raw cell (PR-C review)
- [ ] Magic link tokens must be single-use and expire (≤15 min)

## Medium

- [x] RSVP endpoint must verify the session owns the family the guest belongs to (PR-B: `sessionAuth` middleware sets `familyId` from cookie; route validates each `guestId` belongs to that family)
- [ ] Invite token in URL (if any) must be opaque (UUID/random) — not a guest or family id
- [ ] On password regeneration, invalidate existing sessions for that family
- [x] `decodePalette` emits a structured warning (no PII) on malformed JSON or shape mismatch so corrupted rows don't fail silently (PR-A review)
- [x] Session tokens hashed at rest — `sessions.token` stores SHA-256 hex of the raw token; cookie still carries the raw value (PR-B review)
- [x] `/preview` rejects > 1MB body via Content-Length pre-check (PR-C review)
- [x] CSV parser enforces ≤5000 rows + ≤10_000 chars/cell + rejects unterminated-quote at EOF (PR-C review)

## Low

- [ ] Review Cloudflare Worker CSP headers on the web app
- [ ] Confirm all D1 queries go through Drizzle (no raw SQL interpolation anywhere)
- [ ] Expand passphrase wordlist to ≥1024 entries for ≥40 bits of entropy
- [ ] CI guard: fail deploy if `apps/api/wrangler.toml` still has the literal `database_id = "placeholder-replace-after-d1-create"` (PR-A review)
- [ ] Frontend `href` validator — Pinterest URLs go through an allowlist regex (`apps/web/src/components/pinterest.ts`) (PR-D); Google Calendar URL is parsed via the `URL` constructor + `http(s)`-only protocol check before being surfaced (PR-G — see `isHttpUrl` in `apps/web/src/components/AddToCalendar.tsx`); `mapsUrl` / `address` validators still pending
- [x] CSS colour validator — `dressCodePalette[].color` is server-supplied and rendered inline as `background-color`. `apps/web/src/components/dress-code-render.ts#isValidColor` allowlists hex / rgb[a] / hsl[a] / oklch and rejects `expression(...)` etc. (PR-E)
- [ ] Whitelist 422 `MalformedSpreadsheet` reason strings — currently safe (only static literals are surfaced) but document the constraint so future contributors don't interpolate cell contents into the `reason` field (PR-C review)
- [ ] CSP headers on `apps/web` — add `frame-src https://*.pinterest.com https://assets.pinterest.com` (and the rest of a baseline policy) once a Cloudflare Pages `_headers` file or Workers transform is set up. PR-D leaves the iframe unrestricted at the page level because no CSP exists yet.
- [ ] Static-image + outbound-link Pinterest fallback (post-launch upgrade) — replace iframe with a snapshot board image (R2 + Workers fetch) once Pinterest's X-Frame-Options or `embed` reliability becomes a problem (PR-D)
