---
"@cire/api": patch
---

Enable Cloudflare Workers observability on cire-api: add `[observability]`
(`enabled = true`, `head_sampling_rate = 1`) and mirror it into
`[env.production.observability]` (named environments do not inherit the
top-level block), so Workers Logs + invocation records persist for 7 days and
show in the Cloudflare dashboard. No app-code change. Validated with
`wrangler deploy --env production --dry-run`.
</content>
</invoke>
