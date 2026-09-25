---
"@cire/api": patch
---

Add `scripts/d1-latency-probe.ts`, which times what the first D1 query of a
request costs on the dev tier: `GET /api/claim/session` with no cookie against
the same request with an unknown `cire_session` cookie, which adds one `SELECT`.
It reads the dev origin and the limiter budget from `wrangler.toml` and reports
p10/p50/p90, the Cloudflare colo and the runner's region. The
`cire-d1-latency-probe.yml` workflow runs it on demand from a GitHub-hosted
runner. No Worker code changes; the session constraint stays `first-primary`.
