---
"@shared/observability": patch
---

Check the annotation key against the redaction deny-list, not just the value.

`redact()` matches the deny-list against an object's keys. The redacting logger
mapped over each annotation value and discarded the key `HashMap.map` supplies
as its second argument, so a bare scalar arrived with no key attached and passed
straight through. Nested values were still scrubbed; only top-level annotation
keys escaped.

No call site annotates a deny-listed key today, so nothing was leaking — but the
control did not work, and the first `Effect.annotateLogs({ accessToken })` would
have written the token in clear with nothing to catch it.

Replaces the layer test that was named for this and did not test it: it built the
layer into an unused variable, provided a raw capture logger with no redaction in
the chain, and asserted the annotation came through unredacted. The new one runs
the real layer, reads what reaches stdout, and is verified to fail against the
old code.
