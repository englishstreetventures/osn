---
"@tools/e2e": patch
---

The E2E stack gives osn-api, pulse-api and cire-api one `OSN_ARC_KID_SECRET`, so the account deletion and export flows run with every app checking osn-api's key ids under it.
