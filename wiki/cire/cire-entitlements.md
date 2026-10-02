---
title: Cire plan tiers
aliases:
  - cire tiers
  - plan tiers
  - Ivory Gold Crimson
tags: [systems, cire, entitlements, tiers, phase1]
related:
  - "[[cire-upgrades]]"
  - "[[cire-auth]]"
  - "[[cire-budget]]"
  - "[[cire-checklist-tasks]]"
  - "[[cire-registry]]"
  - "[[cire-vendors]]"
  - "[[cire-plus-ones]]"
  - "[[cire-invite-designs]]"
  - "[[cire-host-portal-layout]]"
last-reviewed: 2026-10-02
---
# Plan tiers — what a wedding has paid for

Every wedding is on exactly one plan tier, stored on the wedding row itself as
`weddings.tier`. The tier decides which portal modules open and how many guests
the wedding may hold. The API enforces it, a 402 from a tier gate, and the
organiser portal reads the same rule only so it never offers a module the API
would refuse.

## The tiers

The list is ranked lowest first, and the order **is** the ranking:
`tierAtLeast(held, min)` compares positions, so a higher tier includes
everything a lower one does.

| Tier | Price | Opens | Guest cap |
|---|---|---|---|
| `ivory` | free | The invite and its design, events, the guest list, RSVPs, import, settings, co-hosts | 100 |
| `gold` | paid | Everything in Ivory, plus the budget, the checklist and the gift registry | 500 |
| `crimson` | paid | Everything in Gold, plus vendors (the CRM, the directory and enquiries) and every premium invite design | 1,000 |

`cire/api/src/services/tiers.ts` is the authority (`TIERS`, `tierAtLeast`,
`TIER_GUEST_CAP`). `cire/host/src/lib/tiers.ts` mirrors the list and the
ranking for the portal, and `cire/host/tests/lib/tiers.test.ts` pins the order.
On both sides a stored value that is not a known tier reads as `ivory`
(`normaliseTier`, `tierOf`), the tier that opens nothing paid, so an unknown
string can never unlock a module.

What a tier costs is not in this repository: each paid tier is a Stripe Price
configured per deployment — see [[cire-upgrades]].

---

## Database

### `weddings` — the tier itself (migration 0073)

| Column | Type | Notes |
|---|---|---|
| `tier` | `text NOT NULL DEFAULT 'ivory'` | `ivory` \| `gold` \| `crimson` |
| `tier_source` | `text` | How the wedding reached its tier: `purchase`, `comp` or `migration`. NULL on a wedding that has never left Ivory |
| `tier_granted_by` | `text` | `stripe:<purchase id>` for a purchase (the buyer is on that purchase row), `script:<operator>` for a comp. NULL on a migrated wedding |

There is no guest-cap column: the cap is derived from the tier, so the two
cannot drift.

**A tier only ever moves up on its own.** The grant is one conditional
`UPDATE … WHERE id = ? AND tier IN (<tiers below the target>)`
(`tierGrantStatement` in `tiers.ts`), so a wedding already on the target or
above it is left alone, with its attribution. A replayed webhook, or a late
one for a Gold purchase on a wedding that has since reached Crimson, changes
nothing. Lowering a tier — after a refund — is a deliberate operator act with
`grant-tier.ts --lower` (below); nothing lowers a tier automatically. A
purchase priced as an upgrade from a tier adds one condition: its grant matches
only while the wedding still holds that tier, so a from-Gold Crimson paid after
the wedding was lowered to Ivory raises nothing ([[cire-upgrades]]).

Migration 0073 lifted every wedding whose legacy entitlement rows had already
paid for more: `vendors` or `capacity_1000` to Crimson, then `registry` or
`capacity_500` to Gold, each with `tier_source = 'migration'`.

### `wedding_entitlements` — one-off capabilities

A row-presence table: a row `(wedding_id, entitlement)` means the wedding holds
that one-off capability. Primary key `(wedding_id, entitlement)`; `source` is
`purchase` or `comp`; `provider_ref` carries the provider reference on a
purchase.

**The only key the API reads is `premium_templates`.** A wedding below Crimson
may hold it as a one-off; Crimson includes every premium design anyway.
`tierService.hasPremiumTemplates` answers "Crimson, or the row". The invite
design route hands it the tier `weddingEditor` already read, so a Crimson
wedding costs no statement and one below Crimson only the primary-key probe of
its row; called without a tier it reads both in one statement.
`premiumTemplateHolders` reads the key for the wedding list. It
is comp-only: nothing sells it today, and every design is free while the
premium designs are dormant ([[cire-invite-designs]]).

The other keys in the enum (`vendors`, `registry`, `capacity_500`,
`capacity_1000`, `ai`) are what 0073 read to set each wedding's tier. Their rows
are still in the table and nothing reads them. englishstventures/osn#1315
deletes them and narrows the enum once the tier release is deployed.

---

## The tier gate — `weddingTier(db, min)`

`cire/api/src/middleware/wedding-tier.ts`. An Elysia plugin (scoped derive plus
`onBeforeHandle`) mounted per route group:

```
osnAuth()                                  ← verifies the OSN access JWT (401)
weddingMember / Editor / Owner / RunSheet  ← role gate (403)
weddingTier(db, "gold" | "crimson")        ← tier gate (402)
rate limiter                               ← 429
```

**402 response contract:**

```json
{ "error": "payment_required", "tier": "gold" }
```

`tier` is the tier the route needs, which is what the portal's upgrade offer
names. A 402 means the caller's role is enough and the wedding's tier is not.

**It costs no query.** Every role gate already selects the wedding row to
authorise the caller; it selects `weddings.tier` in the same statement and
parks it on the context as `weddingTier`. The tier gate reads that
(`readWeddingTier` in `middleware/upstream-context.ts`). Mounted standalone —
which only tests do — it reads the tier itself with `tierService.tierOf`, and a
read that fails denies, logging a warning that names the wedding.

**It reads nothing when the role gate has refused.** A role gate parks its
refusal as `weddingGateError`, and the tier derive returns at once when it
finds one, so a stranger's request never reaches a tier read, and the status
order stays 401, then 403, then 402. A missing `weddingId` (the role gate has
already validated it) degrades to the 402 rather than throwing.

### Where it is mounted

| Tier | File | Mounts | Covers |
|---|---|---|---|
| Gold | `routes/budget.ts` | 3 | Every `/budget/*` route, reads included ([[cire-budget]]) |
| Gold | `routes/tasks.ts` | 2 | Every `/tasks/*` route, reads included ([[cire-checklist-tasks]]) |
| Gold | `routes/registry.ts` | 6 | The organiser registry, its link preview and the preview's thumbnails ([[cire-registry]]) |
| Gold | `routes/registry-stripe.ts` | 1 | Connect onboarding for gift payouts |
| Crimson | `routes/vendors.ts` | 2 | The vendor CRM ([[cire-vendors]]) |
| Crimson | `routes/vendor-directory.ts` | 2 | Directory browse and add |
| Crimson | `routes/organiser-enquiries.ts` | 2 | The couple's side of enquiries |

`cire/api/tests/routes/tier-gate-pairing.test.ts` parses every file under
`cire/api/src/` and fails when a `weddingTier(` mount is not directly behind a
`weddingMember`, `weddingEditor`, `weddingOwner` or `weddingRunSheet` mount, or
when its tier is not the string literal `"gold"` or `"crimson"`. It also pins
the table above — which files mount the gate and how many times — so a new
gated route, or one that loses its gate, changes that list on purpose.

The guest side of the registry checks Gold inside the one statement that
resolves the wedding from its slug (`services/registry.ts`). A wedding below
Gold gets the same 404 as an unknown slug or an unpublished registry, so the
guest surface never tells a caller which of those it is.

### Ungated on purpose

| Route | Why |
|---|---|
| The upgrade routes (`/upgrade/*`) | Gating the route that sells a tier on that tier is a 402 loop ([[cire-upgrades]]) |
| `GET …/gifts.csv` | The couple's own record of gifts; they can take it away whatever tier the wedding is on ([[cire-registry]]) |
| `GET …/budget.csv`, `GET …/tasks.csv` | The budget lines, payments and tasks the couple entered; they can take them away whatever tier the wedding is on ([[cire-budget]], [[cire-checklist-tasks]]) |
| `GET …/module-rows` | How many rows `budget.csv`, `tasks.csv` and `gifts.csv` would carry (`{ budgetLines, tasks, gifts }`), so a locked card offers a download only when there is something in it |
| `PUT …/settings` with `budgetTotalMinor` | A single number written by onboarding, not the budget module ([[cire-budget]]) |

A wedding whose tier no longer includes a module keeps that module's rows; it
cannot read them through the module until it is back on the tier. The budget
and the checklist hand them back as CSV instead, through the three routes
above: owner only, in the per-user-limited export group
(`createOrganiserExportRoutes` in `cire/api/src/routes/organiser-weddings.ts`),
like every CSV export. `cire/api/tests/routes/organiser-weddings.test.ts`
downloads both files for an Ivory wedding whose module reads answer 402, so a
tier gate added to that group fails it.

---

## Guest cap

| Tier | Cap (`TIER_GUEST_CAP`) |
|---|---|
| `ivory` | 100 (`BASE_GUEST_CAP`, the floor) |
| `gold` | 500 |
| `crimson` | 1,000 |

The cap counts real guests: the synthetic host-preview family is excluded, and
a named plus-one counts ([[cire-plus-ones]]). It is enforced in four places,
each reading the tier rather than a stored number:

- **`tierService.assertGuestCapacity(weddingId, incoming, precomputedCap?)`**
  reads the tier and counts real guests in one statement, and fails with
  `CapacityExceeded { limit, current, requiredTier }` when the write would pass
  the cap. `requiredTier` is
  the lowest tier whose cap holds the result (`tierForGuests`), or `null` when
  even Crimson's would not. `precomputedCap` only ever skips re-reading the
  tier, never the check.
- **The import preview** (`diffAgainstDb` in `services/import.ts`) warns when an
  import would pass the cap. It reads the tier on the wedding row it already
  reads for the claim-code style, so the cap costs no statement of its own. It
  leaves the cap unset while existing guests plus creates come to at most
  `BASE_GUEST_CAP` — no tier could make that import breach — and otherwise
  carries it on the plan as `derivedCap`, which `applyImport` hands to
  `assertGuestCapacity` in the same request. A missing `derivedCap` is never
  treated as "no cap". `applyImport` checks the net delta
  (`creates − removes`) before writing anything, so a refused import writes
  nothing.
- **Naming a plus-one** checks the cap inside its `INSERT … SELECT`:
  `roomForOneMoreGuest` compares the real-guest count with a scalar subquery
  that reads the wedding's tier as a `CASE`. D1 runs batches one at a time, so
  two namings racing for the last place cannot both win.
- **The plus-one context read** (`readGuestContext` in `services/plus-one.ts`)
  selects the tier in its one statement and derives the cap with `capForTier`.

**402 from the change routes** (`routes/organiser-changes.ts`, which carry
imports and editor saves):

```json
{ "error": "payment_required", "entitlement": "capacity", "tier": "gold", "limit": 100, "current": 140 }
```

`tier` is `requiredTier` — the portal names it in the import error ("upgrade
to Gold") and says plainly when it is `null`. `entitlement: "capacity"` stays
for a portal build that reads it, until englishstventures/osn#1315. Naming a
plus-one past the cap answers `409 guest_capacity` instead.

---

## The wedding list

`GET /api/organiser/weddings` returns, per wedding, `tier`, `guestCap` (the
tier's cap) and `entitlements`. Until englishstventures/osn#1315,
`entitlements` carries the legacy keys the tier stands for
(`legacyEntitlementKeys`): Gold → `registry`, `capacity_500`; Crimson →
`vendors`, `registry`, `capacity_1000`, `premium_templates`; plus
`premium_templates` wherever that row is held. A portal build that locks by key
then locks exactly what the tier leaves locked. `POST /weddings` answers a new
wedding with `tier: "ivory"`, `entitlements: []`, `guestCap: 100`.

## The portal

`isModuleLocked(id, tier)` (`cire/host/src/lib/module-nav.ts`) is the one
predicate every surface uses: each `MODULE_NAV` entry with a `lock` names its
`tier` — Checklist, Budget and Registry `gold`, Vendors `crimson`.

- **`tierOf(summary)`** (`cire/host/src/lib/tiers.ts`) reads the list's `tier`.
  With no `tier` at all the list came from an API that predates tiers, and the
  legacy keys stand in for it with the same mapping 0073 used
  (`legacyTierFromEntitlements`), so a portal deployed ahead of its API locks
  nothing the couple paid for. The fallback goes with englishstventures/osn#1315.
- **`ModuleShell`** coerces a locked module to Overview: a deep link or a stale
  hash lands on a real view, and a locked module's panel never mounts.
- **The rail and the sheet** keep a locked row visible but faded. Its accessible
  name and its popover name the tier that includes it ("Included with Gold");
  the popover's **Upgrade to Gold** button opens the purchase dialog
  ([[cire-upgrades]]). For an owner, the Budget, Checklist and Registry
  popovers also offer the rows the wedding holds there: they ask `GET …/module-rows` when
  first opened (cached per wedding in `cire/host/src/lib/module-rows-store.ts`)
  and show **Download as CSV** when the module holds rows, or when the count
  could not be read. `LOCKED_EXPORTS` in `cire/host/src/lib/locked-exports.ts`
  maps each module to its file. See [[cire-host-portal-layout]].
- **Overview** shows no card for a locked module and makes no read for it:
  `/tasks`, `/budget` and `/vendors` answer 402 below their tier, and a refused
  tasks read would reject the whole snapshot and blank the guest and event
  counts with it. `cire/host/tests/components/Overview.test.tsx` answers those
  routes 402 and pins that an Ivory wedding's counts survive and none of them
  is requested.
- **The command palette** offers no row for a locked module.
- **Premium designs** lock by `premium_templates` in the list's `entitlements`,
  which Crimson includes; the API answers `403 premium_design` regardless.

---

## Changing a wedding's tier by hand

`cire/api/scripts/grant-tier.ts` is an operator tool, not a network route. It
validates its arguments and prints the SQL rather than running it:

```bash
# Raise only — a wedding already on the tier or above it is untouched:
bun run cire/api/scripts/grant-tier.ts <weddingId> <gold|crimson> <operator>
# Set outright — how a refund takes a wedding back down:
bun run cire/api/scripts/grant-tier.ts <weddingId> <ivory|gold|crimson> <operator> --lower
```

Every change records `tier_source = 'comp'` and
`tier_granted_by = 'script:<operator>'`.

`--lower` prints two statements, one per line, and both must be applied in the
same `--command`. The first marks the wedding's `succeeded` purchases of
anything above the new tier `refunded`; the second lowers the tier. The
webhook grants nothing for a `refunded` purchase, so the refund holds when
Stripe redelivers the original payment or an operator resends it from the
dashboard, and marking first means a delivery landing between the two
statements already finds the purchase refunded. Setting Crimson, or raising
without `--lower`, prints one statement and refunds nothing.

> [!warning]
> A production D1 write needs explicit human authorisation naming `cire-db`.
> Get it before applying the printed SQL with
> `wrangler d1 execute cire-db --env production --remote --command "<printed SQL>"`
> from `cire/api`, naming the env as every production D1 command in
> [[production-deploy]] does.

## How a wedding reaches a tier

| Path | `tier_source` | `tier_granted_by` | Who |
|---|---|---|---|
| Self-serve purchase | `purchase` | `stripe:<purchase id>` | Any **owner** of the wedding, from the portal — [[cire-upgrades]] |
| Comp, or a refund lowering it | `comp` | `script:<operator>` | An operator, with `grant-tier.ts` |
| The tier migration | `migration` | NULL | Migration 0073, from legacy entitlement rows |

The tier is one value per wedding, so it cannot hold purchase history: the money
side lives in `wedding_upgrade_purchases` and `platform_sales`
([[cire-upgrades]]). Refunds do not lower a tier automatically; the customer
wording for that is englishstventures/osn#1317.

## Deploying a change to tiers

The portal and the API deploy in separate jobs. In production, approve
`deploy-cire-host` **before** `deploy-cire-api`: the new portal reads either
list shape, while the old portal on the new API would request `/tasks` for an
Ivory wedding, get a 402 and blank its Overview. The order and the pre-flight
queries are in [[production-deploy]] §5.6.

## Observability

| Signal | Shape |
|---|---|
| `cire.tier.gate.payment_required` | Counter, `required_tier`: `gold` \| `crimson` |
| `cire.tier.gate payment required` | Warning log, `{ weddingId, requiredTier, tier }` |
| Spans | `cire.tier.tierOf`, `cire.tier.grant`, `cire.tier.hasPremiumTemplates`, `cire.tier.premiumTemplateHolders`, `cire.tier.assertGuestCapacity` |

A rise in `payment_required` on a tier nobody is being offered usually means a
portal build and an API build disagree about which modules a tier opens.

## Related

- [[cire-upgrades]] — buying a tier: catalogue, checkout, the webhook that grants
- [[cire-auth]] — the role gates the tier gate sits behind
- [[cire-host-portal-layout]] — the locked nav row and its popover
- [[cire-budget]], [[cire-checklist-tasks]], [[cire-registry]] — the Gold modules
- [[cire-vendors]] — the Crimson module
- [[cire-plus-ones]] — the cap check inside a plus-one insert
