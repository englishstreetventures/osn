---
"@osn/api": patch
---

CI: auto-deploy osn-api to production. Add a `deploy-osn-api` job to
`.github/workflows/deploy.yml` (mirrors `deploy-cire-api`): on merge to `main` it
applies the prod osn D1 migrations (`wrangler d1 migrations apply osn-db-prod
--remote --env production`) then deploys the Worker (`wrangler deploy --env
production`) against the already-set out-of-band secrets.

Removes the last manual production deploy step. osn-api has been a deployed
Cloudflare Worker (workerd + Upstash + native rate-limiters) since the 2026-06
cutover, so the old "gated until the ioredis→Workers-Redis swap" reason in the
`deploy.yml` stub was stale. Merging this PR runs the job, which also picks up the
domain-reshuffle `OSN_ORIGIN`/`OSN_CORS_ORIGIN` (`host.cireweddings.com`) already
on `main`. As with cire-api, osn's D1 migrations now auto-apply on merge.
