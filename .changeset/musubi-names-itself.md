---
"@musubi/social": patch
"@musubi/landing": patch
"@osn/auth-ui": patch
"@osn/client": patch
"@osn/api": patch
"@shared/email": patch
---

Musubi stops calling itself "OSN" where its users can see it. The tab title, the wordmark, the Settings and Connections subtitles, the Connected apps panel and the consent screen now say Musubi, and a first-party app's badge on the consent screen reads "Verified by Musubi".

`@shared/email`: the twelve account emails osn-api sends (sign-up, step-up, recovery and email-change codes, and the security notices) take the identity instance's name as `instanceName` in their data and escape it in HTML, so the package names no product of its own. Every send of those templates must now pass it.

`@osn/api`: `AuthConfig` gains `instanceName`, set to "Musubi" in `build-deps.ts` until it becomes a setting, and osn-api passes it to every account email. The account-export download is named after it (`musubi-account-export.ndjson`). The `age_restricted` response's message no longer names a product.

`@osn/auth-ui`: `RecoveryCodesView` takes a required `productName` prop and saves the codes as `<product>-recovery-codes.txt`; `recoveryCodesFileName()` is exported.

`@osn/client`: a network failure on the authorize flow reads "Could not reach the server" instead of naming OSN.

`@musubi/landing`: the README and code comments call the site Musubi's. No rendered change.
