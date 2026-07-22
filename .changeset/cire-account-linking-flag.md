---
"@cire/api": patch
---

Wire feature flags into `@cire/api` and gate OSN account linking behind
`cire.account-linking` (default OFF).

The flag provider is built once per isolate from `GROWTHBOOK_CLIENT_KEY` /
`GROWTHBOOK_API_HOST` / optional `KV_GB_PAYLOAD` and injected into the
account-link route factories (and decorated onto the Elysia context as `flags`).
`wrangler.toml` carries the `GROWTHBOOK_API_HOST` var and commented
`GROWTHBOOK_CLIENT_KEY` + `KV_GB_PAYLOAD` setup (top-level + `env.production`).

**Gate — OSN account linking.** `cire.account-linking` (default off) hides the
guest "Link your Pulse account" surface: `GET`/`POST /api/account/link` answer
503 ("disabled") when the flag is off, and the guest UI (`PulseAccountLink`)
already hides the section on a 503 probe — so linking stays hidden with no
frontend change, independent of whether the ARC linking keys exist. The POST
guard is defense in depth. Turn the flag on in the GrowthBook dashboard to
reveal it — no deploy needed.
