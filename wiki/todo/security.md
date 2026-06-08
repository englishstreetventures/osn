---
title: "Cire TODO — security backlog"
tags: [todo, security]
related:
  - "[[index]]"
  - "[[overview]]"
  - "[[review-findings]]"
last-reviewed: 2026-06-08
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
- [x] `bun audit --audit-level=high` enforced on every push (lefthook pre-push)
- [x] Upgrade Astro 5 → 6 + Vitest 3 → 4 + @astrojs/solid-js 3 → 6; clears `GHSA-737v-mqg7-c878` (defu) directly; root `overrides` pin `vite ^7.3.2` and `picomatch ^4.0.4` to clear `GHSA-v2wj-q39q-566r` + `GHSA-p9ff-h696-f583` (vite) + `GHSA-c2c7-rcm5-vvqj` (picomatch)
- [ ] Re-run `bun install` once devalue 5.8.1+ ages past `minimumReleaseAge` (3 days) and drop the last `--ignore=GHSA-77vg-94rm-hx3p` from `lefthook.yml`
- [x] Bump hono to `^4.12.18` — closed cookie name validation, JSX HTML injection, serveStatic slash bypass, IPv4-mapped IPv6 in `ipRestriction()` (PR #25)
- [ ] Bump transitive `smol-toml ^1.6.1+`, `postcss ^8.5.10+`, `esbuild >0.24.2` once their upstream dependents allow it — 3 remaining transitive `moderate` advisories. None affect production paths today (smol-toml is via wrangler, postcss via tailwind/vite, esbuild dev-server only) but worth tracking.
- [ ] Revisit `overrides.vite` in root `package.json` when Astro publishes Vite 8 support — current `^7.3.2` pin would force-downgrade an Astro-with-Vite-8 install (see PR #25 perf review)
- [x] Bump drizzle-orm to ^0.45.2 to clear `GHSA-gpj5-g38j-94v9` (SQL injection via improperly escaped identifiers) — was `^0.41.0`

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
- [ ] CSP headers on `apps/web` — once a Cloudflare Pages `_headers` file or Workers transform is set up, allow `script-src https://assets.pinterest.com` (the script-widget loads `pinit_main.js` from there) and `connect-src https://widgets.pinterest.com` (pidgets data fetch) and `img-src https://i.pinimg.com` (pin thumbnails); `frame-src` is no longer needed since PR #28 dropped the iframe.
- [x] Outbound-link Pinterest fallback when the embed can't render — PR #28 ships a "View moodboard on Pinterest" link button that takes over after a 2.5s grace window if `pinit_main.js` is blocked (uBlock / Brave Shields / Privacy Badger fire `blocked:other` on EasyPrivacy filters) or fails to transform our `<a data-pin-do>` placeholder. Static-image / R2 snapshot path remains a future upgrade if blocker-fallback rates grow uncomfortable.
