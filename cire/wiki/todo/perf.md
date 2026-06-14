---
title: "Cire TODO — performance backlog"
tags: [todo, performance]
related:
  - "[[index]]"
  - "[[review-findings]]"
last-reviewed: 2026-06-14
---

# Performance Backlog

See [[review-findings]] for severity prefix conventions.

### Account linking (guest → OSN/Pulse) — review notes (Info, no action)

- **AL-P-I1** — `createArcAccountResolver` mints a fresh ARC token (`signArcToken`) per `POST /api/account/link` rather than reusing one (the bun/node side has `getOrCreateArcToken`'s cache). Deliberate: linking is a rare, human-initiated, per-invitee one-shot action; the sub-ms ES256 sign is dwarfed by the outbound osn-api fetch. Add a TTL cache only if link volume ever rises.
- **AL-P-I2** — `listByFamily` / `listByAccount` have no `LIMIT`. Deliberate: both are structurally tiny (one row per guest in a household / per wedding for an account) and index-backed (`guest_account_links_family_idx` / `_account_idx`). Add a cursor only if `listByAccount` later backs a high-fan-out Pulse feed.

- [x] Split joined events from per-guest rows in `claim.lookup` to drop the duplicated `dressCodePalette` payload (PR-A review)
- [x] Drop redundant ownership `SELECT` in `rsvpService.submitRsvp` (route validates once for the bulk batch) (PR-A review)
- [x] Add `events.sortOrder` and `(guests.familyId, guests.sortOrder)` indices (PR-A review, migration 0004)
- [x] `lefthook` pre-push runs typecheck + test in parallel (PR-A review)
- [ ] PBKDF2 100k iterations + dummy-hash-on-miss is ~20-40ms per request on Workers. Pairs with rate limiting (above) before public launch — once that's in place, consider lowering iterations to 25-50k for a wedding-scale threat model.
- [ ] `getAllGuests` paginate / cursor once organiser UI is built — current single-join is fine at 100 guests, problematic past a few thousand
- [x] **P-C1** — `applyImport` commits its write set as a single atomic `db.batch([...])` on D1 (one round-trip, all-or-nothing) instead of N sequential awaited statements; bun:sqlite (no `.batch()`) keeps the sequential path. Driver-branched in `commitWriteSet` (`services/import.ts`). Also closes the non-atomic partial-apply gap (S-L1). D1-batch atomicity covered by `src/db/d1-integration.test.ts`. (D1 runtime wiring branch)
- [ ] **P-W1** — Batch `rsvpService.submitRsvp` upserts via a single multi-row `INSERT … ON CONFLICT` / `db.batch([...])` (currently N round-trips on the guest hot path). Deferred follow-up to the D1 wiring branch
- [ ] **P-W2** — Pipeline `claim.lookup`'s independent D1 reads (guests+links, rsvps) via `Effect.all`; today sequential, ~1 extra round-trip on the hot path. Deferred follow-up to the D1 wiring branch
- [ ] Landing page animations must not block LCP — defer Motion One until after first paint
- [ ] Hero photo must be optimised (WebP/AVIF, responsive srcset)
- [x] Add-to-calendar data should not require a round-trip if event data is already hydrated in the page (PR-G — `googleCalendarUrl` + `icsBlob` are pure client-side helpers consuming the existing claim payload)
- [x] .ics generation can be client-side to avoid unnecessary Worker invocation (PR-G — `cire/web/src/components/calendar.ts` builds the VCALENDAR in the browser; no Worker route added)
- [ ] Organiser `ImportPanel` re-fetches events on every tab switch — cache the events response (or lift it to the dashboard shell) so switching Guests ↔ Events doesn't refire the request. Minor; noticed during the OSN-merge E2E pass.
- [ ] Spreadsheet import on Workers: `applyImport` now uses one `db.batch`, but a very large diff can exceed D1's per-batch statement cap — chunk into ≤N-statement batches (and consider a Queue-driven worker for large diffs) before organiser sheets grow past a few hundred rows
- [x] `/list` paginated with `limit` + `uploadedAt` cursor (PR-C review)
- [ ] Cache the parsed `ImportPlan` on the imports row to avoid re-parse + re-diff on `/apply` and `/revert` (currently re-runs both as TOCTOU defence). Consider once organiser sheet exceeds ~600 rows or revert latency becomes user-visible (PR-C review)
