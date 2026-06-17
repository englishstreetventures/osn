---
title: "Cire TODO — cire/web"
tags: [todo, web]
related:
  - "[[index]]"
  - "[[invite-builder]]"
last-reviewed: 2026-06-18
---

# cire/web

Frontend feature work. Tick items as PRs land; add new entries when scope is discovered. Don't edit `wiki/todo/status.md` for area-specific items.

- [x] **Invite-builder guest rendering** — static `Hero.astro` / `OurStory.astro` replaced by a `client:load` SolidJS island `InviteHeader.tsx` that fetches `GET /api/invite/:slug` and applies the organiser's image + copy overrides on top of the original (uncustomised ⇒ renders exactly as before). `PUBLIC_WEDDING_SLUG` env selects the wedding. This subsumes the three placeholders below (hero photo / monogram / Our Story copy) — they're now organiser-editable rather than hard-coded. See `[[invite-builder]]`.

- [ ] **"Link my Pulse account" affordance (account-linking frontend)** — backend shipped (`/api/account/link`, see `[[api]]` + root `[[wiki/systems/cire-auth]]`). The guest UI must: obtain an OSN access token via `@osn/client` (a Pulse/OSN sign-in), let the invitee pick which household member they are, then `POST /api/account/link` with `{ guestId }` + the `Authorization: Bearer <token>` and the `cire_session` cookie. Handle 401 (token expired → `authFetch` refresh), 409 (already linked), 503 (linking disabled). Add a per-member linked/unlinked indicator (`GET /api/account/link`) and an unlink control (`DELETE /api/account/link/:guestId`).
- [x] Per-event metadata in `EventSummary` shape (calendar / dress-code / address / Pinterest / Maps fields landed in PR-A)
- [x] Rework `OrganiserView` to consume the new `OrganiserGuestRow` shape — moved to `cire/organiser/src/components/GuestTable.tsx`
- [x] ~~Replace hero photo placeholder with actual photo~~ — now organiser-editable via the invite builder (`hero` image slot). See `[[invite-builder]]`.
- [x] ~~Customise monogram with couple's initials~~ — now organiser-editable via the invite builder (`heroTitle`). See `[[invite-builder]]`.
- [x] ~~Write Our Story content~~ — now organiser-editable via the invite builder (`storyEyebrow` / `storyHeading` / `storyBody`). See `[[invite-builder]]`.
- [x] Populate dress code colour palette swatches from `event.dressCodePalette` (PR-E)
- [x] Embed actual Pinterest board URLs via `event.pinterestUrl` (PR-D); reworked in PR #28 — switched from `<iframe>` to Pinterest's documented script-widget pattern (`<a data-pin-do="embedBoard">` + `pinit_main.js`, daily-guard bypassed via cache-busted query so SPA re-mounts re-scan), with a 2.5s timeout fallback to a "View moodboard on Pinterest" link when tracker blockers fire `blocked:other` on `assets.pinterest.com`. `toEmbedUrl` removed; `isValidPinterestUrl` retained as the URL gate.
- [x] **Pinterest consent gate now one-time, page-wide, persisted** (PR #126) — the third-party `pinit_main.js` embed stays consent-gated, but the opt-in is no longer session-scoped: consent persists in **localStorage** (survives the visit, never re-prompts on return) behind a single shared signal, so accepting on one board immediately reveals every other Pinterest board on the page. The consent prompt links the `/privacy` notice; the "View moodboard on Pinterest" fallback link is always available without consent. See `[[deferred]]` (resolved) + [[eprivacy]] (root compliance).
- [x] Wire RSVP modal to API using surfaced `guestId` per member (PR-F)
- [x] **Dietary-consent checkbox in `RsvpModal`** (C-H2 (cire dietary), PR #123) — once a guest enters dietary free-text (special-category Art. 9(2)(a)), the modal shows an explicit, **unticked-by-default** consent checkbox and gates submit on it, linking the `/privacy` notice. The server 422s a non-empty dietary without consent and stamps the consent record. See `[[api]]` + `[[dpia/cire-guest-data]]` (root compliance).
- [ ] "Open in Maps" button on event cards driven by `event.mapsUrl`
- [x] **Real Google Maps Embed preview in the event-details "Where" section** (key-optional) — `MapPreview.tsx` renders a Google Maps Embed API `place` iframe (free, unlimited, queried by the free-text venue `address` — no lat/lng, no geocoding, no schema change) when `PUBLIC_GOOGLE_MAPS_EMBED_KEY` is configured at build time; when the key is unset/blank, or the event has no address to query, it falls back to the existing CSS-drawn map card, so it is a pure enhancement and ships safely before any key exists. Address-only interpolation, always `encodeURIComponent`-escaped; iframe has a meaningful `title`, `loading="lazy"`, `referrerpolicy="no-referrer-when-downgrade"`, and a fixed height matching the card (no layout shift). The "Open in Maps" affordance keeps working in both modes (in the iframe path it moves to the footer, since the iframe captures pointer events). New env var documented in `cire/web/.env.example` + production-deploy runbook §3.3; human step is to create a referrer-restricted Maps-Embed-only key. `resolveMapsEmbedUrl` helper in `event-details.ts`.
- [x] Add-to-calendar links (Google Calendar, Apple Calendar, .ics) sourced from `event.startAt` / `endAt` / `timezone` (PR-G)
- [x] ~~Passkey registration + login UI~~ — **Obsolete**: guests use claim codes (no accounts); organiser sign-in reuses OSN's `<SignIn>` from `@osn/ui` on the portal (OSN merge)
- [x] ~~Magic link email fallback UI~~ — **Obsolete**: no magic-link factor in the two-system auth model
- [ ] z-index token map for `cire/web` — currently `AnimatedModal` is `z-100`, `AddToCalendar` popover is `z-90`, event cards default. No shared constants enforce the ordering, so a future overlay at `z-80..z-99` could silently occlude the popover. PR-G follow-up via PR #22 review.
- [x] `LoginSection` claim code input `pattern` attribute fixed (`[A-Za-z0-9\\-]+` → `[A-Za-z0-9-]+`) — escaped `\-` inside a character class is rejected as `Invalid character in character class` under Chrome's `/v` regex flag, which broke client-side validation in recent Chrome. PR #28.
