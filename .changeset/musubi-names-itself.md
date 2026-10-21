---
"@musubi/social": patch
"@musubi/landing": patch
"@osn/auth-ui": patch
"@osn/client": patch
"@osn/api": patch
"@shared/email": patch
---

Musubi stops calling itself "OSN" where its users can see it. The tab title, the wordmark, the Settings and Connections subtitles, the Connected apps panel and the consent screen now say Musubi, and a first-party app's badge on the consent screen reads "Verified by Musubi". The Terms of Service and Privacy Notice govern "your Musubi account", and both pages are dated 2026-10-17.

`@shared/email`: the twelve account emails osn-api sends (sign-up, step-up, recovery and email-change codes, and the security notices) take the identity instance's name as `instanceName` in their data and escape it in HTML, so the package names no product of its own. Every send of those templates must now pass it.

`@osn/api`: `AuthConfig` gains `instanceName`, set to "Musubi" in `build-deps.ts` until it becomes a setting, and osn-api passes it to every account email. The account-export download is named after it (`musubi-account-export.ndjson`). The `age_restricted` response's message no longer names a product. The passkey prompt and authenticator-app label say Musubi: `OSN_RP_NAME` is "Musubi" in production and local, "Musubi (dev)" and "Musubi (staging)" on those tiers, and falls back to the instance name when unset. Existing passkeys and authenticator codes keep working, since neither is checked against the name. Dev sends account email from `Musubi <hello@musubi.social>`, which needs `musubi.social` verified in Resend before it deploys; production still sends from `hello@cireweddings.com`.

`@osn/auth-ui`: `RecoveryCodesView` takes a required `productName` prop and saves the codes as `<product>-recovery-codes.txt`; `recoveryCodesFileName()` is exported.

`@osn/client`: a network failure on the authorize flow reads "Could not reach the server" instead of naming OSN.

`@musubi/landing`: the footer's "Docs" link to a source repository is gone, with the `PUBLIC_DOCS_URL` build variable that set it. The README and code comments call the site Musubi's.
