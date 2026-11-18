---
"@tools/oxlint-house": patch
---

Tests only: nine "reports under the plugin's rule id" cases are removed, since a kept case in each file fails on every break they caught. The serial-concurrency rule keeps its case: nothing else fails when that rule throws while reporting.
