---
"@cire/api": patch
"@cire/db": patch
---

Give cire an isolated dev tier, and put production behind a manual approval.

`cireweddings.com` now serves live weddings, and every push to `main` deployed
straight to production with no human in the loop and nowhere to try a change
first. A merge now deploys a fully isolated **dev** tier automatically
(`api.dev` / `invite.dev` / `host.dev` / `vendor.dev` / `dev.cireweddings.com`,
own D1, R2, Upstash and native rate-limit namespaces), and the production jobs
in the same run wait on someone approving the protected `production` GitHub
Environment.

`cire/api/wrangler.toml` gains a full `[env.dev]` block, and `[env.production]`
becomes self-contained. Named environments inherit **nothing** from the top
level, which had already cost us: `[env.production]` declared no `[triggers]`,
so the daily `0 4 * * *` cron had never once run in production. Both envs now
declare their own triggers, D1, R2, images and observability. `WEB_ORIGIN`
ordering is load-bearing in the dev block too — `src/index.ts` maps
`origins[0]`→guest, `[1]`→host, `[2]`→vendor positionally — and `ZAP_API_URL`
is deliberately omitted so dev vendor-enquiry delivery fails closed.

Second latent production bug fixed here: `process.env` was **empty on the
deployed Worker**. `nodejs_compat_populate_process_env` only defaults for
`compatibility_date >= 2025-04-01` and this Worker pins `2025-03-01`, so
`loadConfig`'s `process.env.OSN_ENV` read resolved `local` in production —
which made the fail-closed `CLAIM_RATE_LIMITER` guard inert in prod and picked
the local log format. The flag is now listed explicitly (no compat-date bump on
a live Worker), `OSN_ENV` is set in every env block, and the module-top-level
reads move into request scope, because the flag populates `process.env` lazily
on first access and never during workerd's module eval.

`@cire/db` gains the per-env migrate scripts the other db packages already had
(`db:migrate:local|dev|prod`, each passing `--env`; the old `db:push*` scripts
never did, so they always targeted the top-level database), plus a dev seed and
a `dev-reset.sql` that drops every table **including `d1_migrations`**. Each dev
deploy therefore replays migrations from zero, which turns every dev deploy into
a migration test. `scripts/cire-db-reset.sh` and `cire-dev-db-guard.sh` refuse
to run against anything but `cire-db-dev`.
