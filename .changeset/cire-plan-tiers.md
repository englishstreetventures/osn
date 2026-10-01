---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
"@cire/invite-designs": patch
---

Replace cire's per-module entitlement packs with three plan tiers per wedding
(englishstventures/osn#1300). **Ivory** is free: the invite, events, guests,
RSVPs and import, up to 100 guests. **Gold** adds the budget, the checklist and
the gift registry, up to 500. **Crimson** adds vendors (the CRM, the directory
and enquiries) and every premium invite design, up to 1,000.

- **Schema (migration 0071).** `weddings.tier` (default `ivory`) with
  `tier_source` and `tier_granted_by`, and `wedding_upgrade_purchases.from_tier`.
  The one-pending purchase index narrows to one per wedding; pending legacy
  purchases are expired between the index drop and create, and weddings are
  lifted from their legacy rows (`vendors`/`capacity_1000` to Crimson,
  `registry`/`capacity_500` to Gold). No entitlement row is deleted.
- **API.** Every role gate reads the tier from the row it already selects, and
  `weddingTier(db, "gold" | "crimson")` answers 402
  `{ error: "payment_required", tier }` behind it with no query of its own.
  Gold now gates all of `/budget/*` and `/tasks/*`, reads included, as well as
  the registry; Crimson gates vendors, the directory and enquiries. Guest caps
  come from the tier, and the capacity 402 names the tier that would hold the
  change. Premium designs need Crimson or the one-off `premium_templates`
  entitlement. The wedding list returns `tier` plus the legacy keys the tier
  stands for. `grant-tier.ts` replaces `grant-entitlement.ts`.
- **Selling tiers.** The catalogue offers only tiers above the wedding's own;
  `POST …/upgrade/session` takes `{ tier, module? }`. A pending purchase for a
  different product is expired at Stripe before a new page opens. Settle maps
  the stored product to a tier (legacy keys included), only ever raises it, and
  answers 500 on a paid purchase that names no tier so Stripe retries.
- **Portal.** Locks by tier: Checklist, Budget and Registry need Gold, Vendors
  Crimson. A locked row says which tier includes it; Overview neither reads nor
  shows a locked module, so an Ivory wedding's counts no longer blank on a 402.
  The dialog sells the lock's tier and reads "Upgrade from Gold" for the
  from-Gold price. A list with no `tier` (an older API) falls back to its
  legacy keys.

**New vars** on `cire-api` (ordinary vars, commented out in every environment
until the Stripe Prices exist; unset means not for sale):
`STRIPE_UPGRADE_PRICE_GOLD`, `STRIPE_UPGRADE_PRICE_CRIMSON` and
`STRIPE_UPGRADE_PRICE_CRIMSON_FROM_GOLD`. `STRIPE_UPGRADE_PRICE_VENDORS` and
`STRIPE_UPGRADE_PRICE_REGISTRY` are no longer read.

**Deploy order.** Approve `deploy-cire-host` before `deploy-cire-api`, in
separate reviews: the old portal on the new API would request `/tasks` for an
Ivory wedding and blank its Overview. Run the pre-flight queries in
`wiki/shared/production-deploy.md` §5.6 first.

**Follow-up.** englishstventures/osn#1315 deletes the legacy entitlement rows
(migration 0072), narrows the enums, and drops the list's legacy keys, the
capacity 402's `entitlement` field and the portal's fallback, once this release
is live.
