---
"@cire/host": patch
---

The eight organiser caches (budget, enquiries, events, guests, households,
registry, tasks, vendors) used to null their signal the instant a mutation
invalidated them, so every edit flashed the panel empty for the length of the
background refetch. Each store now marks the wedding `stale` instead and
leaves the last-known rows on screen — a mounted view keeps rendering them
across the invalidate, and `hasCachedXxx` still reports the miss so callers
that check it behave the same as before.

The refetch a stale wedding triggers is also the re-authorization check, so a
failed or refused refetch blanks the signal and rethrows rather than leaving a
demoted organiser looking at stale rows behind an error banner. Budget's
`spentSoFar`/`upcomingPayments`, vendors' `vendorCount`, and every
`peekCachedXxx` reader are unchanged — reserved for the separate reactivity
fix tracked in #620. The four views that called their own reload helper
(Budget, Checklist, Vendors, Registry) now route `reload()` through
`ensureXxxLoaded` so they pick up the same generation-guarded success/failure
handling instead of writing the cache directly.
