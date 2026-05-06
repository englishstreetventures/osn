---
title: "Cire TODO — apps/web"
tags: [todo, web]
related:
  - "[[index]]"
last-reviewed: 2026-05-05
---

# apps/web

Frontend feature work. Tick items as PRs land; add new entries when scope is discovered. Don't edit `wiki/todo/status.md` for area-specific items.

- [x] Per-event metadata in `EventSummary` shape (calendar / dress-code / address / Pinterest / Maps fields landed in PR-A)
- [x] Rework `OrganiserView` to consume the new `OrganiserGuestRow` shape — moved to `apps/organiser/src/components/GuestTable.tsx`
- [ ] Replace hero photo placeholder with actual photo
- [ ] Customise monogram with couple's initials
- [ ] Write Our Story content
- [x] Populate dress code colour palette swatches from `event.dressCodePalette` (PR-E)
- [x] Embed actual Pinterest board URLs via `event.pinterestUrl` (PR-D)
- [x] Wire RSVP modal to API using surfaced `guestId` per member (PR-F)
- [ ] "Open in Maps" button on event cards driven by `event.mapsUrl`
- [ ] Add-to-calendar links (Google Calendar, Apple Calendar, .ics) sourced from `event.startAt` / `endAt` / `timezone` (PR-G)
- [ ] Passkey registration + login UI
- [ ] Magic link email fallback UI
