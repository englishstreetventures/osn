---
"@cire/api": patch
"@cire/host": patch
---

Test the organiser portal's restore handlers and the local dev owner-seat
repoint.

`@cire/host`: the `OrganiserApp` suite now drives `onRestored` and
`onRestoreExpired`. It checks that a restore opens the wedding, empties the
restorable list and says so; that a stale read after a restore is shown as
answered; that a session lapsing during the refetch sends the organiser to
sign-in; that a refused or failed refetch changes nothing; and that a wedding
past its restore window leaves the list on its own. The suite's `afterEach` now
lets Kobalte's queued `aria-hidden` writes run, so no test depends on its
position in the file. No app code changes.

`@cire/api`: the local dev server's owner-seat repoint moves out of `local.ts`
into `repointDevOwnerSeat` in `src/db/setup.ts`, with the same two statements,
and gains tests for a profile with no seat, one already holding a co-host seat,
seats on other weddings, the dev id itself and a demoted owner seat, plus a
check that the seed script's SQL copy leaves the same table. Only the local dev
server calls it; the deployed Worker is unchanged.
