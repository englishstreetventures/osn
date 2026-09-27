---
title: Cire entitlements
tags: [systems, cire, entitlements, phase1]
related:
  - "[[cire-vendors]]"
  - "[[cire-registry]]"
  - "[[cire-auth]]"
  - "[[cire-upgrades]]"
last-reviewed: 2026-09-27
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
| `registry` | Gift registry module — the organiser routes and, transitively, the guest gift page and the band on the invite |

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
| `assertGuestCapacity` | `(weddingId, incomingNewGuests, precomputedCap?) → Effect<void, CapacityExceeded, DbService>` | Derives the cap (from `precomputedCap` if given, else its own narrowed entitlement query — see below), counts current (non-host) guests, fails with `CapacityExceeded { limit, current }` if the import would breach the ceiling. `precomputedCap` only ever skips the RE-DERIVATION, never the check itself |

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

HTTP status `402`. In the organiser portal a locked module has no page at all, so this response is a backstop rather than something a user normally meets: `isModuleLocked` (`cire/host/src/lib/module-nav.ts`) derives the lock from the wedding's own entitlement set, `ModuleShell` coerces a locked module back to Overview, and the module's nav row stays visible but faded and inert. Resting a pointer on that row for three seconds — or clicking it, which is the only path a touch user has — opens a popover naming the module and offering an Upgrade button. That button is live: it opens a dialog that prices the module and starts a Stripe checkout — see [[cire-upgrades]].

A missing `weddingId` in `params` (should not occur after the role gate validates it) degrades to a `402` rather than throwing.

**It does no D1 read when the role gate has already refused.** Every role gate parks its refusal on the context as `weddingGateError`; the entitlement `derive` returns immediately when it finds one. Elysia runs every `derive` before any `onBeforeHandle`, so without that check a stranger's request still paid for an entitlement query whose answer could never change the response — a free, unauthenticated read on every request to every gated route. Skipping it leaves the status ordering untouched (401, then 403 `read_only_role`, then 402 `payment_required`), which route tests pin.

**It shares a query with the role gate instead of running its own.** `weddingMember(db, key)`, `weddingEditor(db, key)` and `weddingOwner(db, key)` take the SAME entitlement key this middleware is mounted with as an optional second argument. When given, the role gate adds an `EXISTS` check against `wedding_entitlements` to the `SELECT` it already runs for the owner/host row — one extra column, not a second query. The column is `entitlementPresent()` in `cire/api/src/services/entitlements.ts`, used by both `hostsService.authorize()` (member and editor gates) and `weddingOwner()`. The gate exposes the answer as `weddingEntitlementFold` on context, and `weddingEntitlement`'s derive picks it up (`readWeddingEntitlementFold` in `upstream-context.ts`) instead of calling `entitlementService.has()` itself, provided the fold's key matches its own. A mismatch or absence — the gate mounted standalone, a role gate called with no key, or a fold query that defected and fell back to the plain role query — falls back to that separate `has()` query, so correctness never depends on the two call sites agreeing; only the saved round trip does. On a gated route an owner's request costs one query and a co-host's two.

**The two gates are always mounted as a pair.** Every `.use(weddingEntitlement(db, key))` sits directly after `.use(weddingMember | weddingEditor | weddingOwner(db, key))` with the same literal key, and a role gate never takes a key without that entitlement gate after it — on a route with no entitlement gate the fold would add the check's cost for nothing. The route files that pass a key are `vendor-directory.ts`, `vendors.ts`, `registry.ts`, `registry-stripe.ts` and `organiser-enquiries.ts`. `cire/api/tests/routes/entitlement-gate-pairing.test.ts` parses every file under `cire/api/src/` and fails on a broken pair in either direction; it also pins which files mount the gate and how many times, so a new gated route, or one that loses its gate, changes that list on purpose. `cire/api/tests/middleware/wedding-entitlement-fold.test.ts` counts `db.select()` calls on gated and ungated routes for all three role gates.

**One registry surface is ungated on purpose: the gift-log export** (`GET …/gifts.csv`). It is the couple's own record, and they must be able to take it away whether or not the wedding still holds `registry` — see [[cire-registry]]. A named test in `cire/api/tests/routes/organiser-weddings.test.ts` fails if a plain gate is added to it.

---

## Capacity enforcement in `applyImport`

`applyImport` (in `cire/api/src/services/import.ts`) calls `entitlementService.assertGuestCapacity(weddingId, netGuestDelta, plan.derivedCap)` — where `netGuestDelta = guestCreates.length - guestRemoves.length` — **before** writing any rows. `applyImport` skips the check when the net delta is zero or negative (a churn import that removes K and adds K at cap succeeds). The check and the D1 batch write that follows are sequenced atomically: if the capacity check fails, no guests are written. There are no partial writes.

The check counts real guests only — a `ne(families.kind, 'host')` filter excludes the synthetic `host`-kind family row used for invite previews. A **plus-one** is a real guest and counts: a household that names one takes a place under the organiser's cap, so naming one is refused (`409 guest_capacity`) when the wedding is full ([[cire-plus-ones]]). The diff's preview arithmetic counts plus-ones too.

**The capacity query only ever reads the two rows that can matter.** `assertGuestCapacity`'s own fallback query, and `diffAgainstDb`'s preview-warning query below, both filter `WHERE entitlement IN ('capacity_500', 'capacity_1000')` (the `CAPACITY_ENTITLEMENT_KEYS` constant in `entitlements.ts`) instead of fetching every entitlement row on the wedding — `deriveCap` only ever inspects those two keys, so a wider fetch would be pure waste. **`setsForWeddings` is NOT narrowed** — it feeds `deriveCap` in `organiser-weddings.ts` and also drives feature display (`premium_templates`/`vendors`/`ai`/`registry`), so it keeps returning the full set.

**`diffAgainstDb`'s preview warning skips its own query below a floor threshold.** The resulting guest count after any plan is `existing − removes + creates`, which can never exceed `existing + creates` (removes only ever help). Since the cap can never fall below `BASE_GUEST_CAP` (100, exported from `entitlements.ts`, the same fallback `deriveCap` returns), `diffAgainstDb` skips the entitlement query — and the warning check — entirely once the wedding's current guests (plus-ones included) plus `guestCreates.length` come to at most `BASE_GUEST_CAP`: no entitlement row on any wedding could make that import breach the cap. Above the threshold it runs the narrowed query.

**`applyImport` reuses `diffAgainstDb`'s already-derived cap instead of re-scanning.** `ImportPlan` carries an optional `derivedCap: number`, set by `diffAgainstDb` ONLY when its own preview-warning block actually ran the entitlement query (i.e. above the floor threshold, with `guestCreates.length > 0`). `applyImport` passes it straight to `assertGuestCapacity`'s `precomputedCap` parameter, which then skips its own query. `derivedCap` is absent whenever the preview never needed the real cap (below the floor threshold, or no guests were being created) — `assertGuestCapacity` MUST keep enforcing in that case by running its own (narrowed) query; a missing cap is never treated as "no cap". This composes with the floor threshold cleanly: a small import pays one query total (`applyImport`'s own, since the preview skipped its), a large one also pays one query total (the preview's, reused by `applyImport`) — never two separate scans of the same rows. Both call sites that feed `applyImport` a plan (`organiser-changes.ts` and `revert.ts`) run `diffAgainstDb` then `applyImport` in the SAME request — plan objects never cross the client boundary, so there is no TOCTOU window between the two.

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

## How a wedding gets an entitlement

Two paths, and only two.

| Path | `source` | Who runs it |
|---|---|---|
| Self-serve purchase | `purchase` | The wedding's **owner**, from the portal — see [[cire-upgrades]] |
| Comp / manual grant | `comp` | An operator, via `cire/api/scripts/grant-entitlement.ts` |

`grant()` is `onConflictDoNothing` on `(wedding_id, entitlement)`, so both paths are idempotent and neither can produce a second row. That is also why the table cannot hold purchase history: a second purchase of a key already held would be swallowed with no record that money moved. The money side lives in `wedding_upgrade_purchases` (migration 0059), and `provider_ref` on the entitlement row carries the Stripe checkout session id that bought it.

> [!note]
> `premium_templates`, `ai` and the two `capacity_*` keys are **not** purchasable. Only `vendors` and `registry` are sold self-serve; everything else is comp-only. Adding another is a catalogue entry plus a configured Stripe Price, not a schema change.

---

## Related

- [[cire-vendors]] — Vendor CRM, Directory and enquiries; all three route groups gate on the `vendors` entitlement
- [[cire-registry]] — Gift registry; purchasable self-serve, and comp-grantable
- [[cire-upgrades]] — the self-serve purchase flow: catalogue, checkout, the platform webhook that grants
- [[cire-auth]] — role gate middleware; ordering of role vs entitlement vs rate-limit gates
