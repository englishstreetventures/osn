---
title: Entitlements — per-wedding capability gates
tags: [systems, cire, entitlements, phase1]
related:
  - "[[vendors]]"
  - "[[cire-auth]]"
last-reviewed: 2026-07-18
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

Five opaque capability flags. Keys are stored as plain strings; the meaning is determined by how the application checks for them.

| Key | What its presence enables |
|---|---|
| `premium_templates` | Access to extended invite template designs |
| `vendors` | Vendor CRM (wedding-scoped) + Directory browse/add routes |
| `ai` | AI-assisted content generation features |
| `capacity_500` | Guest import ceiling raised to 500 |
| `capacity_1000` | Guest import ceiling raised to 1000 |

Boolean capability flags (`premium_templates`, `vendors`, `ai`) are presence-only: the row either exists or it doesn't. Capacity flags are treated differently — see below.

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
| `assertGuestCapacity` | `(weddingId, incomingNewGuests) → Effect<void, CapacityExceeded, DbService>` | Fetches the wedding's entitlement set, derives the cap, counts current (non-host) guests, fails with `CapacityExceeded { limit, current }` if the import would breach the ceiling |

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

The entitlement gate sits **after** the role gate. A viewer on an entitled wedding is already blocked by a 403 from the role gate before reaching this middleware. A `402` from this middleware means: the caller's role is sufficient, but the wedding itself does not have the capability.

**402 response contract:**

```json
{ "error": "payment_required", "entitlement": "<key>" }
```

HTTP status `402`. The organiser portal reads the `entitlement` field to display the relevant upsell UI panel.

A missing `weddingId` in `params` (should not occur after the role gate validates it) degrades to a `402` rather than throwing.

---

## Capacity enforcement in `applyImport`

`applyImport` (in `cire/api/src/services/import.ts`) calls `entitlementService.assertGuestCapacity(weddingId, netGuestDelta)` — where `netGuestDelta = guestCreates.length - guestRemoves.length` — **before** writing any rows. The check is skipped when the net delta is zero or negative (a churn import that removes K and adds K at cap succeeds). The check and the subsequent D1 batch write are sequenced atomically: if the capacity check fails, no guests are written. There are no partial writes.

The check counts real guests only — the synthetic `host`-kind family row used for invite previews is excluded from the count via a `ne(families.kind, 'host')` filter.

---

## Comp-grant CLI

`cire/api/scripts/grant-entitlement.ts` is an operator tool for manual (comp) grants. It is not a network-accessible route.

**Local run (bun:sqlite):**

```bash
bun run cire/api/scripts/grant-entitlement.ts <weddingId> <key,key,...> [grantedBy]
```

**Production (D1):** the script prints idempotent `INSERT OR IGNORE` SQL. Apply via:

```bash
wrangler d1 execute cire-db --remote --command "<printed SQL>"
```

A prod D1 write requires explicit human authorization naming `cire-db` before running — this is a deploy-time step, not an automated path.

---

## Phase-2 payment seam

`grant()` accepts `source: 'purchase'` and a `providerRef` field. A webhook skeleton (`cire/api/src/routes/payment-webhook.ts`) exists but is inert in Phase 1 — all Phase-1 grants use `source: 'comp'`. The `provider_ref` column is the idempotency anchor for Phase-2 event-driven grants. Provider selection is tracked outside this repository.

---

## Related

- [[vendors]] — Vendor CRM + Directory; both route groups gate on the `vendors` entitlement
- [[cire-auth]] — role gate middleware; ordering of role vs entitlement vs rate-limit gates
