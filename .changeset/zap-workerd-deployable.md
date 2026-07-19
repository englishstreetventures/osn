---
"@zap/api": patch
"@zap/db": patch
---

Make zap-api actually deployable to Cloudflare Workers (first prod bring-up). Fix two workerd-hostile module-load patterns: `zap/db/src/service.ts` now passes the bun:sqlite path as a thunk so `fileURLToPath(import.meta.url)` is deferred into the lazy Layer (never runs on workerd, where `import.meta.url` is undefined at deploy-eval); `zapGraphBridge.ts` resolves + https-validates `OSN_API_URL` lazily (at call time) instead of at module load (workerd `[vars]` populate `process.env` only at runtime). Adds the `zap.cireweddings.com` custom-domain route + `OSN_API_URL` prod var to `zap/api/wrangler.toml`.
