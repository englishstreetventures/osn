---
"@cire/infra": minor
---

The cire stack declares a site whose production host `PRODUCTION_HOST_HOLDS` holds with no custom domain, keeping its Worker and build. `PRODUCTION_SITE_DOMAINS` is the host the production declaration gives each cire site's Worker, which `plan:guard` hands the guard in place of the site logical ids. A site is `off` or `worker`; the `staged` mode and its spare hosts are gone.
