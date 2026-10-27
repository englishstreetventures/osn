---
"@cire/host": patch
---

Three checklist assignment tests now build their expected "Held by" line with the same `Intl.ListFormat("en-AU")` call as `TaskHolders`, so they pass on any ICU build.
