---
"@shared/infra": minor
"@musubi/infra": minor
"@musubi/social": patch
---

A production host can be held off its site's Worker in code. `PRODUCTION_HOST_HOLDS` in `shared/infra/src/production-sites.ts` lists each held host with its site and a one-line reason; the stacks declare a held site's Worker with no custom domain, and the plan guard refuses any plan in which a site Worker would serve a held host, whether it gains the host or holds it already. The guard now reads the host each product's declaration gives its site Workers (`PRODUCTION_SITE_DOMAINS`, passed as `declared` to `runPlanGuardCli`, which no longer takes `sites` or `modes`), refuses every host a Worker would give up, and lists the stack's held hosts in its run summary.

A site is `off` or `worker`: the `staged` mode goes with `PRODUCTION_STAGING_HOSTS`, `PAGES_PROJECTS`, `SiteModeError` and the spare-host allowance in `domainRefusals`. `cireProductionSites` and `musubiProductionSites` take `holds`, and `siteDomain` takes them as a third argument. `@musubi/social` drops its redirect off `osn-social.pages.dev`, which no host serving its bundle can reach, so its built CSP hashes one inline script.
