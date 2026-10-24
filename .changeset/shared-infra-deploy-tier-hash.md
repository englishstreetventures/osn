---
"@shared/infra": patch
---

The workflow tests check, through `turbo run build --dry=json`, that turbo hashes `OSN_DEPLOY_TIER` into the build of the guest site, the organiser portal and the vendor portal. The `test:repo` task also reruns when a cire package's own `turbo.json` changes.
