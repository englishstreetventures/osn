---
"@cire/host": patch
"@cire/invites": patch
"@tools/e2e": patch
---

Move `playwright` from 1.62.1 to 1.64.1 in `@cire/host` and `@cire/invites`,
and `@playwright/test` from 1.62.1 to 1.64.1 in `@tools/e2e`. The browser-test
tier and the E2E suite both drive Chromium 156.0.8078.4 (revision 1248).
