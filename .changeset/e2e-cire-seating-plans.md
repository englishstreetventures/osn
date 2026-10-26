---
"@tools/e2e": patch
---

The `cire-seating` flow also drives the seating plan controls: at the reception it duplicates the plan in use, moves a guest in the copy, adds a table to it, renames it, records a decline from the page, checks both plans list it for review and neither moves a seat, puts the copy in use, downloads the venue file and deletes the plan no longer in use, checking the rows cire-api holds after each step. Last, on a wedding below Gold that kept two plans (`CIRE_ORGANISER.seatingLocked`), it downloads the file Settings offers and checks it holds every plan. It still signs in once.
