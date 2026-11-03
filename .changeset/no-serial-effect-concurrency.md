---
"@tools/oxlint-house": patch
---

Add the `no-serial-effect-concurrency` house rule: `{ concurrency: 1 }` in shipped source is an error unless suppressed with a reason.
