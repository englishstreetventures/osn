---
title: "Cire TODO — cire/web"
tags: [todo, web]
related:
  - "[[index]]"
last-reviewed: 2026-06-12
---

# cire/web

Frontend feature work. Tick items as PRs land; add new entries when scope is discovered. Don't edit `wiki/todo/status.md` for area-specific items.

- [ ] **"Link my Pulse account" affordance (account-linking frontend)** — backend shipped (`/api/account/link`, see `[[api]]` + root `[[wiki/systems/cire-auth]]`). The guest UI must: obtain an OSN access token via `@osn/client` (a Pulse/OSN sign-in), let the invitee pick which household member they are, then `POST /api/account/link` with `{ guestId }` + the `Authorization: Bearer <token>` and the `cire_session` cookie. Handle 401 (token expired → `authFetch` refresh), 409 (already linked), 503 (linking disabled). Add a per-member linked/unlinked indicator (`GET /api/account/link`) and an unlink control (`DELETE /api/account/link/:guestId`).
- [x] Per-event metadata in `EventSummary` shape (calendar / dress-code / address / Pinterest / Maps fields landed in PR-A)
- [x] Rework `OrganiserView` to consume the new `OrganiserGuestRow` shape — moved to `cire/organiser/src/components/GuestTable.tsx`
- [ ] Replace hero photo placeholder with actual photo
- [ ] Customise monogram with couple's initials
- [ ] Write Our Story content
- [x] Populate dress code colour palette swatches from `event.dressCodePalette` (PR-E)
- [x] Embed actual Pinterest board URLs via `event.pinterestUrl` (PR-D); reworked in PR #28 — switched from `<iframe>` to Pinterest's documented script-widget pattern (`<a data-pin-do="embedBoard">` + `pinit_main.js`, daily-guard bypassed via cache-busted query so SPA re-mounts re-scan), with a 2.5s timeout fallback to a "View moodboard on Pinterest" link when tracker blockers fire `blocked:other` on `assets.pinterest.com`. `toEmbedUrl` removed; `isValidPinterestUrl` retained as the URL gate.
- [x] Wire RSVP modal to API using surfaced `guestId` per member (PR-F)
- [ ] "Open in Maps" button on event cards driven by `event.mapsUrl`
- [x] Add-to-calendar links (Google Calendar, Apple Calendar, .ics) sourced from `event.startAt` / `endAt` / `timezone` (PR-G)
- [x] ~~Passkey registration + login UI~~ — **Obsolete**: guests use claim codes (no accounts); organiser sign-in reuses OSN's `<SignIn>` from `@osn/ui` on the portal (OSN merge)
- [x] ~~Magic link email fallback UI~~ — **Obsolete**: no magic-link factor in the two-system auth model
- [ ] z-index token map for `cire/web` — currently `AnimatedModal` is `z-100`, `AddToCalendar` popover is `z-90`, event cards default. No shared constants enforce the ordering, so a future overlay at `z-80..z-99` could silently occlude the popover. PR-G follow-up via PR #22 review.
- [x] `LoginSection` claim code input `pattern` attribute fixed (`[A-Za-z0-9\\-]+` → `[A-Za-z0-9-]+`) — escaped `\-` inside a character class is rejected as `Invalid character in character class` under Chrome's `/v` regex flag, which broke client-side validation in recent Chrome. PR #28.
