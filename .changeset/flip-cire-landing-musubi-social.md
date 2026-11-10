---
"@shared/infra": patch
---

Cire landing and musubi social serve from their Workers: `PRODUCTION_SITE_MODES.cire_landing` and `.osn_social` are `worker`, so the cire production stack declares the apex `cireweddings.com` on the `cire-landing` Worker and the musubi stack the apex `musubi.social` on the `osn-social` Worker, and the release workflow records each site with `record-cire-landing` and `record-osn-social` in place of its Pages job. No site is staged any more. Each domain moves in its own release, dispatched with `flip: cire_landing`, then `flip: osn_social`. Until a stack's flip has run, every release that ships that stack, the daily run included, fails its precheck, which stops every job of that release.
