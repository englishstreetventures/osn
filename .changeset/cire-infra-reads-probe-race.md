---
"@cire/infra": patch
---

The env-reads test skips the probe file the house lint test plants under cire-api's source, so the two suites no longer race in parallel CI runs.
