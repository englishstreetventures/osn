---
"@shared/infra": minor
"@musubi/infra": minor
"@zap/infra": minor
"@osn/api": patch
"@zap/api": patch
---

The production API Workers deploy through the Alchemy stacks. The musubi stack declares osn-api and its database on production, and the new zap production stack declares zap-api and its database; each adopts the existing Worker, database and Durable Object class by name, and a release migrates the database with Wrangler before the deploy.

- `@shared/infra`: `apiWorker()` adopts a production Worker under its own name only; production secrets stay on the Worker (`source: "worker"` in the inventory), and the patched provider keeps every live secret an upload does not name. A new live read (`readProductionLive()`, `runReadLiveCli()`) gives the plan guard each adopted resource's live settings and secret names, and checks after a deploy that no secret went. The plan guard refuses creating a database or bucket, creating an API Worker that does not exist live, unbinding a Durable Object, and a release whose Worker lacks a required secret.
- `@musubi/infra`, `@zap/infra`: `read:live` reads what the stack's adopted resources hold live; zap gains `plan:production`, `deploy:production` and `plan:guard`.
- `@osn/api`, `@zap/api`: no hand-deploy script; production deploys only through the release workflow.
