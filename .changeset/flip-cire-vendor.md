---
"@shared/infra": patch
---

Cire vendor serves from its Worker: `PRODUCTION_SITE_MODES.cire_vendor` is `worker`, so the cire production stack declares `vendor.cireweddings.com` on the `cire-vendor` Worker and the release workflow records the site with `record-cire-vendor` in place of its Pages job. The domain moves in a release dispatched with `flip: cire_vendor`. Until then every release whose surfaces name a cire site or are empty, the daily run included, ships the cire stack and fails its precheck, which stops every job of that release.
