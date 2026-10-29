---
"@shared/infra": patch
---

Alchemy uploads every asset with the content type Wrangler gives it. The repository's alchemy patch now types a file by mime 4.0.7, as Wrangler and Miniflare do, adds `; charset=utf-8` to a text type without one, and uploads a name with no known extension as `application/null`, which Cloudflare serves with no Content-Type. `.ico` uploads as `image/vnd.microsoft.icon` and `.sql` as `application/sql`.

The upload type is part of each file's manifest hash, so a file whose type changes uploads again. Every Alchemy asset Worker re-uploads its assets once on its next deploy, on both tiers.

`tests/assets-content-type.test.ts` checks both of alchemy's copies against mime 4.0.7, now a dev dependency, for every extension the Alchemy sites serve, and checks that the wrangler the guest site deploys with still bundles that mime and the charset rule.
