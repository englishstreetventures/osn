---
"@cire/api": patch
---

Issue the two independent R2 puts in `storeBeforeImage` and `storeUpload` together instead of one after the other. Both write a fixed key with no dependency on the other, so awaiting them in sequence spent two round trips where one would do. They now go through `Promise.allSettled` and the first rejection is rethrown, which keeps the existing `R2Error` behaviour while making sure a second rejection is never left unhandled in a request context.

Narrow the multi-key delete fallback in `reapR2Objects` to a synchronous throw. The array form of `delete` is a Cloudflare R2 feature that a single-key binding may not have, and the probe existed to detect that. It caught an asynchronous rejection too, so one failed multi-delete of a full chunk fanned out into up to 1000 single-key deletes against a bucket that had already refused the work. A binding that lacks the feature throws when called; a rejection means the delete itself failed, and is now counted as failed rather than retried per key.

Cover the paths none of this had tests for: a bucket rejecting a delete, a put rejecting for one key of a pair, an asynchronous array-delete rejection not falling back to per-key deletes, and the dedupe, chunking and no-op behaviour of `reapR2Objects` itself.
