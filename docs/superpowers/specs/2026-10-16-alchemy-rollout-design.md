# Alchemy rollout across OSN services — design

Date: 2026-10-16 · Epic: englishstreetventures/osn#1490 · Status: owner answers applied 2026-10-16 (https://github.com/englishstreetventures/osn/issues/1533#issuecomment-6206254623)

## Goal

Declare and deploy every Cloudflare resource the monorepo runs — Workers, D1 databases, R2 buckets, routes, domains, cron schedules and bindings — from Alchemy v2 stacks, so one reviewed plan shows the whole infrastructure for a tier and nothing is created by hand. The same stack code must make a new tier or product cheap to stand up, and must later support investigation stacks.

We do it now because few customers depend on the services yet. Guests of live weddings depend on **cire-invites** and **cire-api with its D1 database and R2 buckets**; those must not go down. Organiser surfaces (cire host, cire vendor) and the landing sites may take a short outage.

## Decisions (owner, 2026-10-16)

| Topic | Decision |
|---|---|
| Who uploads Workers | Alchemy. Wrangler stays only for local `wrangler dev`. |
| D1 migrations | Alchemy applies them for every D1 database (cire, osn, zap) through the D1 resource's `migrations` prop, replacing `scripts/cire-db-migrate.ts` and the `db:migrate:*` package scripts. Anything a database needs beyond that is handled in its own stack. |
| Accounts | Dev moves to a new Cloudflare account; production stays in the current account. Alchemy builds the dev account fresh: dev databases from migrations and seeds, on a dev-only domain or `workers.dev`. Production is adopted in place, so guest domains never move. The new account's id and the dev domain are owner values that do not exist yet; nothing before P1 depends on them. |
| Secret source | GitHub Environment secrets (`dev`, `production`), passed to Alchemy at deploy time as ordinary Worker secrets. Production keeps today's values; a value that turns out missing is rotated now, except `OSN_PAIRWISE_SALT`, which is never rotated (a new salt changes every pairwise `sub`) and may have no copy outside Cloudflare because `set-osn-api-secret.yml` generated it. englishstreetventures/osn#1537 settles that case before osn-api's first Alchemy deploy. Dev gets new values made for the new account. |
| Secret values | Before P1's first osn-api and cire-api deploys (moved to before P3's: englishstreetventures/osn#1533), each stored production value with a public or stored counterpart is shown to match live without revealing it: the JWT key pair against the published JWKS, the OIDC client secret against its stored hash, the TOTP key by decrypting one stored ciphertext, the pairwise salt by recomputing one stored pairwise subject, the ARC private key against its registered public key. |
| Cutover | Production: adopt in place under existing names; no route or domain moves for APIs. Dev first (built fresh), then production, riskiest last. |
| State | Alchemy's Cloudflare state store (`Cloudflare.state()`), one per account: dev state in the dev account, production state in the production account, so neither tier's token reaches the other's state. The production token gains Secrets Store access (owner action); the dev account's token is created with it. One deploy per stack and stage at a time. |
| Stack layout | One stack per product directory. `musubi/infra` holds our identity instance: osn-api, musubi social and musubi landing. `pulse/infra` holds pulse landing; `cire/infra` and `zap/infra` their products. `osn/` stays headless; a stack template for independent OSN instances (`osn/infra`) is later, low-priority work (englishstreetventures/osn#1539). |
| zap-api `GROWTHBOOK_CLIENT_KEY` | Retired (englishstreetventures/osn#1532). No zap code reads it; the inventory forbids it, and P3's zap-api step deletes it. |
| Pages | Every Pages site moves to a Worker with static assets. None uses `_worker.js` or `_routes.json`; `_headers` and `_redirects` work on Workers static assets. One uses a Pages Function: pulse landing's `GET /api/geo` (`pulse/landing/functions/api/geo.ts`), which its Worker must serve beside the assets unless the owner drops it (open question 1). |
| Previews | Cloudflare Worker preview URLs per pull request on dev, not separate preview stacks. |
| Investigation stacks | A future milestone, out of scope. Stacks accept any stage name the stage rules allow, so it needs no rework. They run on the dev tier, in the dev account. |
| Release path | Production deploys through the release workflow from englishstreetventures/osn#1449 (`.github/workflows/production-release.yml`, merged in #1524), with the smoke check and rollback from englishstreetventures/osn#1513, merged in #1540. Each production release takes two approvals: the Alchemy plan job, then the deploy. |

## Constraints

- An Alchemy upload of an existing Worker drops any secret binding the stack does not declare. Every secret is declared, and a missing value fails the deploy before upload.
- After adoption, Alchemy converges each resource to its declared props, and the plan does not reliably show it. Every adopted production D1 database and R2 bucket is declared exactly as it is live (lifecycle rules, CORS, storage class, public access, read replication), checked by a test against values read with Wrangler. Dev storage is created fresh and declared with production's settings.
- Every Alchemy command runs with `DO_NOT_TRACK=1`, in package scripts and in CI.
- `alchemy drift` reports an update on adopted D1 databases whose id, name and read replication match. Never run `drift --repair`; treat that report as known until a pinned version clears it.
- One migrator per database at any moment. A dev database has Alchemy as its only migrator from creation. A production database moves to Alchemy's migrations in one change that also removes its Wrangler migration step; never both in one deploy.
- Moving a production database to Alchemy's migrations converts its existing `d1_migrations` ledger into Alchemy's. That is one-way. Alchemy (2.0.0-beta.83) refuses a ledger row that matches no local migration file, and cire's production ledger lists the archived chain (`cire/db/migrations-archive/`) behind the `0001_initial.sql` baseline, so cire's stack must supply those archived files. The conversion must be shown, on a copy of each production database, to accept its ledger and apply nothing already applied. The partial-chain refusal `cire-db-migrate.ts` makes today is kept as a check in cire's stack until the conversion is proved, then dropped if Alchemy's own ledger check covers it.
- `.github/workflows/cire-dev-db-rebuild.yml` resets `cire-db-dev` each night and migrates it with Wrangler: a second migrator. The change that builds cire's dev database in the new account retires that workflow or rewrites it to rebuild through Alchemy.
- Before a production database changes migrator, record a D1 Time Travel bookmark so it can be restored.
- Cloudflare refuses to roll back to a Worker version whose secret values differ from the current one unless the rollback is forced. A deploy that changes a secret value therefore ships with no code change, and undoing it means deploying the previous value, not an automatic version rollback.
- Cloudflare credentials and Worker secret values are set only in the `env` of the step that runs Alchemy; install and build steps never hold them.
- What a production plan job writes to the run summary of this public repository is change counts and resource names only, never Alchemy's raw output, which can carry account-level values such as the `ALCHEMY_CLOUDFLARE_ACCOUNT_ID` binding.
- Invocation logs stay off on cire-api and cire-invites; request paths carry wedding slugs and names.
- Rotating the identity pairwise salt changes the pairwise subject identifiers that cire stores for linked accounts; if it must rotate, the same change rewrites those stored identifiers.
- Stage names are lowercase letters and digits in hyphen-joined groups, starting with a letter, at most 20 characters, never `prod`, `staging` or `local` (each derives or imitates a live name). `dev` and `production` keep today's resource names; any other stage derives `<base>-<stage>`, refused when that equals a dev or production name or passes Cloudflare's 63-character limit.
- `bun install --frozen-lockfile` in every job.

## Layout

- **`shared/infra`** (`@shared/infra`): pins one Alchemy version and exports the building blocks:
  - `apiWorker()` — an API Worker: observability on, invocation logs off unless the caller turns them on, version preview URLs only when the stack asks and never on `production`, secrets taken from `requireSecrets()`.
  - `siteWorker()` — a static-assets Worker for a built site, carrying its `_headers` and `_redirects`, with query strings redacted and native traces off.
  - `retainedD1()`, `retainedBucket()` — storage declared exactly as live (production) or as production is (dev, placed where production is), kept on destroy.
  - `requireSecrets()` — reads the declared secret names from the environment and fails before any upload when one is empty.
  - The credential names each tier's Alchemy jobs read from its GitHub Environment, so no code names an account.
- **`cire/infra`**, **`musubi/infra`**, **`zap/infra`**, **`pulse/infra`**: each defines its product's resources for a given stage (`dev`, `production`, later any investigation name).
- `wrangler.toml` / `wrangler.jsonc` stay for local development, and for the Wrangler migration scripts until each production database has moved to Alchemy's migrations. A test checks their bindings against the stack so they cannot drift apart.

`pulse/api` has no deploy job today and is out of scope.

## Phases

One pull request per phase (P3 is one per step).

- **P0 — foundation.** `@shared/infra`; the secret inventory (every Worker, every tier), with the `production` Environment's secrets filled by the owner (the `dev` Environment's are filled for the new account, englishstreetventures/osn#1538); a workflow that bootstraps or checks a tier's state store in that tier's account; telemetry off. P0 needs neither the dev account nor the dev domain.
- **P1 — dev, built fresh in the new account.** Needs the dev account, its domain, its token and the filled `dev` Environment (englishstreetventures/osn#1538). The production secret-value proof (englishstreetventures/osn#1537) blocks P3, not P1 (englishstreetventures/osn#1533). Alchemy creates every dev Worker, D1 database and R2 bucket in the new account from `deploy.yml`, including zap's first dev Worker and database; dev databases are built from migrations and seeds; the dev Pages sites become static-assets Workers. Every dev host moves to the dev-only domain or `workers.dev`, so each value that names a dev host (OIDC redirect URIs, CORS origins, cookie domain, WebAuthn RP ID, `OSN_API_URL`, Stripe webhook endpoints, front-end build URLs) changes with it. musubi social's single-page fallback (`musubi/social/public/_redirects`, `/* /index.html 200`) is checked on Workers static assets, or replaced by its `single-page-application` not-found handling. The free-tier ceiling alert (`.github/workflows/free-tier-ceiling-alert.yml`) starts watching the new account too. The same change removes the old dev tier's Wrangler jobs and dev migration scripts; the owner then deletes the old dev Workers, databases, buckets, Pages projects and dev DNS records from the current account, and `CLOUDFLARE_API_TOKEN_DEV` and the `dev` Environment's `CLOUDFLARE_ACCOUNT_ID` (both reach the production account) from GitHub. A second deploy plans no change; smoke checks pass.
- **P2 — cire-invites build.** cire-invites built and deployed through Alchemy's Astro path on dev. Every route of the invite site checked against the current build before production.
- **P3 — production, adopted in place, riskiest last.** The production state store is bootstrapped first, and the release workflow gains the Alchemy plan job and its second approval. Each step after the previous one has run clean:
  1. Site Workers for cire host (`cire-host`), cire vendor (`cire-vendor`), cire landing (`cire-landing`) and musubi social (`osn-social`), one domain moved at a time from its Pages project. Musubi landing and pulse landing have no production site today — only `*.pages.dev` preview projects, which `.github/workflows/deploy-osn-pulse-landing.yml` deployed from a feature branch until #1559 removed it — so each gets its first production Worker here rather than moving a domain.
  2. zap-api with `zap-db-prod`: the first adoption of a Worker and the first production ledger conversion, deleting the retired `GROWTHBOOK_CLIENT_KEY`. Its deploy uploads `INTERNAL_SERVICE_SECRET`, which osn-api must hold with the same value: either englishstreetventures/osn#1537 has shown the stored value is the live one, or the value rotates on both Workers in one release.
  3. osn-api, once zap-api's adoption has run clean and a second deploy planned no change.
  4. cire-api with its D1 database and R2 buckets.
  5. cire-invites.
  After the last, the Pages projects are deleted by the owner and the Wrangler migration scripts go.
- **P4 — previews.** Each pull request uploads dev Worker versions with a preview alias and posts the URLs. Previews share dev D1 and R2: a pull request that adds a migration is previewed after its migration reaches dev.

## Deploy flow

**Dev, on every push to `main`** (`deploy.yml`), one job per product stack, serialised per stack, with the dev account's credentials. Each stack job is followed by one record job per surface it shipped, which leaves that surface's Deployment record under the job name `scripts/deploy-surfaces.ts` and `scripts/release-plan.ts` key on (open question 2, answer (a)).

1. `bun install --frozen-lockfile`, build.
2. `alchemy deploy --stage dev --yes` with `DO_NOT_TRACK=1`, secrets from the `dev` Environment. It applies D1 migrations before uploading the Workers that use them.
3. Smoke check (#1513); on failure, roll back and mark the GitHub Deployment `failure`.

**Production** (`production-release.yml`), with the production account's credentials:

1. A plan job in the `production` Environment (approval 1) runs `alchemy plan --stage production` with production secrets and writes the plan's change counts and resource names to the run summary.
2. A guard fails the release if the plan replaces or deletes any D1 database, R2 bucket, route or domain.
3. The deploy job, after the plan job, in the `production` Environment (approval 2).
4. A D1 Time Travel bookmark for each database the plan migrates, then `alchemy deploy --stage production --yes`, smoke check and rollback, as on dev. Worker rollback does not undo a migration, so migrations stay compatible with the Worker version before them (add a column, use it in a later release).

The first production deploy of each resource uses `--adopt`, reviewed through that plan; later deploys do not. Dev is created, never adopted, so no dev deploy rehearses adoption: zap-api, which has no client yet, is the first adoption (P3 step 2), and nothing riskier adopts until it has run clean.

## Testing

- **Stack tests** per product: the stack built in memory for `production` matches today's names, bindings, routes, domains, cron schedules, compatibility date and flags, observability and invocation-log settings, read from the committed Wrangler configs before they shrink; for `dev` it matches the same apart from the hosts and the names the dev design states. Storage is retained on destroy; production Workers have preview URLs off.
- **Storage parity test**: each adopted production bucket's and database's declared settings equal values captured with Wrangler (fixtures refreshed by a script); each dev bucket and database is declared with production's settings.
- **Secrets test**: the declared secret names equal the inventory; an empty value fails `requireSecrets()`.
- **Migration conversion test**: for each production database, a local D1 built from its captured live ledger converts to Alchemy's ledger and plans no migration already applied; cire's partial-chain case is refused.
- **Plan guard test**: a fixture plan with a replacement or deletion of each protected kind fails the guard.
- **Site parity check**: for each site, `_headers` and `_redirects` give the same responses from the dev Worker as from the Pages project, by curl, before its production domain moves.

## Gates for each production step

1. The same surface has deployed through Alchemy on dev, and a second deploy planned no change. Dev proves creation only; adoption is proved by the earlier production steps (zap-api first).
2. The production plan holds only adoptions and the expected updates, and the owner approves it.
3. The smoke check passes after deploy; a failure rolls back automatically, except a deploy that changes a secret value (see Constraints), which carries no code change.
4. cire-api and cire-invites: deploy outside guests' peak hours, with the previous Worker version id recorded.
5. Storage parity test green against freshly captured production values.

## Open questions for the owner

None blocks P0. Each blocks the phase named. The owner answered all three on englishstreetventures/osn#1533 (2026-10-16).

1. **Pulse landing's `/api/geo`** (P3 step 1). It returns the visitor's coarse, IP-derived location for the hero and runs as a Pages Function (`pulse/landing/functions/api/geo.ts`; called from `pulse/landing/src/components/PulseHero.tsx:45`, which falls back to a generic "near you" link when it fails). (a) Give pulse landing's Worker a `main` that serves `/api/geo` and falls through to the assets. (b) Drop the endpoint and keep the fallback. Recommend (a): the code exists, and the Worker form is one small entry module. **Answered: (a)**; P1 serves it on dev from pulse landing's Worker entry.
2. **How stack jobs fit the per-surface deploy records** (P1). `scripts/deploy-surfaces.ts` decides which surfaces a push or release ships, and `scripts/release-plan.ts` finds what each production surface runs from the GitHub Deployment record its job left, by job name (`scripts/deploy-surfaces.ts:22-25`). One Alchemy job per stack deploys several surfaces at once. (a) Keep the surface map as the one source: a stack job runs when any of its surfaces changed and records one Deployment per surface it shipped, and `release-plan.ts` learns to read those. (b) Make the stack the unit: the map and the planner move from surfaces to stacks. Recommend (a): it keeps today's release planning and its tests, and changes only how a record is written. **Answered: (a).**
3. **How pull-request previews get credentials and secrets** (P4). A pull-request run cannot enter the `dev` Environment, which allows `main` only, so it has neither the dev account's token nor the dev secrets that `requireSecrets()` needs. (a) Previews upload after merge only, from `main`. (b) A separate preview Environment that pull-request branches can enter, holding a token limited to uploading versions. (c) A plan-only mode in `requireSecrets()` with placeholder values. Recommend deciding with P4's design; (b) keeps previews per pull request without opening `dev` to unmerged code. **Answered: (b)**, a separate `preview` Environment, built with P4.

## Out of scope

Investigation stacks (future milestone). `pulse/api`. The `osn/infra` stack template.

## Owner actions

- Create the dev Cloudflare account, its dev-only domain (or choose `workers.dev`) and its CI token, and fill the `dev` Environment (before P1; englishstreetventures/osn#1538).
- Fill the `production` Environment's Worker secrets from the password manager, and prove the stored values match live (before P3; englishstreetventures/osn#1537).
- Add Secrets Store access to the production CI token (before the production state store is bootstrapped).
- Delete the old dev tier from the current account once the new one serves (after P1).
- Approve each production plan and deploy (P3), and delete the Pages projects after the last step.
