---
title: "Cire TODO — security backlog"
tags: [todo, security]
related:
  - "[[index]]"
  - "[[overview]]"
  - "[[review-findings]]"
last-reviewed: 2026-06-16
---

# Security Backlog

See [[overview]] for observability rules that apply to all security-sensitive code paths. See [[review-findings]] for severity prefix conventions.

## Critical

- [x] `GET /api/organiser/guests` is currently unauthenticated and exposes every family's `publicId` — must be gated behind organiser auth (or removed from the deployed app) before any public launch. **Fixed** in the OSN merge: all `/api/organiser/*` routes sit behind `osnAuth()` (OSN access-JWT verification) plus `weddingOwner()` / `ownedWedding()` ownership gates — see `[[wiki/systems/cire-auth]]` in the root OSN wiki.
- [x] Rate-limit `POST /api/claim` — KV-backed limiter via `cire/api/src/middleware/rate-limit.ts`

## High

- [x] Organiser import endpoints must require organiser session — never guest session. **Fixed** in the OSN merge: import routes require `osnAuth()` + `ownedWedding()`; a guest `cire_session` cookie is meaningless there (the two middlewares never gate the same route). The interim `X-Organiser-Token` shared secret is deleted.
- [x] Spreadsheet parser must reject formula-injection cells (leading `=`, `+`, `-`, `@`) (PR-C; trim-resilient as of PR-C review)
- [x] X-Organiser-Token compared in constant time (PR-C review; the token path itself was deleted in the OSN merge)
- [x] Formula-injection guard checks trimmed cell, not raw cell (PR-C review)
- [x] ~~Magic link tokens must be single-use and expire (≤15 min)~~ — **Obsolete**: no magic-link factor in the two-system auth model (guests use claim codes; organisers use OSN passkeys)
- [x] `bun audit --audit-level=high` enforced on every push (lefthook pre-push)
- [x] Upgrade Astro 5 → 6 + Vitest 3 → 4 + @astrojs/solid-js 3 → 6; clears `GHSA-737v-mqg7-c878` (defu) directly; root `overrides` pin `vite ^7.3.2` and `picomatch ^4.0.4` to clear `GHSA-v2wj-q39q-566r` + `GHSA-p9ff-h696-f583` (vite) + `GHSA-c2c7-rcm5-vvqj` (picomatch)
- [ ] Re-run `bun install` once devalue 5.8.1+ ages past `minimumReleaseAge` (3 days) and drop the last `--ignore=GHSA-77vg-94rm-hx3p` from `lefthook.yml`
- [x] Bump hono to `^4.12.18` — closed cookie name validation, JSX HTML injection, serveStatic slash bypass, IPv4-mapped IPv6 in `ipRestriction()` (PR #25)
- [ ] Bump transitive `smol-toml ^1.6.1+`, `postcss ^8.5.10+`, `esbuild >0.24.2` once their upstream dependents allow it — 3 remaining transitive `moderate` advisories. None affect production paths today (smol-toml is via wrangler, postcss via tailwind/vite, esbuild dev-server only) but worth tracking.
- [ ] Drop `--ignore=GHSA-gv7w-rqvm-qjhr` from `lefthook.yml` once astro / drizzle-kit / vite / wrangler ship esbuild ≥0.28.1. Advisory is the esbuild Deno-module binary-integrity RCE via `NPM_CONFIG_REGISTRY` — reachable only through build/dev tooling (esbuild never runs in any Worker/production path), so suppressed in the pre-push audit gate pending upstream bumps.
- [ ] Revisit `overrides.vite` in root `package.json` when Astro publishes Vite 8 support — current `^7.3.2` pin would force-downgrade an Astro-with-Vite-8 install (see PR #25 perf review)
- [x] Bump drizzle-orm to ^0.45.2 to clear `GHSA-gpj5-g38j-94v9` (SQL injection via improperly escaped identifiers) — was `^0.41.0`

## Medium

- [x] **S-M1** — Workers entry (`src/index.ts`) must fail closed if required bindings/vars are missing, not just `DB`. Without the guard, an unset `OSN_JWKS_URL` / `OSN_AUDIENCE` let `createApp` fall back to its localhost dev defaults for the OSN issuer/audience in production (fails closed against localhost, so hardening not a live bypass). Now validates `DB`, `WEB_ORIGIN`, `OSN_JWKS_URL`, `OSN_AUDIENCE` and returns 503 if any are missing. (D1 wiring branch review)
- [x] RSVP endpoint must verify the session owns the family the guest belongs to (PR-B: `sessionAuth` middleware sets `familyId` from cookie; route validates each `guestId` belongs to that family)
- [ ] Invite token in URL (if any) must be opaque (UUID/random) — not a guest or family id
- [ ] On password regeneration, invalidate existing sessions for that family
- [x] `decodePalette` emits a structured warning (no PII) on malformed JSON or shape mismatch so corrupted rows don't fail silently (PR-A review)
- [x] Session tokens hashed at rest — `sessions.token` stores SHA-256 hex of the raw token; cookie still carries the raw value (PR-B review)
- [x] `/preview` rejects > 1MB body via Content-Length pre-check (PR-C review)
- [x] CSV parser enforces ≤5000 rows + ≤10_000 chars/cell + rejects unterminated-quote at EOF (PR-C review)

- [x] **S-L1** — `applyImport` partial-state risk on D1 (no interactive transaction). Resolved by P-C1: the write set now commits as a single atomic `db.batch([...])` on D1, so a mid-sequence failure rolls back the whole import. Atomicity covered by `src/db/d1-integration.test.ts`. (D1 wiring branch review)

## Low

- [ ] Verify `ORGANISER_TOKEN` is not set as a CF secret on the deployed cire-api worker — the `X-Organiser-Token` code path is deleted, but a secret set during the interim would linger as stale config. If present: `wrangler secret delete ORGANISER_TOKEN` (manual, from `cire/api`).
- [ ] Review Cloudflare Worker CSP headers on the web app
- [ ] Confirm all D1 queries go through Drizzle (no raw SQL interpolation anywhere)
- [ ] Expand passphrase wordlist to ≥1024 entries for ≥40 bits of entropy
- [ ] CI guard: fail deploy if `cire/api/wrangler.toml` still has the literal `database_id = "placeholder-replace-after-d1-create"` (PR-A review)
- [x] Frontend `href` validator — Pinterest URLs go through an allowlist regex (`cire/web/src/components/pinterest.ts`) (PR-D); Google Calendar URL is parsed via the `URL` constructor + `http(s)`-only protocol check before being surfaced (PR-G — see `isHttpUrl` in `cire/web/src/components/AddToCalendar.tsx`). Organiser `mapsUrl` / `pinterestUrl` now scheme-checked twice: CSV import rejects non-http(s) values with `MalformedSpreadsheet` (`parseHttpUrl` in `spreadsheet.ts`), and `claim.ts` strips bad legacy rows via `safeHttpUrl` before any surface — guest path included. `address` is plain text, not rendered as `href`.
- [x] CSS colour validator — `dressCodePalette[].color` is server-supplied and rendered inline as `background-color`. `cire/web/src/components/dress-code-render.ts#isValidColor` allowlists hex / rgb[a] / hsl[a] / oklch and rejects `expression(...)` etc. (PR-E)
- [ ] Whitelist 422 `MalformedSpreadsheet` reason strings — currently safe (only static literals are surfaced) but document the constraint so future contributors don't interpolate cell contents into the `reason` field (PR-C review)
- [ ] CSP headers on `cire/web` — once a Cloudflare Pages `_headers` file or Workers transform is set up, allow `script-src https://assets.pinterest.com` (the script-widget loads `pinit_main.js` from there) and `connect-src https://widgets.pinterest.com` (pidgets data fetch) and `img-src https://i.pinimg.com` (pin thumbnails); `frame-src` is no longer needed since PR #28 dropped the iframe.
- [x] Outbound-link Pinterest fallback when the embed can't render — PR #28 ships a "View moodboard on Pinterest" link button that takes over after a 2.5s grace window if `pinit_main.js` is blocked (uBlock / Brave Shields / Privacy Badger fire `blocked:other` on EasyPrivacy filters) or fails to transform our `<a data-pin-do>` placeholder. Static-image / R2 snapshot path remains a future upgrade if blocker-fallback rates grow uncomfortable.

### Invite builder — review findings

- [x] **IB-S-M1** (fixed PR #112 — added `X-Content-Type-Options: nosniff` to the image-serve `Response`; the served content type already derives from the upload-time magic-byte allowlist via R2 `httpMetadata`) — Public image-serve endpoint `GET /api/invite/:slug/image/:slot` (`cire/api/src/routes/invite.ts`) reflects the R2-stored content type onto the `Response` with no `X-Content-Type-Options: nosniff`, and `createApp` adds no global security-header middleware. Upload-time magic-byte sniffing (`detectImageType` in `invite-assets.ts`) is the primary control and is sound, so stored objects are JPEG/PNG/WebP today — this is defence-in-depth (OWASP A05) against MIME confusion if any future path stores an attacker-influenced content type. Fix: add `X-Content-Type-Options: nosniff` (and ideally re-derive the served type from a fixed allowlist keyed off the R2 key) on the image route. See `[[wiki/systems/cire-auth]]`.
- [x] **IB-S-L1** (fixed PR #112 — per-IP `rateLimitMiddleware` (30 req/min, overridable via `AppOptions.inviteLimiter`) applied to the organiser invite instance, ahead of auth; 429 test added) — Organiser invite write routes (`PUT /invite/text`, `POST /invite/image/:slot`, `DELETE /invite/image/:slot` in `cire/api/src/routes/invite.ts`) have no per-user rate limiter, unlike the pre-auth `claim` / `account-link` surfaces. A valid organiser token can drive unbounded 5 MB R2 writes (storage/cost amplifier; prior object only best-effort deleted). Blast radius limited (caller must own the wedding). Fix: apply a modest per-user/per-wedding limiter to the image POST, mirroring the `/api/claim` limiter.
- [ ] **IB-S-L2** (partial PR #112 — data-map + retention rows added documenting the orphan/erasure gap; the fix proper still needs an R2 lifecycle rule or a scheduled sweeper, folded into C-H1) — Orphaned R2 objects are never reclaimed when `setImage` / `removeImage` (`cire/api/src/services/invite.ts`) best-effort cleanup of a superseded key fails (warn-and-continue only); no out-of-band sweeper exists. Repeated re-uploads whose cleanup fails accumulate orphaned objects holding personal data (wedding photos) with no lifecycle. Fix: add an R2 lifecycle rule or a scheduled sweeper reconciling `assets/<weddingId>/*` against keys referenced in `wedding_invite_customisations`. Intersects IB-C-L1.
- [x] **IB-C-L1** (compliance — done PR #112: `[[wiki/compliance/data-map]]` + `[[wiki/compliance/retention]]` rows added for the `cire-assets` images + `wedding_invite_customisations`; the erasure-reachability gap (D1 cascade doesn't reach R2, no wedding-delete flow) is recorded there and folds into C-H1 / IB-S-L2) — Uploaded hero/story images are new personal data (wedding photos) in the new `cire-assets` R2 bucket via `wedding_invite_customisations` (migration `0009`). No `[[wiki/compliance/data-map]]` / `[[wiki/compliance/retention]]` rows added. The D1 row's `ON DELETE cascade` does not fan out to R2 objects, so combined with IB-S-L2 there is no defined erasure path. Add data-map + retention rows and confirm images are reachable by wedding/account deletion. Tracked into root `[[wiki/TODO.md]]` Compliance Backlog.

### Account linking (guest → OSN/Pulse) — review findings

- [ ] **AL-S-L1** — Account-link endpoints (`/api/account/link`) are not rate-limited. The per-IP limiter is wired only to `/api/claim`. The POST mints an ARC token + makes an authenticated S2S call to osn-api per request (a signing + outbound-fetch amplifier), and unbounded `guestId` POSTs give a cheap family-membership oracle (403 non-member vs 409 conflict) within an authenticated session. Both credentials are required so blast radius is limited, but there is no ceiling. Fix: apply `rateLimitMiddleware` (per-IP or per-family) to both account-link instances in `createApp`, mirroring `/api/claim`. Most worthwhile follow-up. See `[[wiki/systems/cire-auth]]`.
- [ ] **AL-S-L2** — `POST /api/account/link` returns distinct status/labels (403 guest-not-in-family, 409 `already_linked`, 409 account-already-in-family, 404 profile-gone, 502 osn-down, 503 disabled). The `account_already_in_family` 409 signals to the caller that *some* OSN account is already linked to a sibling seat in their own household. Low severity — only reachable by a caller already authenticated to that household holding a valid OSN token (largely self-information). Optional hardening: collapse the two 409 reasons to a single opaque `already_linked`.
- [ ] **AL-C-L1** (compliance) — the new `guest_account_links` table binds a cire household to an OSN account/profile — a new cross-database personal-data linkage + processing purpose. Add `[[wiki/compliance/data-map]]` + `[[wiki/compliance/retention]]` rows (purpose: optional invitation surfacing in Pulse; lawful basis: consent, opt-in). Cascade-delete covers guest/family/wedding erasure; document the orphan behaviour on **OSN-side account deletion** (cire holds `osn_account_id` with no FK, so OSN deletion won't fan out here) — decide orphan-tolerance vs an ARC fan-out. Tracked into root `[[wiki/TODO.md]]` Compliance Backlog.
