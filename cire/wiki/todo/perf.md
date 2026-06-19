---
title: "Cire TODO — performance backlog"
tags: [todo, performance]
related:
  - "[[index]]"
  - "[[review-findings]]"
last-reviewed: 2026-06-20
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
- [x] **IB-P-I2** — Stream the served ORIGINAL image instead of buffering. The no-transform serve path (no Images binding, or an account without the product) now uses `fetchAssetStream` to pipe R2's `obj.body` `ReadableStream` straight into the `Response`, so a ≤5 MB image is never fully materialised in Worker memory; `response.clone()` tees the stream so the Cache-API `put` and the returned body each get a copy. The Images **transform** path is deliberately unchanged — the binding needs the bytes buffered (`fetchAsset` → `input(stream-over-bytes)`), and a transform-failure fallback serves those same already-buffered bytes. `AssetObjectBody.body` is optional, so a non-R2 backend that only implements `arrayBuffer()` falls back to a buffered one-shot stream (same result, no streaming win). Existing serve-route tests (assert served bytes == original) + new `fetchAssetStream` unit tests cover it. (cire-hotpath-perf branch)

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
- [x] **P-W1** — Batch `rsvpService.submitRsvp` upserts (was N sequential D1 round-trips on the guest hot path). New `rsvpService.submitRsvps([...])` builds one `INSERT … ON CONFLICT DO UPDATE` per pair and commits them as a single `db.batch([...])` via `commitBatch` — atomic, one Workers↔D1 round-trip on D1; sequential in-process on bun:sqlite (no `.batch()`), mirroring `applyImport`. `submitRsvp` is now a thin single-element wrapper, so semantics (per-pair upsert + Art. 9(2)(a) dietary-consent stamping) + per-pair `metricRsvpUpserted` are identical. The `POST /api/rsvp` loop is replaced by one `submitRsvps` call. Savings: a family RSVPing to N (guest×event) pairs drops from N D1 round-trips to 1. New batch tests (multi guest×event, in-place upsert, per-pair consent, empty no-op). (cire-hotpath-perf branch)
- [x] **P-W2** — Pipeline `claim.lookup`'s independent D1 reads via `Effect.all({...}, { concurrency: "unbounded" })`. After the required family-by-publicId read, the three reads keyed only off `family` (wedding slug, guests+event-memberships, this family's rsvps) now issue together instead of serially — ~1 fewer serial round-trip on the guest hot path (no-op concurrency on bun:sqlite, in-process). The events read stays sequential after — it depends on the event ids derived from the guest rows. Response shape is byte-identical (existing claim.lookup tests pass unchanged). (cire-hotpath-perf branch)
- [ ] Landing page animations must not block LCP — defer Motion One until after first paint
- [x] Hero photo must be optimised (WebP/AVIF, responsive srcset) — CONFIRMED already done. The image serve route negotiates a modern output format per request via `negotiateFormat` (`Accept`-driven AVIF → WebP → JPEG fallback, on the metric/span as a bounded value) and the Cloudflare Images binding emits it; the frontend renders responsively via `buildSrcSet` (the `thumb`/`card`/`hero` width variants) — `InviteHeader.tsx` (hero + event images) + `EventCard.tsx` — and the hero LCP element is preloaded with `imagesrcset`/`imagesizes` in `InviteDocument.astro`. Nothing missing.
- [x] Add-to-calendar data should not require a round-trip if event data is already hydrated in the page (PR-G — `googleCalendarUrl` + `icsBlob` are pure client-side helpers consuming the existing claim payload)
- [x] .ics generation can be client-side to avoid unnecessary Worker invocation (PR-G — `cire/web/src/components/calendar.ts` builds the VCALENDAR in the browser; no Worker route added)
- [x] Organiser events re-fetched on every tab switch — **fixed.** CONFIRMED the re-fetch: `DashboardTabs` renders each panel behind a `<Show>`, so flipping Guests ↔ Events unmounts/remounts `EventTable` and its `onMount` re-fired `GET /api/organiser/weddings/:weddingId/events` on every flip back. Added a module-scoped, `weddingId`-keyed cache (`cire/organiser/src/lib/events-store.ts`, plain Solid signals — no Effect, no state lib): events are fetched at most once per wedding and reused across remounts; a cache hit on mount skips the request entirely. Reads are reactive so image/crop patches (now via `patchCachedEvent`) survive a tab switch. Invalidation: a different `weddingId` is a different key (wedding change refetches); `ImportPanel`'s apply flow calls `invalidateEvents(weddingId)` so newly imported events show on the next Events mount. New EventTable tests count `authFetch` calls to prove no re-fetch on tab switch-back, and a refetch on wedding change + after an import-apply invalidation. (The original note mis-attributed the fetch to `ImportPanel`; it was `EventTable`.)
- [ ] Spreadsheet import on Workers: `applyImport` now uses one `db.batch`, but a very large diff can exceed D1's per-batch statement cap — chunk into ≤N-statement batches (and consider a Queue-driven worker for large diffs) before organiser sheets grow past a few hundred rows
- [x] `/list` paginated with `limit` + `uploadedAt` cursor (PR-C review)
- [ ] Cache the parsed `ImportPlan` on the imports row to avoid re-parse + re-diff on `/apply` and `/revert` (currently re-runs both as TOCTOU defence). Consider once organiser sheet exceeds ~600 rows or revert latency becomes user-visible (PR-C review)
