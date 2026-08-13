---
"@cire/db": patch
"@cire/api": patch
"@cire/host": patch
---

Gift registry — schema, entitlement gate and organiser API (PR 1 of 5).

The registry is the couple's gift list, the households that claim from it, and
the gift log they write thank-yous from. It ships **built but locked**: a new
`registry` entitlement key gates every route and is granted to no wedding, so
each organiser endpoint answers 402 `payment_required` today and nothing changes
for any existing wedding. Unlocking it for one wedding is a single comp-grant
row, not a deploy.

Migration 0057 adds `registry_settings` (one row per wedding — published state,
the couple's note, shipping address, and the Stripe Connect account fields the
Connect PR will populate), `registry_items`, `registry_claims`, and
`registry_contributions`, plus the four `registry_*` copy columns on
`wedding_invite_customisations` for the guest-facing section. All nullable or
defaulted, so every pre-0057 row reads exactly as it does today.

Two things worth calling out in the service:

**Claiming is one statement.** Two guests clicking the last item at the same
moment is the ordinary case for a registry, not an edge case, and SQLite has no
row lock a read-then-write can rely on. The remaining-quantity check lives in the
INSERT's `WHERE`, so an over-subscribing claim writes zero rows and fails
`ItemFullyClaimed` instead. Success is decided by `RETURNING`, not by re-reading
the (item, household) pair — a household that had released the item still has a
row there, so the re-read would report success for a claim the guard refused.

**Money is dual-sided.** The wedding has one primary currency and everything the
organiser authors is denominated in it (`registry_items` has no currency column
on purpose). A contribution stores the amount as given *and* its
primary-currency equivalent, each snapshotted once, so the host reads the
as-given figure with the primary underneath and the gift log never re-values
itself as rates move. Totals sum only the primary side and are labelled
approximate.

Also fixes a latent bug in `@cire/host`'s shared money formatter: it divided
every amount by 100, which is right for AUD and wrong by 100× for JPY (no minor
unit) and 10× for the three-decimal currencies. It now reads each currency's real
minor-unit exponent off the formatter it already builds, so no extra
`Intl.NumberFormat` is constructed. `BudgetView` and `VendorsView` each carried
their own copy of that `/ 100` formatter, built fresh per `<For>` row; both now
delegate to the shared memoised one.
