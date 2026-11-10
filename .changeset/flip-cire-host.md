---
"@shared/infra": patch
---

Cire host serves from its Worker: `PRODUCTION_SITE_MODES.cire_host` is `worker`, so the cire production stack declares `host.cireweddings.com` on the `cire-host` Worker and the release workflow records the site with `record-cire-host` in place of its Pages job. The domain moves in a release dispatched with `flip: cire_host`. Until then every release whose surfaces name a cire site or are empty, the daily run included, ships the cire stack and fails its precheck, which stops every job of that release.
