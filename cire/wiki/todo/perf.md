---
title: "Cire TODO — performance backlog"
tags: [todo, performance]
related:
  - "[[index]]"
  - "[[review-findings]]"
last-reviewed: 2026-06-16
---

# Performance Backlog

See [[review-findings]] for severity prefix conventions.

### Host invite preview — review findings (host-preview-code branch)

Branch-scoped IDs (distinct from the numbered items below).

- [x] **HP-P-W1** — `hostCodeService.ensureForWedding` linked the host guest to every event with one `db.insert(guestEvents).run()` per event (N D1 round-trips on first preview / after an import adds events). **Fixed:** the missing-link inserts are collected into one `db.batch([...])` (sequential on bun:sqlite), mirroring `import.ts`'s `commitWriteSet`.
- [x] **HP-P-W2** (no change — deliberate) — the new `ne(families.kind,'host')` predicates in `claim.getAllGuests` + `import.diffAgainstDb` aren't index-backed, but `families_wedding_idx` scopes the scan and the residual filter rejects ≤1 host row per wedding; a dedicated index would be wasted write-amplification.
- [x] **HP-P-I1** (no change) — the RSVP host-kind guard adds one PK-indexed `SELECT kind` per RSVP submit; trivial on a low-frequency authenticated write, kept standalone for readability.

### Invite builder — review findings

- [x] **IB-P-W1** (fixed PR #112) — Guest hero LCP regressed from static SSR to a client-fetch waterfall. Fixed: `index.astro` resolves the customisation at build time (`await fetch` the public endpoint, graceful null fallback) and passes it to `InviteHeader` as `initial`, so the hero title/copy + `<img src>` are in the SSR'd HTML; the island seeds `createResource` with it and revalidates on mount for post-build changes.
- [x] **IB-P-W2** (fixed PR #112) — Custom hero image was invisible to the preload scanner. Fixed: `index.astro` emits `<link rel="preload" as="image">` for the build-resolved hero image (immutably cached).
- [x] **IB-P-W3** (fixed PR #112) — `getForWeddingId` now does one `weddings LEFT JOIN wedding_invite_customisations` query (was slug-lookup + customisation-lookup); `upsertText` / `removeImage` re-call it after the write (now write + 1 join).
- [x] **IB-P-I1** (fixed PR #112) — `imageKeyForSlug` now uses a single `LEFT JOIN` keyed on `weddings.slug`: a missing weddings row is the 404, a null-joined customisation is "no image yet" — one round-trip.
- [ ] **IB-P-I2** — `fetchAsset` (`cire/api/src/services/invite-assets.ts`) materialises the full image via `obj.arrayBuffer()` (≤5 MB held in Worker memory) rather than streaming R2's `obj.body` into the `Response`. Bounded by the cap + CDN caching, hence Info. Fix on serve path only (upload buffering is needed for the magic-byte sniff).

### Account linking (guest → OSN/Pulse) — review notes (Info, no action)

- **AL-P-I1** — `createArcAccountResolver` mints a fresh ARC token (`signArcToken`) per `POST /api/account/link` rather than reusing one (the bun/node side has `getOrCreateArcToken`'s cache). Deliberate: linking is a rare, human-initiated, per-invitee one-shot action; the sub-ms ES256 sign is dwarfed by the outbound osn-api fetch. Add a TTL cache only if link volume ever rises.
- **AL-P-I2** — `listByFamily` / `listByAccount` have no `LIMIT`. Deliberate: both are structurally tiny (one row per guest in a household / per wedding for an account) and index-backed (`guest_account_links_family_idx` / `_account_idx`). Add a cursor only if `listByAccount` later backs a high-fan-out Pulse feed.

### Observability instrumentation — review notes (Info, no action)

- **P-I4** — `POST /api/rsvp` loops `body.rsvps` and calls `rsvpService.submitRsvp` per pair; each call now carries `Effect.withSpan("cire.rsvp.submit")` + a metric tap, so a batch of N pairs creates N spans + N (no-op-on-workerd) counter calls. Fine at current bounds — N is one family's event count (tens), schema-capped by `MAX_RSVP_BYTES` + `BulkRsvpBody`. If RSVP batches ever grow (e.g. an organiser bulk tool reuses this path), wrap the loop in one span and keep the per-pair counter inside. Folds into **P-W1** (batch the upserts). (observability branch review)
- **P-I1/P-I2** (no action) — `runCire`/`runCireSync` apply `cireLoggerLayer` per Effect run, but `loadConfig` + logger construction are hoisted to module scope (once per isolate); the per-call cost is two `FiberRef` patches. Redaction only runs when a line is actually emitted at level, and is off the claim/rsvp happy paths. Module-level layer build on workerd is sound; keep `OTEL_EXPORTER_OTLP_HEADERS` unset so the strict header parser can't throw at import. (observability branch review)

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
