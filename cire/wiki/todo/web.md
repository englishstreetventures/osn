---
title: "Cire TODO — cire/web"
tags: [todo, web]
related:
  - "[[index]]"
  - "[[invite-builder]]"
last-reviewed: 2026-06-21
---

# cire/web

Frontend feature work. Tick items as PRs land; add new entries when scope is discovered. Don't edit `wiki/todo/status.md` for area-specific items.

Completed feature history is archived in `[[changelog/completed-features]]` (Migrated from web.md, 2026-06-21). The 3 most recent done items are kept inline below for recent context.

## Open

- [ ] **Pinterest moodboard embed not rendering in practice — needs live DevTools deep-dive** — after re-enabling the embed on all devices (#220) + backfilling the 4 live events to canonical board URLs, the board still doesn't visibly render for the product owner. Ruled out (2026-06-21): URL resolution (boards resolve to canonical `pinterest.com.au/<user>/<board>/`), data freshness (events come from the live `/api/claim` response, not the image cache), CSP (Report-Only, all Pinterest origins allowlisted), and board availability — Pinterest's pidgets API (`widgets.pinterest.com/v3/pidgets/boards/<user>/<board>/pins/`) returns `status: success` with pins. Remaining suspect: Pinterest's own client-side `pinit_main.js` widget rendering (long-standing mobile flakiness). NEXT: live DevTools on the deployed site — does `pinit_main.js` load, does the pidgets XHR succeed, does an `<iframe>` get inserted into the embed container? Possible minor follow-up: normalise the stored board host to `www.pinterest.com` (Pinterest's canonical) rather than the regional `.com.au` (harmless for the slug-based pidgets call, just tidier). See `[[api]]` (pin.it resolution) + `PinterestBoard.tsx`.
- [ ] **"Link my Pulse account" affordance (account-linking frontend)** — backend shipped (`/api/account/link`, see `[[api]]` + root `[[wiki/systems/cire-auth]]`). The guest UI must: obtain an OSN access token via `@osn/client` (a Pulse/OSN sign-in), let the invitee pick which household member they are, then `POST /api/account/link` with `{ guestId }` + the `Authorization: Bearer <token>` and the `cire_session` cookie. Handle 401 (token expired → `authFetch` refresh), 409 (already linked), 503 (linking disabled). Add a per-member linked/unlinked indicator (`GET /api/account/link`) and an unlink control (`DELETE /api/account/link/:guestId`).

## Recently completed (kept inline for context)

Full history in `[[changelog/completed-features]]`.

- [x] **Mobile details bottom-sheet — rounder top corners** (`fix/cire-invite-ui-tweaks`) — the event "more details" sheet (`AnimatedModal.tsx`, mobile bottom-anchored `items-end`) had `rounded-t-xl` (12px) top corners; bumped to `rounded-t-[1.75rem]` (28px) so it pops up reading as a card. Scoped to mobile (mobile-first); the desktop `md:rounded-lg` centred-dialog override is unchanged. **Wants a real-device eyeball** — the rounded-top card feel renders in a real browser, not happy-dom.
- [x] **Maps embed "Open in Maps" chrome — not supportably removable** (`fix/cire-invite-ui-tweaks`) — investigated suppressing the Google Maps Embed iframe's built-in "View larger map" / "Open in Google Maps" link in `MapPreview.tsx` (it's redundant with the app's own footer "Open in Maps" button). The Maps Embed API `place` mode (`maps/embed/v1/place`) has **no officially documented parameter** to hide it, and a CSS overlay covering it would hide Google's attribution and **violate the Maps Platform ToS** — so the embed is left as-is. The redundancy is purely cosmetic (the app already ships its own "Open in Maps" affordance). Logged here so it isn't re-investigated; revisit only if Google adds a supported control.
- [x] **Security headers + CSP via SSR middleware** (`feat/cire-web-csp`) — the guest site now sets a full Content-Security-Policy plus `X-Content-Type-Options` / `Referrer-Policy` / `X-Frame-Options` / `Permissions-Policy` from a new Astro `onRequest` middleware (`src/middleware.ts` → `src/lib/security-headers.ts`). This is the correct home for them on an SSR Worker: `public/_headers` only covers the static-asset layer (prerendered `/privacy` + `/terms`, `/_astro/*`), not the Worker-rendered invite routes. CSP allowlist derived from the site's real external origins (Pinterest, Google Maps embed, Google Fonts, Turnstile, first-party cire-api). See `[[security]]` for the full directive list + per-origin rationale and the real-browser smoke-test flag. `script-src` stays host-restricted but keeps `'unsafe-inline'` for Astro island hydration + the font preload `onload` handler; `style-src` keeps `'unsafe-inline'` for the invite's inline theme style attributes.
</content>
