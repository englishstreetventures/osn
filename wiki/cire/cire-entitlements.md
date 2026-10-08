---
title: Cire plan tiers
aliases:
  - cire tiers
  - plan tiers
  - Ivory Gold Crimson
  - unlock codes
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
last-reviewed: 2026-10-09
---
# Plan tiers — what a wedding has paid for

Every wedding is on exactly one plan tier, stored on the wedding row itself as
`weddings.tier`. The tier decides which portal modules open, how many guests
the wedding may hold, and how many people besides the couple may help run it.
The API enforces it, a 402 from a tier gate, and the organiser portal reads the
same rule only so it never offers a module the API would refuse.

## The tiers

The list is ranked lowest first, and the order **is** the ranking:
`tierAtLeast(held, min)` compares positions, so a higher tier includes
everything a lower one does.

| Tier | Price | Opens | Guest cap | People limit |
|---|---|---|---|---|
| `ivory` | free | The invite and its design, events, the guest list, RSVPs, import, settings, co-hosts | 100 | 6 |
| `gold` | paid | Everything in Ivory, plus the budget, the checklist and the gift registry | 500 | 15 |
| `crimson` | paid | Everything in Gold, plus vendors (the CRM, the directory and enquiries) and every premium invite design | 1,000 | 40 |

`cire/api/src/services/tiers.ts` is the authority (`TIERS`, `tierAtLeast`,
`TIER_GUEST_CAP`, `TIER_PEOPLE_LIMIT`). `cire/host/src/lib/tiers.ts` mirrors the list and the
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
| `tier_source` | `text` | How the wedding reached its tier: `purchase`, `comp`, `code` or `migration`. NULL on a wedding that has never left Ivory |
| `tier_granted_by` | `text` | `stripe:<purchase id>` for a purchase (the buyer is on that purchase row), `script:<operator>` for a comp, `code:<unlock code id>` for a code (the owner who redeemed it is on the redemption row). NULL on a migrated wedding |

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
| `POST …/unlock-code` | The route that raises a tier with a code; a gate on it would be the same loop ([[#Unlock codes]]) |
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

## People limit

How many people besides the couple a wedding may hold: 6 on Ivory, 15 on Gold,
40 on Crimson (`TIER_PEOPLE_LIMIT`).

**Who counts:** every `wedding_hosts` seat below owner — editor, viewer, helper,
the legacy `host` value and any role the code does not recognise — plus every
owner beyond the first two (`EXEMPT_OWNER_SEATS`). The first two owners are the
couple and never count; a third owner counts like a co-host, so promoting a
co-host to owner frees no place. One SQL fragment, `peopleCountSql` in
`cire/api/src/services/hosts.ts`, is the definition: every guard and every read
of the count embeds it. Claimed vendors do not count yet
(englishstventures/osn#1457).

**Where it is enforced** — inside the statement that writes, with the limit
read from the wedding's tier in the same statement (`peopleLimitSql`), so two
requests racing for the last place cannot both win. D1 runs each batch as one
transaction, one at a time. `cire/api/tests/db/d1-integration.test.ts` stages
two adds racing for the last place, and an add racing an owner's demotion.

| Write | Checked when | Refusal |
|---|---|---|
| `POST /hosts` at a role below owner | always | 409 `people_limit_reached` |
| `POST /hosts` as owner | the wedding already has two owners | 409 `people_limit_reached` |
| `PUT /hosts/:id/role`, one owner moving another below owner | the wedding has no more than two owners | 409 `people_limit_reached` |
| `PUT /hosts/:id/role`, an owner stepping down from their own seat | never: always allowed, even past the limit | — |
| Any promotion, a change between roles below owner, a removal | never: none of them raises the count | — |

The 50-seat cap (`MAX_HOSTS_PER_WEDDING`, [[cire-auth#Equal owners]]) stays as
the ceiling behind the limit. `add` can seat at most the top tier's 40 plus the
two exempt owners, so the cap binds only a wedding seeded past both, and it is
the refusal named first when both apply.

**A wedding over its limit keeps everyone.** Lowering a tier
(`grant-tier.ts --lower`) touches no seat, and an owner may step down past the
limit. Until it is back under, such a wedding can re-role its people, promote
them and remove them, but adds nothing.

**The count travels with every answer.** `GET /hosts` and the responses of
`POST`, `PUT …/role` and `DELETE /hosts/:id` carry `peopleLimit`, read in the
same statement or batch as the write, and every refusal carries the same three
fields:

```json
{ "error": "people_limit_reached", "used": 6, "limit": 6, "tier": "gold" }
```

`tier` is the lowest tier, at or above the wedding's own, with room for one
more person (`peopleLimitOf` in `tiers.ts`): the wedding's own tier while it has
room, the tier to upgrade to at the limit, and `null` when no tier has room. It
is a 409 rather than a 402 because the top tier has nothing to sell, and every
other seat refusal is a 409 too.

**The portal** holds no copy of the limits. The co-host panel
(`cire/host/src/components/HostsPanel.tsx`, read through
`cire/host/src/lib/people-limit.ts`) shows every member "4 of 6 people". At the
limit, an owner sees why and an **Upgrade to Gold** button that opens
`UpgradeDialog` in place of the add form; with only one owner, the form stays
as **Add as owner**, behind a confirmation, so the partner can still be
seated. A payload without `peopleLimit` leaves the panel as it was.

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
  name and its card name the tier that includes it ("Included with Gold");
  the card's **Upgrade to Gold** button opens the purchase dialog
  ([[cire-upgrades]]), and a press on the row (Enter included) moves focus
  straight to it. For an owner, the Budget, Checklist and Registry
  cards also offer the rows the wedding holds there: they ask `GET …/module-rows` when
  first opened (cached per wedding in `cire/host/src/lib/module-rows-store.ts`)
  and show **Download as CSV** when the module holds rows, or when the count
  could not be read. `LOCKED_EXPORTS` in `cire/host/src/lib/locked-exports.ts`
  maps each module to its file. Settings lists the same downloads for an owner
  in one place (`LockedModuleDownloads.tsx`). See [[cire-host-portal-layout]].
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

## Unlock codes

A code moves a wedding to Gold or Crimson with no payment: for friends and comps.
The platform owner mints it; any **owner** of a wedding redeems it from Settings.

### The code

A code is a recovery code in form: 16 hex characters in four groups
(`3f9a-0c1e-b7d2-48aa`), 64 bits from `generateRecoveryCode` in
`@shared/crypto/recovery`. The owner can type it in any case, with or without
the dashes or with spaces; `hashRecoveryCode` folds all of those before hashing.
Only the SHA-256 is stored, so the table holds no code as written. The hash is
unsalted over 64 bits, so whoever holds a copy of the table, or the mint SQL,
can still search for codes offline. Treat a D1 export, and the shell history
the mint SQL was applied from, as you would the codes.

### Minting

`cire/api/scripts/mint-unlock-code.ts`, an operator tool that prints rather than
writes, like `grant-tier.ts`:

```bash
bun run --cwd cire/api mint-unlock-code --tier gold --by <operator> [--uses 3] [--expires 2027-06-30]
```

| Flag | Meaning |
|---|---|
| `--tier` | `gold` or `crimson`. Never `ivory`: a code only raises |
| `--by` | The operator, recorded as `created_by = 'script:<operator>'` |
| `--uses` | How many weddings may redeem it, 1 to 1,000. Default 1 |
| `--expires` | The last day it works, through the end of that day in UTC. Left out, it never expires |

It prints two lines: `code: <code>`, to hand over, and `sql: INSERT INTO
unlock_codes …`, to apply. The SQL carries only the hash, not the code; clear
the command from shell history once it is applied, since the hash can be
searched offline (above). The code is shown once and stored nowhere: keep it
until it has been handed over.

> [!warning]
> A production D1 write needs explicit human authorisation naming `cire-db`.
> Get it before applying the printed SQL with
> `wrangler d1 execute cire-db --env production --remote --command "<printed SQL>"`
> from `cire/api`.

### Redeeming

`POST /api/organiser/weddings/:weddingId/unlock-code`, body `{ "unlockCode": "…" }`.
Behind `osnAuth()`, `weddingOwner()` and a per-organiser limiter of five tries a
minute (`unlockCodeLimiter` in `app.ts`). No tier gate. The limiter is the
in-memory one the other organiser routes use, so it counts in each Worker
isolate: it slows one caller's loop of D1 batches but does not cap an account
across isolates.

| Answer | When | The code |
|---|---|---|
| 200 `{ tier }` | The wedding is on the code's tier now | Spent |
| 404 `{ error: "unlock_code_invalid" }` | Unknown, expired, used up, or already used by this wedding | Untouched |
| 409 `{ error: "tier_already_held", tier }` | The wedding is already on the code's tier or above; `tier` is the **wedding's** | Untouched |
| 409 `{ error: "purchase_in_flight" }` | An upgrade checkout for the wedding can still be paid ([[cire-upgrades]]) | Untouched |
| 400 `Missing or invalid fields` | No code, or one longer than 64 characters | — |

Every unusable code gets the one 404, so a caller guessing codes learns nothing
about which exist. The two 409s answer only for a live code with a use left,
so they do tell someone already holding such a code that it is live, without
spending it. Finding one by guessing is out of reach whatever the limiter
does: at a million tries a second, one live code takes about 2^63 / 10^6
seconds, some 290,000 years.

**One D1 batch, one round trip** (`unlockCodeService.redeem`,
`cire/api/src/services/unlock-codes.ts`). D1 runs a batch as one transaction,
one batch at a time, so each rule is checked inside the statement that writes:

1. The redemption row, inserted from the code's row only while the code is
   unexpired, has a use left and has not been redeemed by this wedding, the
   wedding is live and on a tier below the code's (`tierRankSql`), and no
   upgrade checkout for it can still be paid (`purchaseInFlight`).
2. The code's `redeemed_count`, raised through that row.
3. The wedding's tier, `tier_source = 'code'` and `tier_granted_by`, also only
   through that row.
4. A read of the outcome, and of why nothing happened.

Of two weddings racing for a code's last use, the second batch runs after the
first, finds no use left, and writes nothing. The CHECK
`redeemed_count <= max_redemptions` would fail any batch that overspent, and
the whole batch with it. With the owner gate's own read, a redemption costs two
D1 round trips. On bun:sqlite (tests and `local.ts`) the four statements run one
at a time outside a transaction, so the atomicity holds on D1 only;
`d1-integration.test.ts` stages the race.

**An open checkout holds a code back.** The upgrade webhook grants raise-only but
records the sale regardless ([[cire-upgrades]]), so a checkout opened before a
code was redeemed and paid after it would take money for a tier the wedding
already held. A code is therefore refused with `purchase_in_flight` while a
checkout can still be paid, up to a day (`PURCHASE_SESSION_LIFETIME_S`). The
other order is already safe: the upgrade service refuses a checkout for a tier
the wedding holds.

### Tables (migration 0082)

| Table | Columns | Notes |
|---|---|---|
| `unlock_codes` | `id` (`ulc_<uuid>`), `code_hash` (unique), `tier` (`gold` \| `crimson`, CHECK), `max_redemptions`, `redeemed_count`, `expires_at` (seconds, NULL never), `created_by`, `created_at` | No foreign key, so outside the wedding cascade, like `platform_sales` |
| `unlock_code_redemptions` | `id` (`ulr_<uuid>`), `code_id`, `wedding_id`, `redeemed_by_osn_profile_id` (nullable), `redeemed_at` | Unique per (`code_id`, `wedding_id`). `ON DELETE CASCADE` from both parents |

**Why a counter rather than counting rows:** the daily purge deletes a
soft-deleted wedding with every row that hangs off it, its redemptions included.
A use counted from redemption rows would come back once the wedding that spent
it is purged; `redeemed_count` keeps it spent.
`cire/api/tests/services/wedding-purge.test.ts` pins that.

### The portal

Settings → Profile shows an owner the wedding's plan ("This wedding is on
Gold.") and, below Crimson, a **Have a code?** link that opens
`UnlockCodeDialog` (`cire/host/src/components/UnlockCodeDialog.tsx`). On
success the tier is patched into the wedding list at once, so the locked
modules open, and the list is fetched again for the guest cap
(`handleTierRaised` in `OrganiserApp.tsx`). The dialog stands on its own so the
onboarding tier step can place it under the tier cards.

## How a wedding reaches a tier

| Path | `tier_source` | `tier_granted_by` | Who |
|---|---|---|---|
| Self-serve purchase | `purchase` | `stripe:<purchase id>` | Any **owner** of the wedding, from the portal — [[cire-upgrades]] |
| Comp, or a refund lowering it | `comp` | `script:<operator>` | An operator, with `grant-tier.ts` |
| Unlock code | `code` | `code:<unlock code id>` | Any **owner**, with a code an operator minted — [[#Unlock codes]] |
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
| `cire.tier.unlock_code.redemptions` | Counter, `outcome`: `redeemed` \| `refused` \| `already_held` \| `purchase_in_flight` |
| `unlock code redeemed` | Info log, `{ weddingId, profileId, codeId, tier }` |
| `unlock code refused` | Warning log, `{ weddingId, profileId }`. Never the code or its hash; `unlockCode` is on the redaction list |
| Spans | `cire.tier.tierOf`, `cire.tier.grant`, `cire.tier.hasPremiumTemplates`, `cire.tier.premiumTemplateHolders`, `cire.tier.assertGuestCapacity`, `cire.tier.redeemUnlockCode` |
| `cire.host.added`, `cire.host.role_changed` | Counters; `result: people_limit_reached` is a write the people limit refused |
| `host add refused`, `host change refused: people limit` | Warning logs, `{ weddingId, reason: "people_limit_reached" }` |

A rise in `payment_required` on a tier nobody is being offered usually means a
portal build and an API build disagree about which modules a tier opens. A
sustained rise in unlock-code `refused` is someone guessing codes rather than
owners mistyping them; the warning log names the wedding. `people_limit_reached`
is couples meeting their limit, which is demand for the next tier rather than
abuse; the people-limit checks ride the existing `cire.host.add` and
`cire.host.setRole` spans.

## Related

- [[cire-upgrades]] — buying a tier: catalogue, checkout, the webhook that grants
- [[cire-auth]] — the role gates the tier gate sits behind
- [[cire-host-portal-layout]] — the locked nav row and its popover
- [[cire-budget]], [[cire-checklist-tasks]], [[cire-registry]] — the Gold modules
- [[cire-vendors]] — the Crimson module
- [[cire-plus-ones]] — the cap check inside a plus-one insert
