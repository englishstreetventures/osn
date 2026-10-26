---
"@tools/e2e": patch
---

The end-to-end suite runs the cire seating chart in the organiser portal. `CIRE_E2E_ORGANISER=1` adds a sixth Gold wedding, `CIRE_ORGANISER.seating`: a reception whose one plan, in use, seats three guests, and an after party with no plan. The `cire-seating` flow reads the reception's plan in use, adds the after party's first table, which makes that event's one plan, seats a guest there, and downloads the venue file, checking the rows cire-api holds after each step. It is the sixth organiser sign-in; `tests/flows.test.ts` now allows six, which spend 12 of cire-api's 15 OIDC redirect legs a minute.
