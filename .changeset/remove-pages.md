---
"@shared/infra": patch
---

`CLOUDFLARE_PAGES_DNS_TOKEN` is retired: `RETIRED_CREDENTIALS` replaces `PAGES_DNS_CREDENTIALS`, the production Environment requires it no more, `forbiddenCredentials()` forbids it on both tiers, and `knownCredentials()` leaves it out, so no workflow may read it. The domain move rehearsal stack (`rehearsal/`, `rehearsal:deploy`, `rehearsal:destroy`) is removed with its tests.
