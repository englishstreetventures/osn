---
"@cire/api": patch
---

Stop suppressing `no-await-in-loop` where the awaits do not actually need to be sequential.

`commitBatch`, `commitGroupedBatches` and `commitGroupedBatchesReturning` in `cire/api/src/db/index.ts`, and `commitWriteSet` in `cire/api/src/services/import.ts`, each ran their statements in a `for`/`await` loop under a disable comment. The ordering those loops rely on is real — the statement lists are built children-first so a foreign key never dangles — so `Promise.all` is not available, but a promise chain expresses the same ordering without silencing the rule. The chunking logic the two grouped-batch helpers had each written for themselves is now one `chunkGroups` function, so they cannot drift apart.

The R2 cleanup fallback in `cire/api/src/services/r2-cleanup.ts` deleted keys one round trip at a time; those deletes are independent and the chunk is already bounded, so they now go out together.

No behaviour change. The disables that remain in cire sit on loops that are sequential by nature — redirect hops that each follow the last one's Location header, a clock-bounded poll, and an image picker with a deliberate cap that must not resolve candidates it will never reach — and each one now says so.
