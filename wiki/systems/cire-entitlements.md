---
title: Cire entitlements
tags: [systems, cire, entitlements, phase1]
related:
  - "[[cire-vendors]]"
  - "[[cire-registry]]"
  - "[[cire-auth]]"
last-reviewed: 2026-09-01
---
# Entitlements — per-wedding capability gates

The entitlement system is a row-presence gate: a row in `wedding_entitlements` means that wedding has the named capability. No row means the capability is absent. There are no enum columns to decode, no flag columns to toggle — the table acts as a sparse capability set.

---

## Database — `wedding_entitlements` table

Added by migration 0042.

| Column | Type | Notes |
|---|---|---|
| `wedding_id` | `text NOT NULL` | FK → `weddings.id` ON DELETE CASCADE |
| `entitlement` | `text NOT NULL` | One of the capability keys (see below) |
| `source` | `text NOT NULL` | `'purchase'` or `'comp'` |
| `granted_at` | `integer` (timestamp) | When the row was written |
| `granted_by` | `text NOT NULL` | Operator identifier (for comp rows) or system label |
| `provider_ref` | `text` | External provider reference on `source = 'purchase'`; `NULL` on `source = 'comp'` |

**Primary key:** composite `(wedding_id, entitlement)` — one row per (wedding, capability) pair. Duplicate grants via `INSERT OR IGNORE` / `onConflictDoNothing` are idempotent.

---

## Entitlement keys

Six opaque capability flags. The table stores keys as plain strings. How the application checks a key decides what it means.

| Key | What its presence enables |
|---|---|
| `premium_templates` | Access to extended invite template designs |
| `vendors` | Vendor CRM (wedding-scoped) + Directory browse/add routes |
| `ai` | AI-assisted content generation features |
| `capacity_500` | Guest import ceiling raised to 500 |
| `capacity_1000` | Guest import ceiling raised to 1000 |
| `registry` | Gift registry module — the organiser routes and, transitively, the guest-facing registry section |

Boolean capability flags (`premium_templates`, `vendors`, `ai`, `registry`) are presence-only: the row either exists or it doesn't. Capacity flags work differently — see below.

---

## Derived guest capacity

Guest capacity is not stored as a column. It is **derived** from the entitlement set at the moment of enforcement. `deriveCap` (a pure function in `cire/api/src/services/entitlements.ts`) inspects the set and returns the ceiling:

| Entitlement row present | Effective guest ceiling |
|---|---|
| `capacity_1000` | 1000 |
| `capacity_500` (and NOT `capacity_1000`) | 500 |
| neither capacity row | 100 |

`capacity_1000` wins over `capacity_500` if both rows happen to exist. The ceiling deliberately has no stored column — it cannot drift from the entitlement set.

---

## `entitlementService` — methods

All methods are Effect programs returning `Effect.Effect<A, E, DbService>`. Implemented in `cire/api/src/services/entitlements.ts`.

| Method | Signature | Description |
|---|---|---|
| `has` | `(weddingId, key) → Effect<boolean, never, DbService>` | Returns `true` if the row `(weddingId, key)` exists |
| `setsForWeddings` | `(weddingIds[]) → Effect<Map<weddingId, EntitlementKey[]>, never, DbService>` | Batch-fetches all entitlement rows for a list of wedding IDs; used to annotate wedding-list responses |
| `deriveCap` | `(keys: string[]) → number` | Pure — derives the effective guest ceiling from an entitlement key array |
| `grant` | `(weddingId, key, { source, grantedBy, providerRef? }) → Effect<void, never, DbService>` | Inserts a row; idempotent on conflict |
| `assertGuestCapacity` | `(weddingId, incomingNewGuests, precomputedCap?) → Effect<void, CapacityExceeded, DbService>` | Derives the cap (from `precomputedCap` if given, else its own — now narrowed, see below — entitlement query), counts current (non-host) guests, fails with `CapacityExceeded { limit, current }` if the import would breach the ceiling. `precomputedCap` only ever skips the RE-DERIVATION, never the check itself |

`CapacityExceeded` is a tagged error (`Data.TaggedError`); handlers map it to a **402** response with body `{ error: "payment_required", entitlement: "capacity", limit, current }`.

---

## `weddingEntitlement(db, key)` middleware

Implemented in `cire/api/src/middleware/wedding-entitlement.ts`. Returns an Elysia plugin (scoped derive + onBeforeHandle).

**Ordering in the middleware chain:**

```
osnAuth()              ← verifies OSN access JWT
weddingOwner/Editor/Member()  ← role gate (403 if wrong role)
weddingEntitlement(db, key)   ← entitlement gate (402 if capability absent)
rateLimiter            ← rate limiting
```

The entitlement gate sits **after** the role gate. The role gate already returns a 403 to a viewer on an entitled wedding, before this middleware runs. A `402` from this middleware means: the caller's role is enough, but the wedding itself does not have the capability.

**402 response contract:**

```json
{ "error": "payment_required", "entitlement": "<key>" }
```

HTTP status `402`. The organiser portal reads the `entitlement` field to display the relevant upsell UI panel.

A missing `weddingId` in `params` (should not occur after the role gate validates it) degrades to a `402` rather than throwing.

**It does no D1 read when the role gate has already refused.** Both role gates park their refusal on the context as `weddingGateError`; the entitlement `derive` returns immediately when it finds one. Elysia runs every `derive` before any `onBeforeHandle`, so without that check a stranger's request still paid for an entitlement query whose answer could never change the response — a free, unauthenticated read on every request to every gated route. Skipping it leaves the status ordering untouched (401, then 403 `read_only_role`, then 402 `payment_required`), which route tests pin.

**It shares a query with the role gate instead of running its own (P-W1, fixed).** `weddingMember(db, key)` / `weddingEditor(db, key)` take the SAME entitlement key this middleware is mounted with as an optional second argument. When given, `hostsService.authorize()` folds an `EXISTS` check against `wedding_entitlements` into the SAME `SELECT` it already runs for the owner/host row (one extra column, not a second query — the `directory.ts` `inWedding` idiom) and exposes the answer as `weddingEntitlementFold` on context. `weddingEntitlement`'s derive picks that up (`readWeddingEntitlementFold` in `upstream-context.ts`) instead of calling `entitlementService.has()` itself, provided the fold's key matches its own — a mismatch or absence (the gate mounted standalone, or a role gate called with no key) falls back to the old separate query, so correctness never depends on the two call sites staying in sync, only the round-trip saving does. Net effect on a gated route: an owner drops from 2 queries to 1, a co-host from 3 to 2. **Every route that mounts a role gate WITHOUT `weddingEntitlement` must never pass a key** — an unconditional fold would add the entitlement query's cost to every organiser route, gated or not; only the three route files that also `.use(weddingEntitlement(db, key))` pass one (`vendor-directory.ts`, `vendors.ts`, `registry.ts`). Proven by `cire/api/tests/middleware/wedding-entitlement-fold.test.ts`, which counts `db.select()` calls on both a gated and an ungated route.

---

## Capacity enforcement in `applyImport`

`applyImport` (in `cire/api/src/services/import.ts`) calls `entitlementService.assertGuestCapacity(weddingId, netGuestDelta, plan.derivedCap)` — where `netGuestDelta = guestCreates.length - guestRemoves.length` — **before** writing any rows. `applyImport` skips the check when the net delta is zero or negative (a churn import that removes K and adds K at cap succeeds). The check and the D1 batch write that follows are sequenced atomically: if the capacity check fails, no guests are written. There are no partial writes.

The check counts real guests only — a `ne(families.kind, 'host')` filter excludes the synthetic `host`-kind family row used for invite previews.

**The capacity query only ever reads the two rows that can matter (P-I3, fixed).** `assertGuestCapacity`'s own fallback query, and `diffAgainstDb`'s preview-warning query below, both filter `WHERE entitlement IN ('capacity_500', 'capacity_1000')` (the `CAPACITY_ENTITLEMENT_KEYS` constant in `entitlements.ts`) instead of fetching every entitlement row on the wedding — `deriveCap` only ever inspects those two keys, so the wider fetch was pure waste. **`setsForWeddings` is NOT narrowed** — it feeds `deriveCap` in `organiser-weddings.ts` and also drives feature display (`premium_templates`/`vendors`/`ai`/`registry`), so it keeps returning the full set.

**`diffAgainstDb`'s preview warning skips its own query below a floor threshold (P-I2, fixed).** The resulting guest count after any plan is `existing − removes + creates`, which can never exceed `existing + creates` (removes only ever help). Since the cap can never fall below `BASE_GUEST_CAP` (100, exported from `entitlements.ts`, the same fallback `deriveCap` returns), `diffAgainstDb` skips the entitlement query — and the warning check — entirely once `existingGuests.length + guestCreates.length <= BASE_GUEST_CAP`: no entitlement row on any wedding could make that import breach the cap. Above the threshold it runs the (now narrowed) query as before.

**`applyImport` reuses `diffAgainstDb`'s already-derived cap instead of re-scanning (P-W2, fixed).** `ImportPlan` carries an optional `derivedCap: number`, set by `diffAgainstDb` ONLY when its own preview-warning block actually ran the entitlement query (i.e. above the P-I2 threshold, with `guestCreates.length > 0`). `applyImport` passes it straight to `assertGuestCapacity`'s `precomputedCap` parameter, which then skips its own query. `derivedCap` is absent whenever the preview never needed the real cap (below the P-I2 threshold, or no guests were being created) — `assertGuestCapacity` MUST keep enforcing in that case by running its own (narrowed) query; a missing cap is never treated as "no cap". This composes with P-I2 cleanly: a small import pays one query total (`applyImport`'s own, since the preview skipped its), a large one also pays one query total (the preview's, reused by `applyImport`) — never the two separate scans of the same rows either fix alone would still leave on the table. Both call sites that feed `applyImport` a plan (`organiser-changes.ts` and `revert.ts`) run `diffAgainstDb` then `applyImport` in the SAME request — plan objects never cross the client boundary, so there is no TOCTOU window between the two.

---

## Comp-grant CLI

`cire/api/scripts/grant-entitlement.ts` is an operator tool for manual (comp) grants. It is not a network-accessible route.

**Local run (bun:sqlite):**

```bash
bun run cire/api/scripts/grant-entitlement.ts <weddingId> <key,key,...> [grantedBy]
```

**Production (D1):** the script prints idempotent `INSERT OR IGNORE` SQL.

**Warning:** a prod D1 write needs explicit human authorisation naming `cire-db`. Get it before you run the command below. This is a deploy-time step, not an automated path.

Apply via:

```bash
wrangler d1 execute cire-db --remote --command "<printed SQL>"
```

---

## Phase-2 payment seam

`grant()` accepts `source: 'purchase'` and a `providerRef` field. A webhook skeleton (`cire/api/src/routes/payment-webhook.ts`) exists but is inert in Phase 1 — all Phase-1 grants use `source: 'comp'`. The `provider_ref` column is the idempotency anchor for Phase-2 event-driven grants. Provider selection is tracked outside this repository.

---

## Related

- [[cire-vendors]] — Vendor CRM + Directory; both route groups gate on the `vendors` entitlement
- [[cire-registry]] — Gift registry; granted to NO wedding, which is how that module ships built but unreachable
- [[cire-auth]] — role gate middleware; ordering of role vs entitlement vs rate-limit gates
