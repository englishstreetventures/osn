# Alchemy rollout across OSN services — design

Date: 2026-10-16 · Epic: englishstreetventures/osn#1490 · Status: awaiting owner review

## Goal

Declare and deploy every Cloudflare resource the monorepo runs — Workers, D1 databases, R2 buckets, routes, domains, cron schedules and bindings — from Alchemy v2 stacks, so one reviewed plan shows the whole infrastructure for a tier and nothing is created by hand. The same stack code must make a new tier or product cheap to stand up, and must later support investigation stacks.

We do it now because few customers depend on the services yet. Guests of live weddings depend on **cire-invites** and **cire-api with its D1 database and R2 buckets**; those must not go down. Organiser surfaces (cire host, cire vendor) and the landing sites may take a short outage.

## Decisions (owner, 2026-10-16)

| Topic | Decision |
|---|---|
| Who uploads Workers | Alchemy. Wrangler stays only for local `wrangler dev`. |
| D1 migrations | Alchemy applies them for every D1 database (cire, osn, zap) through the D1 resource's `migrations` prop, replacing `scripts/cire-db-migrate.ts` and the `db:migrate:*` package scripts. Anything a database needs beyond that is handled in its own stack. |
| Secret source | GitHub Environment secrets (`dev`, `production`), passed to Alchemy at deploy time as ordinary Worker secrets. The owner holds every current value. A value that turns out missing is rotated now. |
| Cutover | Adopt in place under existing names; no route or domain moves for APIs. Dev first, then production, riskiest last. |
| State | Alchemy's Cloudflare state store (`Cloudflare.state()`). Both CI tokens gain Secrets Store access (owner action). One deploy per stack and stage at a time. |
| Pages | Every Pages site moves to a Worker with static assets. None uses Pages Functions, `_worker.js` or `_routes.json`; `_headers` and `_redirects` work on Workers static assets. |
| Previews | Cloudflare Worker preview URLs per pull request on dev, not separate preview stacks. |
| Investigation stacks | A future milestone, out of scope. Stacks accept any stage name so it needs no rework. |
| Release path | Production deploys through the release workflow from englishstreetventures/osn#1449, with the smoke check and rollback from englishstreetventures/osn#1513. This rollout starts its production phase only after both merge. |

## Constraints

- An Alchemy upload of an existing Worker drops any secret binding the stack does not declare. Every secret is declared, and a missing value fails the deploy before upload.
- After adoption, Alchemy converges each resource to its declared props, and the plan does not reliably show it. Every adopted D1 database and R2 bucket is declared exactly as it is live (lifecycle rules, CORS, storage class, public access, read replication), checked by a test against values read with Wrangler.
- Every Alchemy command runs with `DO_NOT_TRACK=1`, in package scripts and in CI.
- `alchemy drift` reports an update on adopted D1 databases whose id, name and read replication match. Never run `drift --repair`; treat that report as known until a pinned version clears it.
- One migrator per database at any moment. A database moves to Alchemy's migrations in one change that also removes its Wrangler migration step; never both in one deploy.
- Moving a database to Alchemy's migrations converts its existing `d1_migrations` ledger into Alchemy's. That is one-way. Cire's ledger lists the archived chain (`cire/db/migrations-archive/`) behind the `0001_initial.sql` baseline, so the conversion must be shown, on a copy of each database, to accept that ledger and apply nothing already applied. The partial-chain refusal `cire-db-migrate.ts` makes today is kept as a check in cire's stack until the conversion is proved, then dropped if Alchemy's own ledger check covers it.
- Before a production database changes migrator, record a D1 Time Travel bookmark so it can be restored.
- Invocation logs stay off on cire-api and cire-invites; request paths carry wedding slugs and names.
- Rotating the identity pairwise salt changes the pairwise subject identifiers that cire stores for linked accounts; if it must rotate, the same change rewrites those stored identifiers.
- `bun install --frozen-lockfile` in every job.

## Layout

- **`shared/infra`** (`@shared/infra`): pins one Alchemy version and exports the building blocks:
  - `apiWorker()` — an API Worker: observability on, invocation logs off unless the caller turns them on, version preview URLs off on `production`, secrets read from the environment.
  - `siteWorker()` — a static-assets Worker for a built site, carrying its `_headers` and `_redirects`.
  - `retainedD1()`, `retainedBucket()` — adopted storage declared exactly as live, kept on destroy.
  - `requireSecrets()` — reads the declared secret names from the environment and fails before any upload when one is empty.
- **`cire/infra`**, **`osn/infra`**, **`zap/infra`**: each defines its product's resources for a given stage (`dev`, `production`, later any investigation name). Pulse landing and musubi landing/social live in the stack of the product that owns them (`wiki/shared/osn-and-musubi.md` decides musubi's).
- `wrangler.toml` / `wrangler.jsonc` stay for local development and the migration scripts. A test checks their bindings against the stack so they cannot drift apart.

`pulse/api` has no deploy job today and is out of scope.

## Phases

One pull request per phase (P3 is one per step).

- **P0 — foundation.** `@shared/infra`; the state store bootstrapped on purpose; the secret inventory (every Worker, every tier) with GitHub Environment secrets filled by the owner; telemetry off; owner restores the dev lifecycle rule (englishstreetventures/osn#1512) so dev storage matches production.
- **P1 — dev adoption.** All dev Workers, D1 databases, R2 buckets, routes and domains adopted and deployed by Alchemy from `deploy.yml`. Each dev D1 database moves to Alchemy's migrations after a conversion rehearsal on a local copy of its live ledger; the Wrangler migration scripts go when the last database has moved. The dev Pages sites rebuilt as static-assets Workers on dev hosts. A second deploy plans no change; smoke checks pass.
- **P2 — cire-invites build.** cire-invites built and deployed through Alchemy's Astro path on dev. Every route of the invite site checked against the current build before production.
- **P3 — production, riskiest last.** Each step after the previous one has run clean:
  1. Site Workers for cire host (`cire-host`), cire vendor (`cire-vendor`), cire landing (`cire-landing`), musubi social (`osn-social`) from `deploy.yml`, and musubi landing (`osn-landing`) and pulse landing (`osn-pulse-landing`) from `deploy-osn-pulse-landing.yml` — one domain moved at a time from its Pages project.
  2. zap-api.
  3. osn-api.
  4. cire-api with its D1 database and R2 buckets.
  5. cire-invites.
  After the last, the Pages projects are deleted by the owner.
- **P4 — previews.** Each pull request uploads dev Worker versions with a preview alias and posts the URLs. Previews share dev D1 and R2: a pull request that adds a migration is previewed after its migration reaches dev.

## Deploy flow

**Dev, on every push to `main`** (`deploy.yml`), one job per product stack, serialised per stack:

1. `bun install --frozen-lockfile`, build.
2. `alchemy deploy --stage dev --yes` with `DO_NOT_TRACK=1`, secrets from the `dev` Environment. It applies D1 migrations before uploading the Workers that use them.
3. Smoke check (#1513); on failure, roll back and mark the GitHub Deployment `failure`.

**Production** (the release workflow from #1449):

1. A plan job runs `alchemy plan --stage production` and writes the plan to the run summary.
2. A guard fails the release if the plan replaces or deletes any D1 database, R2 bucket, route or domain.
3. One approval of the `production` Environment.
4. A D1 Time Travel bookmark for each database the plan migrates, then `alchemy deploy --stage production --yes`, smoke check and rollback, as on dev. Worker rollback does not undo a migration, so migrations stay compatible with the Worker version before them (add a column, use it in a later release).

The first deploy of each resource uses `--adopt`, reviewed through that plan; later deploys do not.

## Testing

- **Stack tests** per product: the stack built in memory for `dev` and `production` matches today's names, bindings, routes, domains, cron schedules, compatibility date and flags, observability and invocation-log settings, read from the committed Wrangler configs before they shrink. Storage is retained on destroy; production Workers have preview URLs off.
- **Storage parity test**: each adopted bucket's and database's declared settings equal values captured with Wrangler (fixtures refreshed by a script).
- **Secrets test**: the declared secret names equal the inventory; an empty value fails `requireSecrets()`.
- **Migration conversion test**: for each database, a local D1 built from its captured live ledger converts to Alchemy's ledger and plans no migration already applied; cire's partial-chain case is refused.
- **Plan guard test**: a fixture plan with a replacement or deletion of each protected kind fails the guard.
- **Site parity check**: for each site, `_headers` and `_redirects` give the same responses from the dev Worker as from the Pages project, by curl, before its domain moves.

## Gates for each production step

1. The same surface has deployed through Alchemy on dev, and a second deploy planned no change.
2. The production plan holds only adoptions and the expected updates, and the owner approves it.
3. The smoke check passes after deploy; a failure rolls back automatically.
4. cire-api and cire-invites: deploy outside guests' peak hours, with the previous Worker version id recorded.
5. Storage parity test green against freshly captured production values.

## Out of scope

Investigation stacks (future milestone). `pulse/api`. Production of anything before #1449 and #1513 merge.

## Owner actions

- Fill GitHub Environment secrets for `dev` and `production` from the password manager (P0).
- Add Secrets Store access to both Cloudflare CI tokens (P0).
- Restore the dev R2 lifecycle rule, #1512 (P0).
- Approve each production plan (P3), and delete the Pages projects after the last step.
