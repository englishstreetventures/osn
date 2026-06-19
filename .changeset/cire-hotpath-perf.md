---
"@cire/api": patch
---

Cut round-trips on the cire guest hot paths (RSVP submit + invite claim) and
stop buffering served original images in Worker memory.

- **P-W1 — batch the RSVP upserts.** `rsvpService.submitRsvp` issued one
  awaited `INSERT … ON CONFLICT` per guest×event pair, so a family RSVPing to N
  pairs cost N sequential D1 round-trips. New `rsvpService.submitRsvps([...])`
  builds one upsert statement per pair and commits them as a single
  `db.batch([...])` via `commitBatch` — atomic, one Workers↔D1 round-trip on
  D1; sequential in-process on bun:sqlite (no `.batch()`), mirroring
  `applyImport`. `submitRsvp` is now a thin single-element wrapper, so the
  per-pair upsert + Art. 9(2)(a) dietary-consent stamping + per-pair
  `metricRsvpUpserted` are unchanged. `POST /api/rsvp`'s submit loop is one
  `submitRsvps` call.

- **P-W2 — pipeline `claim.lookup`'s independent reads.** After the required
  family-by-publicId read, the three reads keyed only off `family` (wedding
  slug, guests + event-memberships, this family's rsvps) now issue together via
  `Effect.all({...}, { concurrency: "unbounded" })` instead of serially — ~1
  fewer serial round-trip on the hot path (no-op concurrency on bun:sqlite).
  The events read stays sequential after — it depends on the event ids derived
  from the guest rows. Response shape is byte-identical.

- **IB-P-I2 — stream the served original image.** The no-transform serve path
  (no Images binding, or an account without the product) now uses
  `fetchAssetStream` to pipe R2's `obj.body` `ReadableStream` straight into the
  `Response` instead of holding the whole (≤5 MB) image via
  `obj.arrayBuffer()`. `response.clone()` tees the stream so the Cache-API
  `put` and the returned body each get a copy. The Images transform path is
  unchanged — the binding needs the bytes buffered, and its failure fallback
  serves those same buffered bytes.

Hot-path correctness rests on the sync/async DB bridge: every batch/read works
on both bun:sqlite (tests/local, sync) and D1 (prod, async). Covered by the
existing claim + invite serve suites plus new batch-upsert and
`fetchAssetStream` tests.
