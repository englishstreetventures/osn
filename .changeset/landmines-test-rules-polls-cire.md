---
"@cire/host": patch
"@cire/invites": patch
"@cire/waves": patch
"@tools/e2e": patch
---

Tests that polled a spy or a recorder now await the event itself: `claim-code` and `BudgetView`'s per-head mount await a promise their mock resolves when called, then check the call count once; the Gilded wave's deadline test awaits the frame request and moves fake time 50 ms on, as before; the cire nav flow arms `page.waitForEvent("dialog")` before the click that prompts. No shipped code changes.
