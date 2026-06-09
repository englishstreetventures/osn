---
title: "Cire TODO — performance backlog"
tags: [todo, performance]
related:
  - "[[index]]"
  - "[[review-findings]]"
last-reviewed: 2026-05-05
---

# Performance Backlog

See [[review-findings]] for severity prefix conventions.

- [x] Split joined events from per-guest rows in `claim.lookup` to drop the duplicated `dressCodePalette` payload (PR-A review)
- [x] Drop redundant ownership `SELECT` in `rsvpService.submitRsvp` (route validates once for the bulk batch) (PR-A review)
- [x] Add `events.sortOrder` and `(guests.familyId, guests.sortOrder)` indices (PR-A review, migration 0004)
- [x] `lefthook` pre-push runs typecheck + test in parallel (PR-A review)
- [ ] PBKDF2 100k iterations + dummy-hash-on-miss is ~20-40ms per request on Workers. Pairs with rate limiting (above) before public launch — once that's in place, consider lowering iterations to 25-50k for a wedding-scale threat model.
- [ ] `getAllGuests` paginate / cursor once organiser UI is built — current single-join is fine at 100 guests, problematic past a few thousand
- [ ] Batch `rsvpService.submitRsvp` upserts via `db.batch([...])` once D1 runtime is wired (currently still N round-trips, just no longer 2N) — PR-A review follow-up
- [ ] `claim.lookup` could pipeline its 3 D1 queries via `Effect.all`; today they are sequential which adds ~2 round-trips of latency on the hot path — PR-A review follow-up
- [ ] Landing page animations must not block LCP — defer Motion One until after first paint
- [ ] Hero photo must be optimised (WebP/AVIF, responsive srcset)
- [x] Add-to-calendar data should not require a round-trip if event data is already hydrated in the page (PR-G — `googleCalendarUrl` + `icsBlob` are pure client-side helpers consuming the existing claim payload)
- [x] .ics generation can be client-side to avoid unnecessary Worker invocation (PR-G — `apps/web/src/components/calendar.ts` builds the VCALENDAR in the browser; no Worker route added)
- [ ] Spreadsheet import on Workers: chunk inserts (≤100 rows per batch) to stay under 50ms CPU per request; offload large diffs to a Queue-driven worker
- [x] `/list` paginated with `limit` + `uploadedAt` cursor (PR-C review)
- [ ] Cache the parsed `ImportPlan` on the imports row to avoid re-parse + re-diff on `/apply` and `/revert` (currently re-runs both as TOCTOU defence). Consider once organiser sheet exceeds ~600 rows or revert latency becomes user-visible (PR-C review)
