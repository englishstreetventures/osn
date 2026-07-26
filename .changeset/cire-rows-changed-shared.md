---
"@cire/api": patch
---

Drop the three local copies of the rows-affected helper and read
`rowsChanged` from `@shared/db-utils` instead.

`session.ts`, `retention.ts` and `directory.ts` each carried their own version
of the same function — one of them declared inside an `Effect.gen` body. They
all guard compare-and-swap writes, where the wrong read inverts the gate: a
successful write reads as "nothing changed". `@osn/api` had exactly that bug in
production. One shared helper means the next package to write a CAS has
somewhere to reach for, and a driver shape added later is added once.

No behaviour change — the shared helper reads the same three shapes the copies
did.
