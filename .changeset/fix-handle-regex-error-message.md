---
"@osn/ui": patch
---

Fix Register form showing "1–30 chars…" format error when the OSN handle availability check fails for network/server reasons. The local regex check already runs before the fetch, so any thrown error from `checkHandle` is by definition not a format problem; it now surfaces as a distinct "Couldn't check availability — try again" message instead of misleadingly blaming the user's input.
