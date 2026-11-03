---
"@tools/oxlint-house": patch
---

Add the `no-sequential-independent-await` house rule: two adjacent awaited reads in shipped source where the second ignores the first's result are an error.
