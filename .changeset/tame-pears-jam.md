---
"@osn/api": patch
"@shared/db-utils": patch
---

Stop suppressing `no-await-in-loop` where the awaits do not actually need to be sequential.

`commitBatch` in `@shared/db-utils` chains its bun:sqlite fallback statements instead of looping over them, keeping the children-first ordering the caller built without disabling the rule.

In `@osn/api`, the outbound ARC key registration in `outbound-arc.ts` registered with each downstream one after the next; the downstreams are independent and registration is an idempotent upsert, so both calls now go out together and a failure on a configured stack still aborts boot. The NDJSON fan-out in `account-export.ts` reads its response with `for await` rather than a manual reader loop, which also means abandoning the generator cancels the stream instead of leaving the downstream sending a bundle nobody is reading.

No behaviour change. The one remaining disable is the keyset pagination generator, where each page's cursor comes from the page before it.
