---
"@cire/api": patch
---

`cire-assets` orphan reconciliation — closes the open `cire-assets` half of
IB-S-L2 (R2 data-erasure). Invite images live in the `cire-assets` bucket
(binding `ASSETS`), keyed `assets/<weddingId>/...` and referenced by
`wedding_invite_customisations.hero_image_key`/`story_image_key` and
`events.event_image_key`. When a re-upload's (or remove's) best-effort delete of
the SUPERSEDED object fails, that object is orphaned forever (no R2 lifecycle).
The retention sweep deliberately never touches this bucket (it keeps the live
invite), so a separate reconciliation was needed.

New `services/asset-reconcile.ts` (`assetReconcileService.reconcileOrphans`),
wired into the daily cron `scheduled` handler alongside the session + retention
sweeps (passed `env.ASSETS`). It cursor-paginates the `assets/`-prefixed objects
and best-effort deletes those referenced by NO live DB row (reusing the
bucket-agnostic `reapR2Objects`, `cire.r2.objects.swept` with `bucket=assets`).

Because this deletes real wedding photos, it is fenced by mandatory fail-safe
guards:

- **Abort-on-uncertainty** — the live (referenced-key) set is read from D1
  first. If that read FAILS, or returns an EMPTY set while the bucket holds
  `assets/` objects (a strong signal the DB read is wrong), the run ABORTS and
  deletes NOTHING. We never delete unless we can positively confirm what's live.
- **Grace period** — an object is a candidate only if its R2 `uploaded` time is
  older than a 7-day window, so a freshly uploaded image whose DB-row write is
  momentarily lagging is never reaped.
- **Prefix scoping** — only keys under `assets/` are ever considered or deleted.
- **Per-run cap + chunking** — capped at 500 deletions/run (logged if capped;
  the next run continues). Deletes are best-effort (logged, no PII, bounded
  metric); a delete failure never aborts the run. Runs off the hot path (cron).

Tests (`asset-reconcile.test.ts`): referenced keys never deleted; unreferenced +
old IS deleted; unreferenced but too-new is NOT (grace); empty referenced-set
against a non-empty bucket deletes nothing (abort guard); `list()` throwing
aborts; non-`assets/` keys ignored; per-run cap respected across cursor pages;
absent binding is a no-op.

Also in this PR (docs/audit only, no behaviour change):

- **AL-C-L1 (compliance)** — added `guest_account_links` rows to the data-map +
  retention compliance pages (purpose: optional invitation surfacing in Pulse;
  lawful basis: Art. 6(1)(a) consent/opt-in; cascade-delete covers
  guest/family/wedding erasure; documented the OSN-side-account-deletion orphan
  behaviour — cire holds `osn_account_id` with no FK, so OSN deletion won't fan
  out; resolution: orphan-tolerant).
- **Session-cookie `Domain=` audit** — confirmed the `cire_session` cookie is
  same-origin to cire-api end to end (set by + sent only back to
  `api.cireweddings.com`), so host-scoping is correct and more secure than a
  broad `Domain=.cireweddings.com`. Resolved: no `Domain=` needed. Stale comment
  in `lib/cookie.ts` updated with the rationale.
- **`GET /api/events` audit** — assessed as OBSOLETE: events already reach guests
  via the `POST /api/claim` response and the public invite carries
  hero/story/theme; a standalone public event-list endpoint has no caller and
  would leak event details pre-claim. Not implemented by design.

No DB migration (reconciliation/purge logic only).
