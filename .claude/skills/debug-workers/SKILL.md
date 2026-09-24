---
name: debug-workers
description: Use when a deployed Cloudflare Worker in this repository misbehaves or fails to deploy — osn-api, cire-api or a cire Worker — or when setting or rotating a Worker secret. Covers where to look first, the secret-setting trap for JSON and JWK values, why a secret change needs a redeploy, and the module-evaluation crash on a first deploy.
---

The tier map, secrets checklist and deploy steps are in `wiki/shared/production-deploy.md` and `wiki/shared/dev-environment.md`. This skill holds the traps that cost time.

## 1. Tail the failing Worker first

When a request that crosses several services misbehaves, run `wrangler tail` on the service that actually fails before forming any theory about the architecture:

```bash
bunx wrangler tail <worker-name> --env production
```

## 2. Setting a JSON or JWK secret

Never `source` a secrets file to set a secret shaped like JSON or a JWK: bash brace expansion mangles an unquoted `{"a":"b"}`. Extract the value and pipe it:

```bash
VAL=$(grep -m1 '^KEY=' "$SF" | sed 's/^[^=]*=//'); printf '%s' "$VAL" | bunx wrangler secret put KEY --env production
```

## 3. A secret change needs a redeploy

`wrangler secret put` and `wrangler secret delete` do not restart warm isolates. When behaviour must change now, redeploy after the change:

```bash
bunx wrangler deploy --env production
```

## 4. The first deploy of a Worker crashes at module evaluation

A Worker's first deploy — even with an existing `wrangler.toml` — can fail while workerd evaluates the module, because two things are missing then:

- `fileURLToPath(import.meta.url)` at module top level;
- `process.env` read or validated at module top level.

Move both into request-time code or lazy thunks. Verify with a real `wrangler deploy`; `--dry-run` does not catch it.

## 5. Named environments do not inherit routes

A named environment that has never deployed gets no routes from the top level. Add `[[env.production.routes]]` with `custom_domain = true`.

## 6. Shared schema changes

Changing the schema of a shared package other services import (a DB package, say) needs the whole monorepo suite before merging, not just that package's tests: `bun run test`.
