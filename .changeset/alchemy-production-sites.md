---
"@shared/infra": minor
"@musubi/infra": minor
"@pulse/infra": patch
"@zap/infra": patch
---

The musubi stack runs on production, declaring its sites alone: musubi landing on `www.musubi.social`, and musubi social staged on `next.musubi.social` while Pages keeps `musubi.social`. `@shared/infra` gains the production sites switch (`PRODUCTION_SITE_MODES`, `PRODUCTION_HOSTS`, `PRODUCTION_STAGING_HOSTS`, `hostsFor()`), the plan guard (`parsePlan()`, `planTextFaults()`, `guardPlan()`, `runPlanGuardCli()`), `assertProductionScope()`, and the `production-hosts` command; `plan-summary` also warns, without failing, at each fault the guard would refuse in a plan's text. `assertDevDeployTarget()` becomes `assertDeployTarget()` and no longer refuses production; `apiWorkerProps()`, `retainedD1Props()` and `retainedBucketProps()` refuse a production resource not in `PRODUCTION_ADOPTIONS`, which is empty. The pulse and zap stacks still refuse production. `CLOUDFLARE_PAGES_DNS_TOKEN` joins the production Environment's required credentials.
