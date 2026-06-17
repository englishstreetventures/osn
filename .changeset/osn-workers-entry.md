---
"@osn/api": minor
"@osn/db": patch
"@shared/db-utils": patch
---

osn-api runs on Cloudflare Workers (`export default { fetch, scheduled }`).

`osn/api/src/index.ts` is now the workerd entry, mirroring cire's proven
template: a per-isolate `cached` app, fail-closed 503 on missing
bindings/vars, everything built from the request-scoped `env` binding (not
module-top `process.env`), and a cron `scheduled` handler that runs the
account-erasure fan-out-retry + hard-delete sweeps (replacing the Bun
`setInterval`). The Bun dev server moved into `src/local.ts` and is unchanged
in behavior (default `bun run dev`); a runtime-agnostic `src/build-deps.ts`
holds the shared composition both entries call.

Highlights:
- S-L1: the Workers Redis path env-gates the in-memory fallback — a deployed
  Worker (`OSN_ENV` set & != "local") with missing Upstash bindings fails
  closed at construction instead of silently downgrading rate-limiters /
  step-up-jti to per-isolate in-memory.
- P-I3: the Upstash client + Effect runtime + Elysia app are built once per
  isolate and cached, never reconstructed in the request path.
- S-H3: the Workers entry re-applies the `x-request-id` sanitize-and-echo the
  omitted observability plugin used to do.
- Secrets (`INTERNAL_SERVICE_SECRET`, `PULSE_API_URL`/`ZAP_API_URL`) are
  threaded through `env`/the `createApp` factory instead of module-top
  `process.env` reads, since workerd surfaces secrets only on `env`.
- `createApp` gains an `aot` flag (Workers passes `false`; AOT's `new
  Function` is forbidden on workerd) and keeps `includeObservabilityPlugin:
  false` + the redacting `osnLoggerLayer` on the Workers path.

`@osn/db` / `@shared/db-utils`: `DbLive`'s bun:sqlite path is resolved lazily
(`makeDbLive` now accepts a path thunk) so `fileURLToPath(import.meta.url)` no
longer runs at module load — it threw on workerd, where `import.meta.url` is
undefined, even though the Workers path never builds the bun:sqlite layer.

wrangler.toml gains `main`, the real per-env D1 ids, per-env `[vars]`, and a
6-hourly `[triggers] crons` for the sweeper. New devloop scripts: `dev`
(unchanged fast Bun loop), `dev:wrangler` (workerd + local D1 + in-memory
Redis, no external services), `deploy`, `types`, `build`.
