---
"@shared/infra": patch
---

The cire organiser and vendor portals stage on `next.host.cireweddings.com` and `next.vendor.cireweddings.com` (`PRODUCTION_STAGING_HOSTS`). `RETIRED_STAGING_HOSTS` lists the spare hosts a site served before its current one, and `domainRefusals()` lets a site's Worker give up one of its own without a `flip` or `unflip`, unless that host is a production host or any site's current spare host; another site's retired host is still refused. `domainRefusals()` takes the retired list as an optional third argument.
