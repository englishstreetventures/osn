# Alchemy rollout P1 — dev stacks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the dev tier in its own Cloudflare account from four Alchemy stacks (`cire/infra`, `musubi/infra`, `zap/infra`, `pulse/infra`), deployed from `.github/workflows/deploy.yml` with the smoke check and rollback after every deploy, every dev host derived from one dev-domain input, and the old dev tier's Wrangler jobs, dev migration scripts and nightly rebuild retired. The code merges once the dev account exists (englishstreetventures/osn#1538); nothing here deploys, and nothing here touches production.

**Architecture:** `@shared/infra` (from P0) gains the dev host layout (`stageHosts()` from the `DEV_DOMAIN` input), a deploy-target guard, a migrations flattener, two builder extensions (prebuilt Workers with assets; sites with an entry module), the stack-to-Worker map, and two CLIs (`dev-hosts`, `plan-summary`). Each product stack is a workspace with a pure declaration module (tested) and an `alchemy.run.ts` that turns the declaration into Alchemy resources. `deploy.yml` runs one Alchemy job per stack, each deploying the whole stack and smoke-checking every surface in it, then one record job per healthy surface that keeps today's job id and name, so the release planner keeps reading one GitHub Deployment record per surface. The smoke check learns dev origins from the environment, judges rollback by the deployment id the stack job created, and a Worker a smoke check rolled back is re-uploaded with `--force` on the next run.

**Tech Stack:** Bun 1.4.2, TypeScript 6, Effect 4.0.3 (`Data`, `Redacted`), Alchemy `2.0.0-beta.83` (`alchemy`, `alchemy/Cloudflare`), Vitest 5.0.3 under `bunx --bun`, `bun:test` for `scripts/`, GitHub Actions, Astro and Vite builds as today.

**Spec:** `docs/superpowers/specs/2026-10-16-alchemy-rollout-design.md` (P1 section, Decisions, Constraints, Layout). P0 plan for conventions and the `@shared/infra` API: `docs/superpowers/plans/2026-10-16-alchemy-p0-foundation.md`.

**Issue:** englishstreetventures/osn#1553, a sub-issue of englishstreetventures/osn#1490.

**Branch:** `feat/alchemy-dev-stacks` in `/Users/ac/.work/osn.git/alchemy-dev-stacks`, stacked on `feat/alchemy-foundation` (P0). Not pushed; no pull request (the repository's history is about to be rewritten; this branch is replayed after). No commit SHA appears in committed text.

---

## Global Constraints

### Decisions (owner, 2026-10-16) — verbatim from the spec

| Topic | Decision |
|---|---|
| Who uploads Workers | Alchemy. Wrangler stays only for local `wrangler dev`. |
| D1 migrations | Alchemy applies them for every D1 database (cire, osn, zap) through the D1 resource's `migrations` prop, replacing `scripts/cire-db-migrate.ts` and the `db:migrate:*` package scripts. Anything a database needs beyond that is handled in its own stack. |
| Accounts | Dev moves to a new Cloudflare account; production stays in the current account. Alchemy builds the dev account fresh: dev databases from migrations and seeds, on a dev-only domain or `workers.dev`. Production is adopted in place, so guest domains never move. The new account's id and the dev domain are owner values that do not exist yet; nothing before P1 depends on them. |
| Secret source | GitHub Environment secrets (`dev`, `production`), passed to Alchemy at deploy time as ordinary Worker secrets. Production keeps today's values, which the owner holds; a value that turns out missing is rotated now. Dev gets new values made for the new account. |
| Secret values | Before P1's first osn-api and cire-api deploys, each stored production value with a public or stored counterpart is shown to match live without revealing it: the JWT key pair against the published JWKS, the OIDC client secret against its stored hash, the TOTP key by decrypting one stored ciphertext, the pairwise salt by recomputing one stored pairwise subject, the ARC private key against its registered public key. |
| Cutover | Production: adopt in place under existing names; no route or domain moves for APIs. Dev first (built fresh), then production, riskiest last. |
| State | Alchemy's Cloudflare state store (`Cloudflare.state()`), one per account: dev state in the dev account, production state in the production account, so neither tier's token reaches the other's state. The production token gains Secrets Store access (owner action); the dev account's token is created with it. One deploy per stack and stage at a time. |
| Stack layout | One stack per product directory. `musubi/infra` holds our identity instance: osn-api, musubi social and musubi landing. `pulse/infra` holds pulse landing; `cire/infra` and `zap/infra` their products. `osn/` stays headless; a stack template for independent OSN instances (`osn/infra`) is later, low-priority work (englishstreetventures/osn#1539). |
| zap-api `GROWTHBOOK_CLIENT_KEY` | Retired (englishstreetventures/osn#1532). No zap code reads it; the inventory forbids it, and P3's zap-api step deletes it. |
| Pages | Every Pages site moves to a Worker with static assets. None uses `_worker.js` or `_routes.json`; `_headers` and `_redirects` work on Workers static assets. One uses a Pages Function: pulse landing's `GET /api/geo` (`pulse/landing/functions/api/geo.ts`), which its Worker must serve beside the assets unless the owner drops it (open question 1). |
| Previews | Cloudflare Worker preview URLs per pull request on dev, not separate preview stacks. |
| Investigation stacks | A future milestone, out of scope. Stacks accept any stage name the stage rules allow, so it needs no rework. They run on the dev tier, in the dev account. |
| Release path | Production deploys through the release workflow from englishstreetventures/osn#1449 (`.github/workflows/production-release.yml`, merged in #1524), with the smoke check and rollback from englishstreetventures/osn#1513, merged in #1540. Each production release takes two approvals: the Alchemy plan job, then the deploy. |

### Constraints — verbatim from the spec

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

### Owner decisions that bind P1 (recorded on englishstreetventures/osn#1533, 2026-10-16, and in the P1 brief, 2026-10-17)

- Stacks at `cire/infra`, `musubi/infra` (osn-api, musubi social, musubi landing), `zap/infra`, `pulse/infra` (pulse landing).
- Dev moves to a **new** Cloudflare account built fresh: no adoption on dev, no ledger conversion on dev. Fresh D1 from migrations through Alchemy's `migrations` prop, then seeds.
- Every Pages site becomes a static-assets Worker. Pulse landing's `/api/geo` is served from its Worker's `main` (open question 1, answer (a)).
- One GitHub Deployment record per surface; `scripts/release-plan.ts` and `scripts/deploy-surfaces.ts` keep working, reading dev records by job name (open question 2, answer (a)).
- P4 previews get a separate `preview` Environment later, not in P1 (open question 3, answer (b), deferred).
- Dev credential names `CLOUDFLARE_DEV_ACCOUNT_ID`, `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN`.
- englishstreetventures/osn#1537 blocks P3, not P1.
- zap gets its first dev Worker and database in P1.
- `cire-dev-db-rebuild.yml` is a second migrator: retire or rewrite it in P1 (this plan retires it; Decision 6).
- Invocation logs off on cire-api and cire-invites. `DO_NOT_TRACK=1` everywhere. **Production untouched in P1.**
- The dev account, its id, its token and the dev domain do not exist yet. **Never invent them**: each is an input (a GitHub Environment secret or variable), and the code refuses to plan or deploy when one is missing.

### Repository rules that bind this plan (`AGENTS.md`)

- Tests in `tests/` at the package root, never beside source; no test helpers in `src/`. `scripts/` tests live in `scripts/tests/`, run under `bun test ./scripts/`, and import only `bun:test`, Bun and Node built-ins and each other (`scripts/tsconfig.json` "//"); the `script-tests` CI job does no install (`.github/workflows/ci.yml`, job `script-tests`).
- No `console.*` in new code: `process.stdout.write` / `process.stderr.write` (`oxlintrc.json` `no-console`; `scripts/guard-lint-warnings.sh` fails a branch that raises the warning count). Source must pass the `anti-slop/*` rules at error level (the P0 plan, "Repository rules", lists the ones that bite: no `Record<…, unknown | any | object>`, no `...(cond ? {} : {…})`, no `unknown` return types, no symbol containing "shape"). Run `bunx --bun oxlint -c oxlintrc.json <files>` before each commit.
- Never a bare `bun install`. Add a dependency with `bun add --exact --cwd <dir> <pkg>@<version>`; check with `bun install --frozen-lockfile`. A lockfile diff bigger than the dependency change is wrong.
- Comments state what the code guarantees now; a deferral carries only an issue link. Never a tracker id in a public file.
- Effect only in backend code; stacks are deploy tooling and may use Effect where Alchemy needs it.
- Never commit to `main`, never push, never open the pull request. **Never run an Alchemy or Wrangler command that writes to Cloudflare** (`alchemy deploy`, `alchemy plan` against a store, `provider cloudflare bootstrap`, `wrangler deploy`, `wrangler d1 execute --remote`, `wrangler secret put`).
- One code-writing agent at a time in this worktree.

### Deliberate exception to "credentials only in the step that runs Alchemy"

The snapshot, compare and smoke-check steps of each stack job also hold the dev account's `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`: they read each Worker's deployments and roll a Worker back through the Cloudflare API, as today's smoke step does (`.github/workflows/deploy.yml:266-305`). No install or build step holds a credential or a Worker secret (W3).

## Review Focus

The five failure modes the spec implies but no single task would exercise, most likely first. Each has a test in the task named.

1. **A second deploy that never plans "no change"** because something in the declaration is not deterministic: a seed file carrying a timestamp, a flattened migrations directory holding a stale file from an earlier run, a build value that changes per run. The Done-when check tomorrow is a second deploy that plans no change. Tests: the generated seed SQL is byte-identical for identical inputs (Task 5, Task 6); the flattener empties its target first (Task 2); `plan-summary --expect-no-change` fails on any count (Task 4).
2. **A dev value that still names an old dev host or a production host.** Every dev host must come from `DEV_DOMAIN`. Tests: `stageHosts()` refuses a production zone (Task 1); a grep test over each stack's source refuses a literal host (Tasks 5–8); the workflow test refuses a literal `https://` URL in a dev build or smoke step (Task 11).
3. **A stack run against the wrong account**: `--stage dev` with production credentials, or with a stored Alchemy profile that picks whatever account the developer last used. Test: `assertDevDeployTarget()` refuses a missing `OSN_DEPLOY_TIER`, a mismatched one, a missing `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN`, a `.env` file in the stack directory, and every production stage (Task 1).
4. **A rollback that restores a version this run never deployed, or a record that claims code dev does not serve**: a stack deploy that changed nothing for a Worker, followed by a failing smoke check, must not roll back; and after a smoke check has rolled a Worker back, no later run may record success for that Worker until the code its commit declares is uploaded again. Tests: `SMOKE_DEPLOYMENT=unchanged` never rolls back; a deployment id that is no longer the newest is refused; an `unchanged` Worker whose newest deployment is a smoke-check rollback fails; the snapshot reports that Worker so the deploy forces a re-upload (Task 10).
5. **A secret the stack job never receives**, so `requireSecrets()` fails the first deploy tomorrow, or a secret that reaches a build step. Test: each stack job's deploy step env holds exactly the dev inventory secrets of that stack's Workers, and no install or build step holds a secret (Task 11).

---

## Facts checked (2026-10-17)

Each line is a claim the design rests on, with where it was read. Alchemy citations are relative to `node_modules/.bun/alchemy@2.0.0-beta.83+01e8319cc9a0c4c5/node_modules/alchemy/src/` (call it `ALC/`).

### Alchemy behaviour

| Fact | Source |
|---|---|
| `alchemy deploy [file]` imports the module's default export, which must be an Effect carrying `stackName`; the default file is `alchemy.run.ts`. | `ALC/Alchemist/Session.ts:65-84`; `ALC/Cli/commands/flags.ts:165-199` |
| `Alchemy.Stack(name, { providers, state }, effect)`; the body reads the stage with `yield* Alchemy.Stage`; it is evaluated once per command; `process.env` is readable in it. Alchemy's own `--env-file` feeds only an Effect ConfigProvider, but `bin/cli.js` sets `NODE_ENV=production` and hands off to Bun, which loads `.env`, `.env.local` and the `.development`, `.production` or `.test` pair, by `NODE_ENV` from the working directory into `process.env`. | `ALC/Stack.ts:104-178, 267-330`; `ALC/index.ts:36-37`; `ALC/Util/ConfigProvider.ts:125-145`; `alchemy/bin/cli.js:17` |
| `--include` selects resources and their dependencies, but the whole declaration still runs. | `ALC/Cli/commands/flags.ts:132-146`; `ALC/ResourceSelection.ts:5-11` |
| D1 `migrations` takes a directory string, read relative to the process cwd; Alchemy keeps `__alchemy_migrations`; a new file makes the database an `update`, nothing new is a noop. | `ALC/Cloudflare/D1/Database.ts:95, 311-313, 494-515`; `ALC/SQL/SqlFile.ts:16-34`; `ALC/SQL/Migrations/AlchemyFormat.ts:21` |
| **A migrations directory holding `meta/_journal.json` is refused** (`DrizzleV0LayoutError`). All three of ours hold one: `cire/db/migrations/meta/_journal.json`, `osn/db/drizzle/meta/_journal.json`, `zap/db/drizzle/meta/_journal.json`. A flat directory of `*.sql` files is read sorted by numeric prefix, keyed by relative path. | `ALC/SQL/Migrations/Detect.ts:20-31`; `ls` of the three directories |
| D1 `importFiles` runs after migrations in the same create or update, and re-imports a file only when its hash changed; a file dropped from the list is forgotten, not undone. | `ALC/Cloudflare/D1/Database.ts:494-531, 314-319, 717-738` |
| A Worker's `env` takes resources and literals: D1 database → `d1`, R2 bucket → `r2_bucket`, `Cloudflare.Images.Images("IMAGES")` → `images`, `Cloudflare.RateLimit(name, { namespaceId, simple: { limit, period } })` → `ratelimit` (period 10 or 60), `Redacted<string>` → `secret_text`, `string` → `plain_text`. | `ALC/Cloudflare/Workers/WorkerAsyncBindings.ts:480-505, 544, 571, 625, 631`; `ALC/Cloudflare/Workers/RateLimit.ts:10-30, 99-110`; `ALC/Cloudflare/Images/Images.ts:77-92` |
| `assets` takes `{ directory, htmlHandling, notFoundHandling, runWorkerFirst }`; the binding is always `ASSETS`; `_headers` and `_redirects` from the directory are applied with or without `main`; an explicit `redirects` prop overrides the file. | `ALC/Cloudflare/Workers/Assets.ts:33-124, 259-280`; `ALC/Cloudflare/Workers/WorkerProvider.ts:3381, 3419` |
| `bundle: false` uploads the entry and every `**/*.{js,mjs,wasm,txt,html,sql,bin}` under the entry's directory byte for byte; for such an external Worker an explicit `compatibility.flags` array is used verbatim. | `ALC/Cloudflare/Workers/Sources/Prebuilt.ts:55-100`; `@alchemy.run/cloudflare-runtime/src/core/internal/constants.ts:13-53` |
| A bundled Worker gets `new_module_registry` unless `legacy_module_registry` is listed, and `nodejs_compat` for dates before 2026-08-04. | same `constants.ts:13-53` |
| `domain` finds the zone by trying the hostname's parents longest first, in the run's account; a hostname two labels below the zone works; no zone fails with `Cloudflare zone not found for <hostname>`. | `ALC/Cloudflare/Zone/lookup.ts:23-70` |
| A normal deploy is a full-cutover script PUT that creates a 100% deployment; `secret_text` bindings are re-sent on every upload; a Worker whose metadata, bundle and assets hashes are unchanged is a noop and is not uploaded. | `ALC/Cloudflare/Workers/WorkerProvider.ts:829, 3796-3825, 4325-4478` |
| The `versionId` attribute is set only for gradual rollouts and version Workers, so a normal deploy reports no version id to the smoke check. | `ALC/Cloudflare/Workers/Worker.ts:1253-1275` |
| In a non-interactive terminal the plan prints `Plan: no changes` when every resource is a noop, `Plan: <n> to create, <n> to update, …` otherwise, `Plan: no resources` when nothing is declared, possibly with ANSI colour; `deploy` prints the same line. No JSON output and no distinguishing exit code. | `ALC/Cli/LoggingCli.ts:84-135, 240-250`; `ALC/Cli/selectCli.ts:19-24`; `ALC/Cli/commands/deploy.ts:186-212` |
| Credentials come from the environment only when **both** `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set; otherwise, outside CI, a stored profile, whose account may be production's. | `ALC/Auth/Resolve.ts:41-90`; `ALC/Cloudflare/Auth/AuthProvider.ts:486-512, 763-771` |
| Alchemy plans against its persisted state, not the live Worker: a Worker whose hashes match state is a noop even when something else (a rollback) changed what it serves. `--force` turns every noop resource into an update. | `ALC/Plan.ts:1489-1497, 1619-1624`; `ALC/Cloudflare/Workers/WorkerProvider.ts:4351-4466`; `ALC/Cli/commands/flags.ts:126-129` |
| The CLI loads `@effect/platform-bun` or `@effect/platform-node` at runtime; both are optional peers of `alchemy`, so a workspace that runs the CLI depends on both. | `ALC/Util/PlatformServices.ts:59-120`; P0 plan, "Alchemy version and the release-age rule" |
| The non-interactive CLI logs through Effect's pretty console logger, one record per `Effect.logInfo`. | `ALC/Util/ConsoleSink.ts:5-17`; `ALC/Cli/GlobalLog.ts:64-76` |
| Astro (7.2.10) generates a random encryption key on every server build unless `ASTRO_KEY` is set, and writes it into the server manifest under `dist/server`; a prebuilt upload hashes every module there, so without a fixed key cire-invites changes on every build. cire-invites uses no server islands, the feature the key protects. | `node_modules/.bun/astro@7.2.10+656ac6e668890736/node_modules/astro/dist/core/build/index.js:146-147`, `…/dist/core/encryption.js:10-24`, `…/dist/core/build/plugins/plugin-manifest.js:80-81, 289`; `cire/invites/astro.config.mjs:114` |
| A prebuilt (`bundle: false`) upload skips `*.js.map`, so cire-invites' source maps are not uploaded on dev until P2. | `ALC/Cloudflare/Workers/Sources/Prebuilt.ts:22-27`; `cire/invites/wrangler.jsonc` `upload_source_maps` |
| No supported API evaluates a stack body offline; `Stack.make` with an in-memory state might, unverified. | `ALC/Test/*`; `ALC/Stack.ts:267-330` |

### Production storage settings, read 2026-10-17 (read-only Cloudflare API and `wrangler r2 bucket … list/get`)

| Resource | Setting |
|---|---|
| `cire-assets`, `cire-sheets` | storage class `Standard`, jurisdiction `default`, location `ENAM`, no CORS configuration (API code 10059), no custom domains, `r2.dev` access disabled, one lifecycle rule `Default Multipart Abort Rule` (enabled, all prefixes, abort incomplete multipart uploads after 7 days) |
| `cire-db` | read replication `auto`, region `OC`, no jurisdiction |
| `osn-db-prod`, `zap-db-prod` | read replication `disabled`, region `OC`, no jurisdiction |

### Repository facts

| Fact | Source |
|---|---|
| The release planner maps a Deployment record to a surface only through the name of the job its success status links to, and accepts dev records only from `.github/workflows/deploy.yml` on `main`; an unknown job name is skipped. | `scripts/release-plan.ts:124-137, 320-366` |
| `Surface.dev` is one job per surface; `deploy-workflows.test.ts` holds `deploy.yml`'s `deploy-*` jobs to the map's dev jobs. | `scripts/deploy-surfaces.ts:50-117`; `scripts/tests/deploy-workflows.test.ts:79-114` |
| A GitHub job with `environment:` leaves one Deployment record. | relied on by `scripts/release-plan.ts:13-19` and `scripts/deploy-surfaces.ts:24-27` |
| The smoke check names the deployed version from `WRANGLER_OUTPUT_FILE_PATH`; without it, it takes the newest deployment to be the job's; its dev targets hard-code `*.dev.cireweddings.com` and `id.dev.musubi.social`; an Access target with no service token is skipped with a warning. | `scripts/smoke-check.ts:146-201, 680-716` |
| osn-api reads its WebAuthn RP ID, origins, CORS list, issuer, cookie domain and dev-login return origins from Worker vars. | `osn/api/src/build-deps.ts:48-54, 295-300, 361-366, 454-460`; `osn/api/src/lib/cors-config.ts:43`; `osn/api/src/routes/auth/dev-login.ts:63-72` |
| cire-api reads its site origins from `WEB_ORIGIN` in the order guest, organiser, vendor; its own origin from `CIRE_API_ORIGIN`, building the OIDC redirect URI `${CIRE_API_ORIGIN}/api/auth/oidc/callback`; it sets no cookie `Domain`. | `cire/api/src/index.ts:266-275, 449-460, 532`; `cire/api/src/lib/web-origin.ts:26-57`; `cire/api/src/lib/cookie.ts:19-20` |
| cire-api reads `OSN_API_URL` from `env` (today a dev Worker secret). | `cire/api/src/index.ts:92, 317-344`; `shared/infra/src/secrets/inventory.ts:91` |
| The cire OIDC client row (`cid_cire`, `oc_cire`, first-party, `sector_identifier` `cireweddings.com`, `allowed_scopes` `openid profile email`, SHA-256 hex of `CIRE_OIDC_CLIENT_SECRET`) and cire-api's ARC key registration are made by hand today; no script or migration creates either. | `wiki/shared/dev-environment.md:535-547`; `wiki/shared/production-deploy.md:550-584`; `osn/db/drizzle/0002_wet_gamora.sql:18-33` |
| `POST /graph/internal/register-service` upserts a service key behind `Bearer INTERNAL_SERVICE_SECRET`, refusing (409 `kid_serviceid_mismatch`) a key id another service holds. | `osn/api/src/routes/graph-internal.ts:250-330` |
| zap-api's production vars are exactly `OSN_JWKS_URL`, `OSN_ISSUER_URL` and `OSN_API_URL`; it self-registers its ARC key with `INTERNAL_SERVICE_SECRET`. | `zap/api/wrangler.toml:93-98`; `zap/api/src/services/zapGraphBridge.ts:111-141` |
| `cire/db/seed/dev-seed.sql` is 257,895 bytes of `INSERT OR IGNORE`, no `BEGIN`/`COMMIT`/`PRAGMA`; the owner-seat override is two statements keyed on `CIRE_DEV_OWNER_PROFILE_ID` (`^usr_[A-Za-z0-9_-]+$`). | `cire/db/seed/dev-seed.sql`; `scripts/cire-db-seed.sh:62-96` |
| No osn or zap seed reaches D1 (`osn/db/src/seed.ts` is local bun:sqlite only; no `zap/db/src/seed.ts`). | `osn/db/src/seed.ts`; `osn/db/src/service.ts:18-19` |
| `musubi/social/public/_redirects` is `/*  /index.html  200`; `musubi/landing` and `pulse/landing` are `output: "static"` with `site: process.env.SITE ?? …`; both read `PUBLIC_APP_URL` (default a localhost dev server), musubi landing also `PUBLIC_DOCS_URL` (default a GitHub README); pulse landing's `/api/geo` is a 59-line Pages Function called from `pulse/landing/src/components/PulseHero.tsx:45`. | the files named; `musubi/landing/src/lib/site.ts:10, 17-18`; `pulse/landing/src/lib/site.ts:11` |
| `cire/db/seed/assets.ts` uploads the dev seed's placeholder images by bucket name with `--remote` and no `[env.dev]`, so it reaches whichever account the credentials name. | `cire/db/seed/assets.ts:25-27, 195` |
| A smoke-check rollback posts a deployment annotated `workers/message: "Smoke check failed: <run url>"`. | `scripts/smoke-check.ts:580-589, 608-617` |
| `retargetHeaders` rewrites the production API origin in each cire site's `_headers` to the build's `PUBLIC_CIRE_API_URL` / `PUBLIC_API_URL`. | `cire/build-tools/src/tier-headers.ts:33, 88-125` |
| The free-tier ceiling alert reads one account (`CLOUDFLARE_API_TOKEN_READONLY`, repository `CLOUDFLARE_ACCOUNT_ID`) and files one issue with no account label. | `.github/workflows/free-tier-ceiling-alert.yml:67-93`; `scripts/check-free-tier-ceilings.ts:637-645` |
| `actionlint` runs nowhere in this repository. | `grep -rn actionlint` (only a comment, `scripts/tests/deploy-workflows.test.ts:6`) |
| `scripts/changeset-required.sh` allows `.github/`, `scripts/`, `wiki/`, `docs/` and root `*.md` without a changeset; every workspace package needs one. | `scripts/changeset-required.sh:36-85` |

---

## Decisions this plan makes

1. **The dev host layout.** One GitHub `dev` Environment **variable**, `DEV_DOMAIN`, names a zone in the dev account. `stageHosts(domain, stage)` derives every host; for stage `dev` the base is `DEV_DOMAIN`, for an investigation stage `<stage>.<DEV_DOMAIN>`; the production tier is refused (its hosts are today's production domains, declared in P3). The labels mirror production's shape, so each product keeps its own same-site relationships:

   | Key | Dev host | Production today |
   |---|---|---|
   | `musubiSocial` (WebAuthn RP ID, cookie domain) | `musubi.<D>` | `musubi.social` |
   | `osnApi` (issuer) | `id.musubi.<D>` | `id.musubi.social` |
   | `musubiLanding` | `www.musubi.<D>` | none (`site` default `https://www.musubi.social`) |
   | `cireLanding` | `cire.<D>` | `cireweddings.com` |
   | `cireApi` | `api.cire.<D>` | `api.cireweddings.com` |
   | `cireInvites` | `invite.cire.<D>` | `invite.cireweddings.com` |
   | `cireHost` | `host.cire.<D>` | `host.cireweddings.com` |
   | `cireVendor` | `vendor.cire.<D>` | `vendor.cireweddings.com` |
   | `zapApi` | `zap.cire.<D>` | `zap.cireweddings.com` |
   | `pulseLanding` | `pulse.<D>` | none (`site` default `https://pulse.events`) |

   It supports a custom zone only. `workers.dev` hosts are `<script>.<subdomain>.workers.dev` and cannot take this shape, so `parseDevDomain()` refuses `workers.dev` with a message saying so (NEEDS INPUT 1). One fidelity gap follows from one zone: cire and musubi dev hosts are same-site with each other, while in production they are cross-site; a defect that depends on them being cross-site will not show on dev.

2. **One Alchemy job per stack deploys the whole stack and runs every smoke check; one record job per surface carries its Deployment record.** Stack jobs (`stack-<stack>-dev`) build every site in the stack, deploy with `--stage dev --yes` and no `--include`, then run the smoke check (and rollback) for each of the stack's surfaces as steps of the same job, all inside one concurrency group per stack (`deploy-dev-<stack>`, `cancel-in-progress: false`), so no rollback can race the next run's deploy, as today's dev jobs keep deploy and check in one group. Deploying the whole stack means a later run carries every earlier change at its SHA, so a cancelled pending run never strands a change. No stack job needs another. The per-surface jobs keep today's ids and names (`deploy-cire-api-dev`, "Deploy cire/api — dev", …), run in the `dev` Environment, and run only when their stack job's deploy step succeeded and their surface's smoke check passed (explicit `if:` with `!cancelled()`); each leaves the per-surface record `scripts/release-plan.ts` reads by job name.

3. **Rollback judged by deployment id; a rolled-back Worker is re-uploaded on the next run.** Alchemy reports no version id for a normal deploy, and plans against its state, not the live Worker (Facts). The stack job snapshots each Worker's newest deployment before the deploy and compares after (`scripts/worker-deployments.ts`), and gives each smoke step `SMOKE_DEPLOYMENT=<the new deployment id>` or `unchanged`. The smoke check never rolls back an `unchanged` Worker, and rolls back a changed one only while the newest deployment is still that id. Because a rollback leaves Alchemy's state claiming the version it replaced, the snapshot also reports every Worker whose newest deployment carries the smoke-check rollback annotation (Facts), and the deploy then runs with `--force`, re-uploading what the commit declares; and the smoke check fails an `unchanged` Worker whose newest deployment carries that annotation, so a failed heal can never record success. Production keeps `WRANGLER_OUTPUT_FILE_PATH` unchanged.

4. **Migrations are flattened before Alchemy reads them.** Alchemy refuses each of our three directories because of `meta/_journal.json` (Facts). `flattenMigrations()` copies the top-level `*.sql` files, names unchanged, into `<stack>/.generated/migrations/<database>/`, emptying the target first, and the D1 resource's `migrations` points there. Names stay identical to Wrangler's ledger names, which P3's ledger conversion will match on.

5. **Seeds through D1 `importFiles`; no stack calls another.** (Known risk, unverified: Alchemy's import dies when Cloudflare's import `init` returns no upload URL, which may happen when a file's content returns to one imported before, for example `CIRE_DEV_OWNER_PROFILE_ID` set back to an earlier value. Changing the content again recovers. `wiki/shared/dev-environment.md` records it.)
   - cire: `cire/db/seed/dev-seed.sql`, then a generated owner-seat file when `CIRE_DEV_OWNER_PROFILE_ID` is set.
   - osn, one generated file:
     - an upsert of the `cid_cire` OIDC client row, its redirect URI from `stageHosts()` and its hash the SHA-256 hex of `CIRE_OIDC_CLIENT_SECRET`, as osn-api's own check computes it;
     - an upsert of cire-api's ARC service account and key (`service_accounts`, `service_account_keys`), the public JWK derived from `CIRE_API_ARC_PRIVATE_KEY`, written as `POST /graph/internal/register-service` writes them (`osn/api/src/routes/graph-internal.ts:320-365`), with every scope cire-api requests. The seed is authoritative for its own key id, so it assigns that id to `cire-api` even if another row holds it (the route's refusal guards against a holder of the shared secret pivoting between services, which a deploy holding every secret is not).
   - So the musubi stack job reads `CIRE_OIDC_CLIENT_SECRET`, `CIRE_API_ARC_KEY_ID` and `CIRE_API_ARC_PRIVATE_KEY` (`STACK_STEP_SECRETS`), and the cire job never calls osn-api.
   - Every generated file is byte-identical for identical inputs, so a second deploy re-imports nothing.
   - The dev asset bucket is filled once by the existing `assets:seed:dev`, run by the owner with the dev account's credentials (Facts).

6. **`cire-dev-db-rebuild.yml` is retired, not rewritten.** Its stated purpose is proving the chain builds from zero on real D1, to catch DDL that `bun:sqlite` accepts and D1 rejects. Alchemy now applies every new migration to the dev D1 on every merge, which catches that class at the migration that introduces it; the from-zero chain still runs in memory on every pull request (`cire/api/tests/db/ddl-lockstep.test.ts`) and for real on the new account's first deploy. A rewrite would need the whole cire stack (every site built) or a selective deploy whose declaration still evaluates every site (Facts, `--include`), for little left to prove. Dev data stops being reset nightly.

7. **The module registry stays as it is today.** Bundled API Workers declare `legacy_module_registry` beside their flags, so osn-api, cire-api and zap-api keep the module registry Wrangler deploys them with; the registry change becomes its own change later, on both tiers at once. cire-invites (prebuilt, `bundle: false`) passes `["nodejs_compat"]` verbatim. Pulse landing's new entry module takes Alchemy's defaults (a new Worker, nothing to match).

8. **Stacks refuse production in P1.** Every stack declaration throws `StageNotDeclaredError` for the production tier, naming englishstreetventures/osn#1490 phase P3. Investigation stages are accepted (names through `physicalName()`, hosts through `stageHosts()`), per the spec's Investigation stacks decision.

9. **The stage-to-account guard.** `assertDevDeployTarget(stage, env)` requires `OSN_DEPLOY_TIER` equal to `tierOf(stage)` and both `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` non-blank, so Alchemy takes the account from the environment and never from a stored profile; `refuseDotEnvFiles(cwd)` refuses a stack directory holding a `.env` file Bun would load into `process.env`. The deploy step sets `OSN_DEPLOY_TIER: dev` beside the dev credentials. It closes the P0 plan's "P1, stage against account" item.

10. **`OSN_API_URL` becomes a var on dev.** It names the dev osn-api host, so it derives from `DEV_DOMAIN` and leaves the cire-api dev secret row; production keeps it as a secret (P3 decides there).

11. **cire-invites on dev keeps its current Astro build** (P2 moves it to Alchemy's Astro path). The cire stack uploads `cire/invites/dist/server/entry.mjs` with `bundle: false` and `cire/invites/dist/client` as assets, into the new account. Its dev build takes `ASTRO_KEY` from a `dev` Environment secret of that name, so two builds of the same commit are byte-identical and a second deploy can plan no change (Facts); the build step refuses to run without it. That secret is the one secret a build step reads (W3's allow-list): it is neither a Cloudflare credential nor a Worker secret, which is what the spec keeps out of build steps.

12. **A smoke target behind Access probes without the token when the token is absent**, instead of being skipped: a missing token then fails the job (Access answers, judged `blocked`, no rollback) rather than passing it vacuously.

13. **The free-tier alert watches both accounts** with a read-only dev token in the `dev` Environment, `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY`, and an account label in each issue.

14. **API Workers are bundled by Alchemy (rolldown), with a recorded fallback.** The owner's decision is that Alchemy uploads and Wrangler stays for local development, so the stacks give osn-api, cire-api and zap-api their `src/index.ts` as `main` with `bundle: true`. Task 5 Step 0 bundles all three offline first. A Worker rolldown cannot bundle instead uploads its existing `build` output (`wrangler deploy --dry-run --outdir dist`, which turbo already runs) with `bundle: false`; that is a deviation, reported as NEEDS INPUT 6.

15. **musubi social drops its `_redirects` rule on the Worker only.** `siteWorkerProps` takes `redirectsFile: boolean`; musubi social passes `false`, which sends an empty `redirects` that overrides the built file (`ALC/Cloudflare/Workers/Assets.ts:259-275`), and its single-page not-found handling serves deep links. The file stays for production's Pages project.

16. **`shared/infra/` is deploy tooling, not surface content.** No surface imports it, so it leaves `SHARED_CONTENT` in `scripts/deploy-surfaces.ts` and joins every stack's dev paths: an infra-only change redeploys the dev stacks and offers nothing to production.

## NEEDS INPUT (owner) — none blocks writing the code

1. **Dev domain or `workers.dev`.** Options: (a) a dev-only domain added as a zone in the dev account; (b) `workers.dev`. Recommend (a): the identity flows depend on a WebAuthn RP ID, a session marker cookie on the app's apex and fixed OIDC redirect URIs, which (a) gives the same shape as production, and `workers.dev` is on the Public Suffix List. The code supports (a) only; (b) needs a different `stageHosts()`.
2. **The host labels** in Decision 1. Recommend them as written; changing them is one function and its tests.
3. **Cloudflare Access on the new dev hosts.** Options: (a) one Access application over the browser hosts (cire invite, host, vendor, landing, musubi social, musubi landing, pulse landing) with email one-time PIN, plus a service token in the `dev` Environment for the smoke checks; (b) no Access. Recommend (a), matching today's dev tier (`wiki/shared/dev-environment.md` §5). Never on the API hosts. Either way, every dev Worker also serves version preview URLs on `*.workers.dev` (`shared/infra/src/worker.ts:122, 191`), which an Access application over the custom hosts does not cover; under (a), add the Workers' `workers.dev` preview hosts to the application, or ask for previews off on dev until P4.
4. **Turnstile.** Options: (a) add the dev domain to the existing widget's hostname list; (b) a dev widget in the dev account and a dev `PUBLIC_TURNSTILE_SITEKEY`. Recommend (a).
5. **zap gains a dev gate on production releases.** zap-api has no dev job today, so the release planner never holds it (`scripts/deploy-surfaces.ts:112-116`); with its first dev Worker it gets a dev job, and the planner holds any surface with a dev job until a dev record with the same content succeeded (`scripts/release-plan.ts:522-525, 551-565`). That changes how production releases treat zap, which "production untouched" did not foresee. Options: (a) accept it — zap production then ships only after its dev deploy passed, as every other surface does; (b) exempt zap from the dev gate until P3. Recommend (a): it is what the gate exists for, and the dev account exists before this merges. The code implements (a).
6. **Only if Task 5 Step 0 finds a Worker rolldown cannot bundle:** (a) keep that Worker on its Wrangler `build` output uploaded by Alchemy (`bundle: false`), or (b) fix the bundling first and hold P1. Recommend (a) for P1, with the bundler change as its own later change. The report states which Workers, if any, fell back.

## What the owner does tomorrow (after englishstreetventures/osn#1538's first block)

GitHub `dev` Environment:

- **Variables:** `DEV_DOMAIN` (the zone, the bare domain with no scheme). `PUBLIC_TURNSTILE_SITEKEY` and `PUBLIC_GOOGLE_MAPS_EMBED_KEY` stay as they are. Unset `CIRE_DEV_OWNER_PROFILE_ID` until the proofs below have run (its profile lives in the old database; setting it changes a seed file and so the next plan).
- **Secrets — credentials:** `CLOUDFLARE_DEV_ACCOUNT_ID`; `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN` (Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Secrets Store Edit, Account Settings Read, and on the dev zone Zone Read, DNS Edit, Workers Routes Edit); `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY` (Account Settings Read, D1 Read, Account Analytics Read).
- **Secrets — osn-api:** `DEV_LOGIN_SECRET`, `INTERNAL_SERVICE_SECRET` (also read by zap-api), `OSN_JWT_PRIVATE_KEY`, `OSN_JWT_PUBLIC_KEY`, `OSN_PAIRWISE_SALT`, `OSN_SESSION_IP_PEPPER`, `OSN_TOTP_ENCRYPTION_KEY`, `RESEND_API_KEY`, `UPSTASH_REDIS_REST_TOKEN`, `UPSTASH_REDIS_REST_URL`.
- **Secrets — cire-api:** `CIRE_API_ARC_KEY_ID`, `CIRE_API_ARC_PRIVATE_KEY` (a raw ES256 JWK; with the key id also read by the musubi stack to seed the public key), `CIRE_OIDC_CLIENT_SECRET` (also read by the musubi stack to seed its hash), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PLATFORM_WEBHOOK_SECRET`.
- **Secret — the guest site's build:** `ASTRO_KEY`, made with `bunx --bun astro create-key` in `cire/invites` (the key Astro encrypts server-island props with; fixed so that builds repeat).
- **Secrets — Access smoke checks:** `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` (a service token in the dev account's Zero Trust organisation), set before the first deploy if any dev host is behind Access: a host behind Access with no token fails its smoke check, and its production releases are held.
- Set each with `printf '%s' "$VALUE" | gh secret set NAME --env dev --repo englishstreetventures/osn`.

Cloudflare (dev account, dashboard):

- The dev zone active in the account (registrar nameservers), the `workers.dev` subdomain registered, R2 and Images enabled.
- Zero Trust organisation, one Access application over the browser hosts, and the service token (NEEDS INPUT 3).
- Turnstile hostnames (NEEDS INPUT 4).
- Stripe test mode: webhook endpoints `https://api.cire.<D>/api/stripe/webhook` and `https://api.cire.<D>/api/stripe/platform-webhook`; put their signing secrets in the Environment. The `dev-hosts` step prints both URLs in every stack run's summary.
- Run the **Alchemy state store** workflow: `tier: dev, action: bootstrap`, then `action: check`.

Every value above is set **before the merge**: the merge push itself deploys every dev stack (it changes `deploy.yml` and the surface map). Then, on `main`:

1. The merge push deploys everything; the first deploy creates every resource. (If it ran before a value was set, dispatch **Deploy** once the value is in.)
2. Dispatch **Deploy** with `expect_no_change: true`: every stack job must report `Plan: no changes`.
3. Dispatch **Deploy** with `force: true` and `smoke_fail: osn_social`: musubi social is re-uploaded, its check fails, it is rolled back, and the job goes red. A site Worker holds no secrets, so the rollback is certain.
4. Dispatch **Deploy** plainly: the musubi stack sees the rollback, deploys with `--force`, and goes green: the self-heal.
5. Dispatch **Deploy** with `force: true` and `smoke_fail: osn_api`: either osn-api is rolled back (then dispatch plainly once more to heal), or Cloudflare's "secrets changed" refusal (code 10220) is reported by name. Either answer settles how rollback behaves for a Worker whose secrets Alchemy re-sends.
6. Sign in on the dev musubi social host with a passkey, then set `CIRE_DEV_OWNER_PROFILE_ID` to that profile's id and dispatch once more; sign in to the cire host.
7. Fill the dev asset bucket once: `CLOUDFLARE_ACCOUNT_ID=<dev account> CLOUDFLARE_API_TOKEN=<dev token> bun run --cwd cire/db assets:seed:dev`.

Then delete from the current account: Workers `osn-api-dev`, `cire-api-dev`, `cire-invites-dev`; D1 `osn-db-dev`, `cire-db-dev`; R2 `cire-assets-dev`, `cire-sheets-dev`; Pages `osn-social-dev`, `cire-host-dev`, `cire-vendor-dev`, `cire-landing-dev`; the dev DNS records on `cireweddings.com` and `musubi.social`; the Access application `cire dev tier`; and from the `dev` Environment `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN_DEV`.

## Every value that names a dev host, and where it comes from after P1

All derive from `stageHosts(readDevDomain(env), stage)`; the workflow reaches them through the `dev-hosts` step's outputs (`steps.hosts.outputs.<key>`), the stacks through the function.

| Value | Today (file:line) | After P1 |
|---|---|---|
| osn-api `OSN_RP_ID` | `osn/api/wrangler.toml:158` | musubi stack var, `hosts.musubiSocial` |
| osn-api `OSN_ORIGIN` | `osn/api/wrangler.toml:160` | `origin(musubiSocial)` |
| osn-api `OSN_ISSUER_URL` | `osn/api/wrangler.toml:161` | `origin(osnApi)` |
| osn-api `OSN_CORS_ORIGIN` | `osn/api/wrangler.toml:166` | `origin(musubiSocial)` |
| osn-api `DEV_LOGIN_RETURN_ORIGINS` | `osn/api/wrangler.toml:171` | musubi social, cire host, cire vendor, cire invites origins |
| osn-api `OSN_AUTHORIZE_UI_URL` | `osn/api/wrangler.toml:172` | `${origin(musubiSocial)}/authorize` |
| osn-api `OSN_COOKIE_DOMAIN` | `osn/api/wrangler.toml:179` | `hosts.musubiSocial` |
| osn-api custom domain | `osn/api/wrangler.toml:196-198` | `domain: hosts.osnApi` |
| cire-api `WEB_ORIGIN` (guest, organiser, vendor) | `cire/api/wrangler.toml:334` | invites, host, vendor origins, in that order |
| cire-api `OSN_JWKS_URL` | `cire/api/wrangler.toml:338` | `${origin(osnApi)}/.well-known/jwks.json` |
| cire-api `OSN_ISSUER_URL` | `cire/api/wrangler.toml:339` | `origin(osnApi)` |
| cire-api `CIRE_API_ORIGIN` (and so the OIDC redirect URI) | `cire/api/wrangler.toml:344`; `cire/api/src/index.ts:459` | `origin(cireApi)` |
| cire-api `OSN_API_URL` (secret today) | `shared/infra/src/secrets/inventory.ts:91` | var, `origin(osnApi)` |
| cire-api custom domain | `cire/api/wrangler.toml:381-383` | `domain: hosts.cireApi` |
| cire-invites name and custom domain | `.github/workflows/deploy.yml:404-405` | cire stack, `domain: hosts.cireInvites` |
| OIDC client row redirect URI | by hand (`wiki/shared/dev-environment.md:535-539`) | musubi stack seed, `${origin(cireApi)}/api/auth/oidc/callback` |
| zap-api `OSN_JWKS_URL`, `OSN_ISSUER_URL`, `OSN_API_URL` | none on dev (`zap/api/wrangler.toml:29-31` are local) | zap stack vars from `osnApi` |
| zap-api custom domain | none | `domain: hosts.zapApi` |
| invites build `PUBLIC_API_URL`, `PUBLIC_SITE_URL`, `PUBLIC_MARKETING_URL` | `.github/workflows/deploy.yml:362-364` | `steps.hosts.outputs.cire_api_origin`, `…cire_invites_origin`, `…cire_landing_origin` |
| host build `PUBLIC_CIRE_API_URL`, `PUBLIC_OSN_ACCOUNT_URL`, `PUBLIC_CIRE_WEB_URL` | `.github/workflows/deploy.yml:495-500` | `…cire_api_origin`, `…musubi_social_origin`, `…cire_invites_origin` |
| vendor build `PUBLIC_CIRE_API_URL`, `PUBLIC_OSN_ACCOUNT_URL` | `.github/workflows/deploy.yml:578-579` | `…cire_api_origin`, `…musubi_social_origin` |
| cire landing build `PUBLIC_ORGANISER_URL`, `SITE` | `.github/workflows/deploy.yml:656-657` | `…cire_host_origin`, `…cire_landing_origin` |
| musubi social build `VITE_OSN_ISSUER_URL` | `.github/workflows/deploy.yml:829` | `…osn_api_origin` |
| musubi landing, pulse landing build `SITE` | `.github/workflows/deploy-osn-pulse-landing.yml:60` (production-account preview, untouched) | `…musubi_landing_origin`, `…pulse_landing_origin` |
| musubi landing build `PUBLIC_APP_URL` | `musubi/landing/src/lib/site.ts:10` (default `http://localhost:1422`) | `…musubi_social_origin` |
| pulse landing build `PUBLIC_APP_URL` | `pulse/landing/src/lib/site.ts:11` (default `http://localhost:3001`) | none: the Pulse app has no dev deploy; left unset and recorded |
| ARC key registration of cire-api | by hand (`wiki/shared/dev-environment.md:541-547`) | musubi stack seed (no host involved) |
| cire sites' `_headers` API origin | `cire/build-tools/src/tier-headers.ts:88-125`, from the build env above | unchanged mechanism, fed by the build env above |
| Smoke-check dev probe hosts | `scripts/smoke-check.ts:158, 172, 187` | `SMOKE_ORIGIN` / `SMOKE_MARKETING_ORIGIN` from the stack job's `steps.hosts.outputs.*` |
| Comments naming old dev hosts | `cire/build-tools/src/tier-headers.ts:12`; `osn/api/src/routes/auth/dev-login.ts:65` | reworded (Task 12) |
| Stripe webhook endpoints | Stripe dashboard (no repository value) | printed by `dev-hosts` to the run summary; registered by the owner |
| Latency probe target | `cire/api/scripts/d1-latency-probe.ts:131-166` (reads `[env.dev]`) | `CIRE_API_ORIGIN` from `dev-hosts` |
| Turnstile and Access hostnames | dashboards | dashboards (owner, NEEDS INPUT 3–4) |

---

## File structure

| Path | Responsibility |
|---|---|
| `shared/infra/src/hosts.ts` | `parseDevDomain`, `readDevDomain`, `stageHosts`, `origin`, `PRODUCTION_ZONES` |
| `shared/infra/src/target.ts` | `assertDevDeployTarget`, `refuseDotEnvFiles`, `StageNotDeclaredError`, `refuseProductionTier` |
| `shared/infra/src/migrations.ts` | `flattenMigrations` |
| `shared/infra/src/worker.ts` (modify) | `ApiWorkerInput.bundle`, `ApiWorkerInput.assets`; `SiteWorkerInput.entry` |
| `shared/infra/src/stacks.ts` | `StackKey`, `STACK_WORKERS`, `STACK_STEP_SECRETS` |
| `shared/infra/src/secrets/inventory.ts`, `shared/infra/src/accounts.ts` (modify) | zap dev row, shared dev secret, cire dev `OSN_API_URL`; the dev read-only token |
| `shared/infra/scripts/dev-hosts.ts`, `shared/infra/scripts/plan-summary.ts` | the two CLIs |
| `musubi/infra/**`, `cire/infra/**`, `zap/infra/**`, `pulse/infra/**` | the four stacks: `package.json`, `tsconfig.json`, `vitest.config.ts`, `turbo.json`, `alchemy.run.ts`, `src/declaration.ts`, `tests/*` (musubi and cire add `src/seeds.ts`) |
| `pulse/landing/src/lib/geo.ts`, `pulse/landing/worker/index.ts` | the geo handler shared by the Pages Function and the new Worker entry |
| `scripts/deploy-surfaces.ts`, `scripts/release-plan.ts` (modify) | new surfaces, stacks, optional production |
| `scripts/smoke-check.ts` (modify), `scripts/worker-deployments.ts` (new) | dev origins from env, deployment-id rollback, site probes |
| `.github/workflows/deploy.yml` (rewrite) | stack jobs (deploy and smoke checks) and record jobs |
| `.github/workflows/free-tier-ceiling-alert.yml`, `scripts/check-free-tier-ceilings.ts` (modify) | two accounts |
| retired | `.github/workflows/cire-dev-db-rebuild.yml`, `scripts/cire-db-reset.sh`, `scripts/cire-dev-db-guard.ts` and its two tests, `[env.dev]` of `osn/api/wrangler.toml` and `cire/api/wrangler.toml`, the dev branch of `scripts/cire-db-seed.sh`, `db:migrate:dev` / `db:seed:dev` / `db:reset:dev`, the dev path of `set-osn-api-secret.yml` |
| `.gitignore` (modify) | `*/infra/.generated/` |
| `.changeset/*.md` | two changesets (Task 14) |
| wiki pages (Task 14) | see "Stale pages" |

### Stale pages (Task 14 updates every one)

`wiki/shared/infrastructure-as-code.md`, `wiki/shared/dev-environment.md`, `wiki/shared/production-deploy.md` (its dev-tier and smoke-check sections), `wiki/compliance/access-control.md`, `wiki/shared/monorepo-structure.md`, `wiki/shared/database-environments.md`, `wiki/shared/free-tier-limits.md`, `wiki/osn/oidc-provider.md` (registered clients on dev), `wiki/osn/arc-tokens.md` (dev registration), `wiki/cire/cire-development.md` (dev commands), `wiki/osn/sessions.md`, `wiki/cire/cire-landing.md`, `wiki/cire/stripe-webhooks.md` (each names a dev host), `AGENTS.md` ("A merge to `main` deploys the dev tier (`*.dev.…`)").

## Tests this change deletes or replaces

| Deleted or changed test | What covers that behaviour afterwards |
|---|---|
| `scripts/tests/cire-dev-db-guard.test.ts`, `cire-dev-db-guard.cli.test.ts` | Nothing, on purpose: the guard protected the unattended Wrangler reset of `cire-db-dev`, which is retired with the workflow (Decision 6). No remaining path resets a remote database. |
| `scripts/tests/smoke-targets.test.ts` dev cases (route of `[env.dev]`, the invites retarget step, dev `PUBLIC_MARKETING_URL`) | `scripts/tests/deploy-workflows.test.ts`: each stack job's smoke steps pass `SMOKE_ORIGIN`/`SMOKE_MARKETING_ORIGIN` from its own `steps.hosts.outputs` (Task 11); `shared/infra/tests/workflow-hosts.test.ts`: every host output the workflow reads is one `dev-hosts` writes (Task 11) |
| `scripts/tests/smoke-check.test.ts` cases using the hard-coded dev hosts, and "skipped when no Access token" | Rewritten in Task 10 against origins passed in env; the skip case becomes "probes without the token and fails blocked" (Decision 12) |
| `scripts/tests/deploy-workflows.test.ts` dev `wrangler deploy` step assertions (`:218-277` dev rows, `:105-114`) | Stack-job and record-job assertions (Task 11); production rows unchanged |
| `scripts/tests/deploy-surfaces.test.ts` "names eight surfaces", "every surface but zap has a dev job", the smoke-check redeploy case | Updated to ten surfaces, every surface has a dev job, production surfaces exclude the two landings (Task 9) |
| `cire/api/tests/index.test.ts:975-982` (reads `[env.dev.vars] WEB_ORIGIN` entry 2) | Same assertion against `[env.production.vars] WEB_ORIGIN`; dev order (guest, organiser, vendor) asserted by `cire/infra/tests/declaration.test.ts` (Task 6, Task 12) |
| `cire/api/tests/scripts/d1-latency-probe.test.ts` cases reading `[env.dev]` | Rewritten for the origin from env and the limiter from the top-level config (Task 12) |
| `cire/api/tests/app.test.ts:66-75` (CORS preflight for the origins in `[env.dev.vars] WEB_ORIGIN`) | The same preflight test run against `[env.production.vars] WEB_ORIGIN`; the dev list's three origins asserted by `cire/infra/tests/declaration.test.ts` (Task 12) |
| `cire/api/tests/lib/reconcile-alert-email.test.ts:128-139` (reads the dev bucket names from `[env.dev]`) | The same assertions against `[env.production]`'s bucket names; the dev names asserted by `cire/infra/tests/declaration.test.ts` K1 (Task 12) |
| `cire/api/tests/services/r2-reconcile.test.ts:1250-1270` (tier keys `dev`, `production`, `top`) | Expects `production` and `top` (Task 12) |
| `scripts/tests/cire-db-migrate.test.ts:351-367` (three D1 blocks in `cire/api/wrangler.toml`) | Expects two (Task 12) |
| `scripts/tests/fake-github.ts:142, 160` (reads `surface(key).production.name`) | Reads it only for production surfaces (Task 9) |
| `scripts/tests/smoke-check.test.ts:1046` (`["zap_api","dev"]` is a usage error) | zap has a dev target now: the case becomes an unknown surface (`["no_such_surface","dev"]`) still exiting 2, and zap's dev target is covered by the dev probe cases (Task 10) |

## Failure modes, written before code (one isolated test each; no other unit tests)

The E2E proof is tomorrow's deploy (Done when, issue #1553) and cannot run today. Isolated tests are one per entry below, in the task named.

- **Hosts (Task 1):** H1 `DEV_DOMAIN` unset or empty → `MissingDevDomainError` naming `DEV_DOMAIN`. H2 padded, upper-case, scheme, path, port, trailing dot, single label, label over 63, name over 253 → `InvalidDevDomainError`. H3 a production zone or a name under one → refused. H4 `workers.dev`, `pages.dev` or a name under either → refused, message names NEEDS INPUT 1. H5 production stage → refused. H6 investigation stage → every host under `<stage>.<D>`. H7 a derived host over 253 characters → refused.
- **Deploy target (Task 1):** T1 `OSN_DEPLOY_TIER` unset → refused. T2 `OSN_DEPLOY_TIER` naming the other tier → refused. T3 `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN` unset or blank → refused. T4 production stage → `StageNotDeclaredError` naming phase P3. T5 a stack directory holding any of the eight `.env` files Bun loads (`.env`, `.env.local`, and the `.development`, `.production` and `.test` pairs) → refused.
- **Migrations flattener (Task 2):** M1 `meta/_journal.json` and every non-`.sql` file left out. M2 a `.sql` in a subdirectory left out. M3 names and bytes copied exactly. M4 a file left in the target by an earlier run removed. M5 no `.sql` in the source → throws. M6 a target inside the source → throws.
- **Builders (Task 2):** B1 `bundle: false` reaches the props. B2 assets config mapped field for field. B3 `assets: null` → no `assets` prop. B4 a site `entry` → `main`, `compatibility` and `runWorkerFirst`; no `entry` → no `main`. B5 `importFiles` reach the D1 props; any on production → refused. B6 `requireSeedSecret` refuses unset, blank or padded, naming the variable only. B7 a site with `redirectsFile: false` sends an empty `redirects`; `true` sends none (the file applies). B8 (found in Task 5) a bundled API Worker passes rolldown `external` = Alchemy's own two (`lightningcss`, `fsevents`) plus the Bun-only `drizzle-orm/bun-sqlite`, because an `external` override replaces Alchemy's list and rolldown otherwise folds `shared/db-utils`'s non-literal specifier into a chunk importing `bun:sqlite`; a prebuilt Worker passes no build options. B9 (found in Task 5) `assertStackRetained({ stage, storage, workers })` always asserts storage, and asserts Workers only where `removalFor("worker", stage)` retains them, so an investigation stage, whose Workers are destroyed with it, passes.
- **Inventory and accounts (Task 3):** I1 zap-api dev requires `INTERNAL_SERVICE_SECRET`. I2 the dev `INTERNAL_SERVICE_SECRET` pair is listed in `SHARED_SECRET_VALUES` (the existing shared-name test fails until it is). I3 cire-api dev no longer declares `OSN_API_URL`, so passing it as a dev secret throws `UndeclaredSecretsError`; on production a var beside the secret throws `BindingNameClashError`. I4 the dev read-only token is classified, allowed in `dev`, forbidden in `production`.
- **CLIs (Task 4):** C1 `dev-hosts` without `DEV_DOMAIN` exits 2 and writes no output. C2 `plan-summary --expect-no-change` passes on `Plan: no changes`. C3 fails on any count and prints the counts. C4 ANSI colour and the pretty logger's prefix are stripped before matching. C5 no `Plan:` line → a warning and exit 0 without `--expect-no-change`, exit 1 with it. C6 `Plan: no resources` fails `--expect-no-change`. C7 the summary it writes carries counts only, never the raw line.
- **Seeds (Tasks 5–6):** S1 the OIDC row's hash verifies against osn-api's own client-secret check. S2 its redirect URI equals the one cire-api builds from `CIRE_API_ORIGIN`. S3 a missing or blank `CIRE_OIDC_CLIENT_SECRET`, `CIRE_API_ARC_KEY_ID` or `CIRE_API_ARC_PRIVATE_KEY` → refused, no file. S4 the SQL never contains a secret: not the client secret, and not the private key's `d`. S5 identical inputs → identical bytes. S6 an invalid `CIRE_DEV_OWNER_PROFILE_ID` → refused; unset or empty (a GitHub variable that is not set reaches the step as `""`) → no owner-seat file. S7 the ARC rows carry exactly the scopes cire-api requests (the `ARC_*_SCOPE` constants of `cire/api/src/services/osn-bridge.ts`, read as text), each in osn-api's permitted set (`osn/api/src/routes/graph-internal.ts:74-82`). S8 the public JWK is EC P-256 with `x` and `y` and no `d`, and is importable with WebCrypto as ES256. S9 a key id that is not a UUID → refused. S10 the key upsert leaves the key id owned by `cire-api` whatever held it before (applied to an in-memory SQLite built from `osn/db/drizzle/*.sql`, with a row for another service already holding the id).
- **Stacks (Tasks 5–8):** K1 each Worker, database and bucket takes today's dev name. K2 parity with Wrangler `[env.production]`: binding, var and secret names equal, apart from a listed set of differences, each with a reason. K3 compatibility date and flags equal Wrangler's plus `legacy_module_registry`; crons equal production's. K4 invocation logs off on cire-api and cire-invites. K5 every storage resource retained. K6 dev buckets declared with production's settings; each dev database with its production database's read replication, in `oc`. K7 no literal host in stack source. K8 a production stage throws. K9 every `env.NAME` (and `env["NAME"]`) an API Worker's source reads is a declared var, binding or secret, or on a per-Worker list of names deliberately unset on dev, each with a reason. K10 (found in Task 5) bundling each API Worker offline through Alchemy's rolldown path (`alchemy/Cloudflare/Workers/Sources/Rolldown`, with the stack's build options) yields no module that names `bun:sqlite` (Task 5 for osn-api, Task 6 for cire-api, Task 7 for zap-api).
- **Pulse geo (Task 8):** G1 `GET /api/geo` answers the JSON shape with `cache-control: private, max-age=300`. G2 any other path goes to `ASSETS`. G3 a non-GET to `/api/geo` answers 405.
- **Surface map (Task 9):** P1 a change under `cire/infra/` redeploys every cire dev surface and no production surface. P2 a change under `musubi/landing/` runs the musubi stack. P3 the `changes` job writes one `stack_<key>` output per stack. P4 the production planner never lists `musubi_landing` or `pulse_landing`. P5 a change to `scripts/smoke-check.ts` or `scripts/worker-deployments.ts` redeploys every dev surface. P6 a change under `shared/infra/` runs every dev stack and offers no production surface. P8 a change under `zap/infra/` runs the zap stack and offers no production surface.
- **Smoke check (Task 10):** Q1 dev without `SMOKE_ORIGIN` → exit 2. Q2 `SMOKE_ORIGIN` not an https origin → exit 2. Q3 dev without `SMOKE_DEPLOYMENT` → exit 2. Q4 `SMOKE_DEPLOYMENT=unchanged` never rolls back. Q5 a deployment id that is no longer the newest → rollback refused. Q6 the newest is the id → restores the earlier 100% version. Q7 `html` expectation fails on 404. Q8 `jsonObject` fails on a non-JSON 200. Q9 an Access target with no token probes without it, and a redirect to `*.cloudflareaccess.com` fails the job without rollback. Q10 `worker-deployments` treats a Worker that does not exist as `none` before and reports the new id after. Q11 an API failure exits 1. Q12 an unknown surface exits 2. Q13 the token never reaches output. Q14 `snapshot` writes `force=true` when any Worker's newest deployment carries the smoke-check rollback annotation, `force=false` otherwise. Q15 an `unchanged` Worker whose newest deployment carries that annotation fails its check without a rollback, naming the fix (the next run forces a re-upload). Q16 `SMOKE_DEPLOYMENT=unknown` probes and never rolls back; `compare` writes `unknown` for an unreadable Worker and still writes every other surface's line before exiting 1.
- **Workflow (Task 11):** W1 stack jobs equal `STACKS`, in `dev`, one concurrency group each, never cancelled, needing only `build` and `changes`. W2 record jobs equal the dev jobs of `SURFACES`, need their stack job, run in `dev`, and carry `if: ${{ !cancelled() && needs.<stack>.outputs.deployed == 'true' && needs.<stack>.outputs.<surface>_healthy == 'true' }}`. W9 every smoke step runs `if: ${{ !cancelled() && steps.snapshot.outcome == 'success' }}`, with `continue-on-error: true`, and a last step fails the job when any smoke step failed. W10 `force` and `expect_no_change` together are refused, and so is `expect_no_change` while the snapshot reports a rollback awaiting re-upload. W3 each deploy step's secrets equal the dev inventory secrets of its stack's Workers plus `STACK_STEP_SECRETS`; no install or build step holds a secret or a credential. W4 every dev host value in a build or smoke step is a `steps.hosts.outputs.*` or `needs.*.outputs.*` expression, never a literal URL. W5 no `wrangler deploy` or `wrangler pages deploy` in `deploy.yml`. W6 every `bun install` is `--frozen-lockfile`. W7 each step that runs Alchemy has `DO_NOT_TRACK: "1"` (already `check:alchemy-usage`). W8 the dev credentials read are exactly the `TIER_ACCOUNTS.dev` pair.

## Observability plan

No Worker code changes except pulse landing's new entry module, which is a static-site Worker with no `@shared/observability` (pulse landing has none today; its logs are Workers Logs with invocation logs off and query strings redacted, set by `siteWorkerProps`). No new metric, span or log line in any service. The CLIs write to stdout and stderr only, names and counts, never values. Nothing joins a redaction list: no new secret field is read by service code.

## Changesets

- Versioned (one file, `.changeset/alchemy-dev-stacks.md`): `@shared/infra` minor, `@musubi/infra`, `@zap/infra`, `@pulse/infra` minor (new), `@pulse/landing` patch (geo module and Worker entry), `@osn/api` patch (`wrangler.toml` loses `[env.dev]`), `@osn/db` patch (`db:migrate:dev` removed).
- Version-less (one file, `.changeset/alchemy-dev-stacks-cire.md`): `@cire/infra`, `@cire/api`, `@cire/db`.
- Never mixed (`scripts/validate-changesets.sh`).

---

## Tasks

Dispatch order is the task order; one code-writing agent at a time. Each task ends with its own commit on `feat/alchemy-dev-stacks`. Every task runs `bunx --bun oxlint -c oxlintrc.json <its changed files>` and `bun run --cwd <package> check` before committing, and records what it ran in `NEW-FEAT.md`.

### Task 1: Dev hosts and the deploy-target guard (`@shared/infra`)

**Files:**
- Create: `shared/infra/src/hosts.ts`, `shared/infra/src/target.ts`, `shared/infra/tests/hosts.test.ts`, `shared/infra/tests/target.test.ts`
- Modify: `shared/infra/src/index.ts` (export both)

**Interfaces:**
- Consumes: `parseStage`, `tierOf`, `MAX_STAGE_LENGTH` from `shared/infra/src/stage.ts`.
- Produces:
  ```ts
  // hosts.ts
  export const PRODUCTION_ZONES: readonly string[]; // ["cireweddings.com", "musubi.social", "pulse.events"]
  export class MissingDevDomainError extends Data.TaggedError("MissingDevDomainError")<{ readonly message: string }> {}
  export class InvalidDevDomainError extends Data.TaggedError("InvalidDevDomainError")<{ readonly domain: string; readonly message: string }> {}
  export function parseDevDomain(raw: string): string;
  export function readDevDomain(env: Readonly<Record<string, string | undefined>>): string; // reads env.DEV_DOMAIN
  export interface StageHosts {
    readonly musubiSocial: string; readonly osnApi: string; readonly musubiLanding: string;
    readonly cireLanding: string; readonly cireApi: string; readonly cireInvites: string;
    readonly cireHost: string; readonly cireVendor: string; readonly zapApi: string;
    readonly pulseLanding: string;
  }
  export function stageHosts(domain: string, stage: string): StageHosts;
  export const origin: (host: string) => string; // `https://${host}`
  // target.ts
  export class StageNotDeclaredError extends Data.TaggedError("StageNotDeclaredError")<{ readonly stage: string; readonly message: string }> {}
  export class DeployTargetError extends Data.TaggedError("DeployTargetError")<{ readonly stage: string; readonly message: string }> {}
  export function refuseProductionTier(stage: string): void; // throws StageNotDeclaredError for tierOf(stage) === "production"
  export function assertDevDeployTarget(stage: string, env: Readonly<Record<string, string | undefined>>): string; // returns the parsed stage
  /** Bun loads these from the working directory into process.env (`alchemy/bin/cli.js:17`); a stack directory must hold none. */
  export const DOT_ENV_FILES: readonly string[]; // ".env", ".env.local" and the .development, .production and .test pairs
  export function refuseDotEnvFiles(directory: string): void; // throws DeployTargetError naming the file
  ```

- [ ] **Step 1: Write the failing tests** — one per failure mode H1–H7 and T1–T4 (see "Failure modes"). Example shapes:

```ts
// shared/infra/tests/hosts.test.ts
import { describe, expect, test } from "vitest";
import { InvalidDevDomainError, MissingDevDomainError, parseDevDomain, readDevDomain, stageHosts } from "../src/hosts";
import { StageNotDeclaredError } from "../src/target";

describe("readDevDomain", () => {
  test("H1: an unset or empty DEV_DOMAIN is refused, naming the variable", () => {
    for (const env of [{}, { DEV_DOMAIN: "" }]) {
      expect(() => readDevDomain(env)).toThrow(MissingDevDomainError);
      expect(() => readDevDomain(env)).toThrow(/DEV_DOMAIN/);
    }
  });
});

describe("parseDevDomain", () => {
  test.each([" example.dev", "example.dev\n", "Example.dev", "https://example.dev", "example.dev/x",
    "example.dev:443", "example.dev.", "localhost", `${"a".repeat(64)}.dev`, `${"a.".repeat(127)}dev`])(
    "H2: refuses %j", (raw) => { expect(() => parseDevDomain(raw)).toThrow(InvalidDevDomainError); });
  test.each(["cireweddings.com", "dev.cireweddings.com", "musubi.social", "x.musubi.social", "pulse.events"])(
    "H3: refuses the production zone %s and every name under one", (raw) => {
      expect(() => parseDevDomain(raw)).toThrow(/production/);
    });
  test.each(["workers.dev", "acct.workers.dev", "pages.dev", "x.pages.dev"])(
    "H4: refuses %s, whose hosts cannot take this layout", (raw) => {
      expect(() => parseDevDomain(raw)).toThrow(/workers\.dev|pages\.dev/);
    });
});

describe("stageHosts", () => {
  test("H5: the production tier has no derived hosts", () => {
    expect(() => stageHosts("example.dev", "production")).toThrow(StageNotDeclaredError);
  });
  test("H6: an investigation stage puts every host under <stage>.<domain>", () => {
    const hosts = stageHosts("example.dev", "pr-7");
    for (const host of Object.values(hosts)) expect(host.endsWith(".pr-7.example.dev")).toBe(true);
  });
  test("H7: a derived host over 253 characters is refused", () => {
    const long = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(58)}.dev`; // 247
    expect(() => stageHosts(long, "dev")).toThrow(InvalidDevDomainError);
  });
});
```

```ts
// shared/infra/tests/target.test.ts — T1–T4
import { describe, expect, test } from "vitest";
import { assertDevDeployTarget, DeployTargetError, StageNotDeclaredError } from "../src/target";

const ok = { OSN_DEPLOY_TIER: "dev", CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CLOUDFLARE_API_TOKEN: "placeholder-token" };
describe("assertDevDeployTarget", () => {
  test("T1: refuses a run with no OSN_DEPLOY_TIER", () => {
    expect(() => assertDevDeployTarget("dev", { ...ok, OSN_DEPLOY_TIER: undefined })).toThrow(DeployTargetError);
  });
  test("T2: refuses a run whose OSN_DEPLOY_TIER names the other tier", () => {
    expect(() => assertDevDeployTarget("dev", { ...ok, OSN_DEPLOY_TIER: "production" })).toThrow(/OSN_DEPLOY_TIER/);
  });
  test("T3: refuses a run missing either credential, which would fall back to a stored profile", () => {
    for (const blank of [undefined, "", "  "]) {
      expect(() => assertDevDeployTarget("dev", { ...ok, CLOUDFLARE_ACCOUNT_ID: blank })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
      expect(() => assertDevDeployTarget("dev", { ...ok, CLOUDFLARE_API_TOKEN: blank })).toThrow(/CLOUDFLARE_API_TOKEN/);
    }
  });
  test("T5: refuses a stack directory holding a .env file Bun would load", () => {
    for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
      const dir = mkdtempSync(join(tmpdir(), "stack-"));
      writeFileSync(join(dir, name), "X=1");
      expect(() => refuseDotEnvFiles(dir)).toThrow(name);
    }
    expect(() => refuseDotEnvFiles(mkdtempSync(join(tmpdir(), "stack-")))).not.toThrow();
  });
  test("T4: refuses every production stage until phase P3", () => {
    expect(() => assertDevDeployTarget("production", { ...ok, OSN_DEPLOY_TIER: "production" })).toThrow(StageNotDeclaredError);
  });
});
```

The error messages name variables, never values: assert that a test value (the account id above) does not appear in any thrown message.

- [ ] **Step 2: Run, expect failure.** `bun run --cwd shared/infra test:run -- tests/hosts.test.ts tests/target.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement.**

```ts
// shared/infra/src/hosts.ts
import { Data } from "effect";
import { parseStage } from "./stage";
import { refuseProductionTier } from "./target";

/** Zones production serves from. A dev domain is never one of them or under one. */
export const PRODUCTION_ZONES: readonly string[] = ["cireweddings.com", "musubi.social", "pulse.events"];
/** Shared suffixes whose hosts are `<script>.<subdomain>.<suffix>`, which this layout cannot use. */
const SHARED_SUFFIXES: readonly string[] = ["workers.dev", "pages.dev"];
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_NAME = 253;
// classes as in Interfaces
const under = (name: string, zone: string) => name === zone || name.endsWith(`.${zone}`);

export function parseDevDomain(raw: string): string {
  const labels = raw.split(".");
  if (raw.length > MAX_NAME || labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    throw new InvalidDevDomainError({ domain: raw, message: `DEV_DOMAIN '${raw}' is not a bare lower-case domain name with at least two labels.` });
  }
  if (PRODUCTION_ZONES.some((zone) => under(raw, zone))) {
    throw new InvalidDevDomainError({ domain: raw, message: `DEV_DOMAIN '${raw}' is a production zone or a name under one.` });
  }
  if (SHARED_SUFFIXES.some((suffix) => under(raw, suffix))) {
    throw new InvalidDevDomainError({ domain: raw, message: `DEV_DOMAIN '${raw}' is under workers.dev or pages.dev, whose hosts cannot take the dev host layout; the dev tier needs a zone of its own.` });
  }
  return raw;
}

export function readDevDomain(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env.DEV_DOMAIN ?? "";
  if (raw === "") {
    throw new MissingDevDomainError({ message: "DEV_DOMAIN is unset: set it as a variable on the dev GitHub Environment to the dev account's zone." });
  }
  return parseDevDomain(raw);
}

export function stageHosts(domain: string, stage: string): StageHosts {
  const valid = parseStage(stage);
  refuseProductionTier(valid);
  const base = valid === "dev" ? parseDevDomain(domain) : `${valid}.${parseDevDomain(domain)}`;
  const hosts: StageHosts = {
    musubiSocial: `musubi.${base}`, osnApi: `id.musubi.${base}`, musubiLanding: `www.musubi.${base}`,
    cireLanding: `cire.${base}`, cireApi: `api.cire.${base}`, cireInvites: `invite.cire.${base}`,
    cireHost: `host.cire.${base}`, cireVendor: `vendor.cire.${base}`, zapApi: `zap.cire.${base}`,
    pulseLanding: `pulse.${base}`,
  };
  const tooLong = Object.values(hosts).find((host) => host.length > MAX_NAME);
  if (tooLong !== undefined) {
    throw new InvalidDevDomainError({ domain, message: `The dev host '${tooLong}' is longer than ${MAX_NAME} characters.` });
  }
  return hosts;
}

export const origin = (host: string): string => `https://${host}`;
```

```ts
// shared/infra/src/target.ts
import { Data } from "effect";
import { parseStage, tierOf } from "./stage";

export function refuseProductionTier(stage: string): void {
  if (tierOf(stage) === "production") {
    throw new StageNotDeclaredError({ stage, message: `Stage '${stage}' is the production tier, which these stacks declare from phase P3 of englishstreetventures/osn#1490.` });
  }
}

/** The stage a stack may run at, refusing a run whose credentials could reach another account. */
export function assertDevDeployTarget(stage: string, env: Readonly<Record<string, string | undefined>>): string {
  const valid = parseStage(stage);
  refuseProductionTier(valid);
  const tier = tierOf(valid);
  if (env.OSN_DEPLOY_TIER !== tier) {
    throw new DeployTargetError({ stage: valid, message: `Stage '${valid}' runs on the ${tier} tier, and OSN_DEPLOY_TIER does not say ${tier}. Set OSN_DEPLOY_TIER beside the ${tier} account's credentials.` });
  }
  // Alchemy reads the account from the environment only when both are set
  // (alchemy src/Auth/Resolve.ts:51-90); otherwise it loads a stored profile.
  for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
    if ((env[name] ?? "").trim() === "") {
      throw new DeployTargetError({ stage: valid, message: `${name} is unset, so Alchemy would choose the account from a stored profile. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to the ${tier} account's credentials.` });
    }
  }
  return valid;
}

export function refuseDotEnvFiles(directory: string): void {
  const found = DOT_ENV_FILES.find((name) => existsSync(join(directory, name)));
  if (found !== undefined) {
    throw new DeployTargetError({ stage: "", message: `${found} in ${directory} would be loaded into the stack's environment by Bun; remove it.` });
  }
}
```

`hosts.ts` and `target.ts` import each other only one way (`hosts` → `target`), so no cycle.

- [ ] **Step 4: Run, expect pass.** Same command → PASS. Then `bun run --cwd shared/infra test:run` (whole package) and `bun run --cwd shared/infra check`.
- [ ] **Step 5: Commit.** `git add shared/infra/src/hosts.ts shared/infra/src/target.ts shared/infra/src/index.ts shared/infra/tests/hosts.test.ts shared/infra/tests/target.test.ts` and commit "Infra: derive every dev host from DEV_DOMAIN and refuse a run against the wrong account".

### Task 2: Migrations flattener and builder extensions (`@shared/infra`)

**Files:**
- Create: `shared/infra/src/migrations.ts`, `shared/infra/tests/migrations.test.ts`
- Modify: `shared/infra/src/worker.ts`, `shared/infra/tests/worker.test.ts`, `shared/infra/src/storage.ts`, `shared/infra/tests/storage.test.ts`, `shared/infra/src/secrets/require.ts`, `shared/infra/tests/secrets/require.test.ts`, `shared/infra/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  // migrations.ts
  export class MigrationsSourceError extends Data.TaggedError("MigrationsSourceError")<{ readonly source: string; readonly message: string }> {}
  /** Copies the top-level *.sql files of `source` into `target` (emptied first) and returns `target`. */
  export function flattenMigrations(input: { readonly source: string; readonly target: string }): string;
  // worker.ts additions
  export interface WorkerAssetsInput {
    readonly directory: string;
    readonly htmlHandling: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
    readonly notFoundHandling: "none" | "404-page" | "single-page-application";
    readonly runWorkerFirst: boolean | readonly string[];
  }
  // ApiWorkerInput gains (both required):
  readonly bundle: boolean;          // false: `main` is a prebuilt Worker uploaded byte for byte
  readonly assets: WorkerAssetsInput | null;
  // SiteWorkerInput gains (required):
  readonly entry: { readonly main: string; readonly compatibility: { readonly date: string; readonly flags: readonly string[] }; readonly runWorkerFirst: readonly string[] } | null;
  // storage.ts: RetainedD1Input gains (required)
  readonly importFiles: readonly string[]; // SQL files Alchemy imports after migrations; refused on production
  // secrets/require.ts
  /** One secret a stack reads for itself (a seed), never uploaded to a Worker; refused unset, blank or padded. */
  export function requireSeedSecret(env: Readonly<Record<string, string | undefined>>, name: string): string;
  ```

- [ ] **Step 1: Failing tests** for M1–M6 and B1–B4. M-tests build a temporary directory with `mkdtempSync` under `os.tmpdir()`: `0001_a.sql`, `0002_b.sql`, `meta/_journal.json`, `meta/0001_snapshot.json`, `nested/0003_c.sql`, `README.md`; an earlier-run file `target/0000_stale.sql`. Assert the target lists exactly `0001_a.sql`, `0002_b.sql`, byte-equal to the source (M1–M4); an empty source throws `MigrationsSourceError` (M5); `target = <source>/flat` throws (M6). B-tests extend the existing `cireApiDev` fixture in `worker.test.ts` with `bundle: true, assets: null` and assert:
  - B1 `apiWorkerProps({ ...x, bundle: false }).bundle === false`;
  - B2 `assets` equals `{ directory, htmlHandling, notFoundHandling, runWorkerFirst }` exactly, with `runWorkerFirst` copied (not the input array instance);
  - B3 `assets: null` → `"assets" in props === false`;
  - B4 a site with `entry` has `main`, `compatibility` and `assets.runWorkerFirst`; a site with `entry: null` has no `main`.
  - B5 (storage) `importFiles` reach `retainedD1Props`; a production stage with any `importFiles` throws, because production data is never seeded.
  - B6 (require) `requireSeedSecret` refuses an unset, blank or padded value with an error naming the variable and never the value; it returns the value otherwise.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.**
  - Rewrite the doc comment on `RetainedD1Input` (`shared/infra/src/storage.ts:22-26`): `clone` acts only at creation; `importFiles` is imported after the migrations and re-imported whenever a file's content changes (`ALC/Cloudflare/D1/Database.ts:313-319, 515-524`).
  - `SiteWorkerInput` gains `redirectsFile: boolean` (required): `false` sets `assets.redirects` to `""`, which overrides the directory's `_redirects` (`ALC/Cloudflare/Workers/Assets.ts:259-275`); `true` leaves `redirects` out so the file applies. Test B7.
  - `flattenMigrations`: `resolve` both paths; refuse when `relative(source, target)` does not start with `..` (M6); `rmSync(target, { recursive: true, force: true })`; `mkdirSync(target, { recursive: true })`; copy each `readdirSync(source, { withFileTypes: true })` entry that is a file ending `.sql`, sorted by name, with `copyFileSync`; throw M5 when none. `apiWorkerProps` returns `bundle: input.bundle` and, when `assets` is not null, `assets: { directory, htmlHandling, notFoundHandling, runWorkerFirst }` (build the object without a conditional empty spread: compute `const assetsProp = input.assets === null ? {} : { assets: … }` is the banned pattern — instead return two object literals from a ternary over the whole props, or assign after construction to a `Cloudflare.WorkerProps` variable). `siteWorkerProps` adds `main` and `compatibility` from `entry`, and `runWorkerFirst: [...entry.runWorkerFirst]` into `assets`, the same way. Update every existing test fixture in `worker.test.ts` with the new required fields (`bundle: true, assets: null`; sites `entry: null`). Update the doc comments on `ApiWorkerInput` and `SiteWorkerInput` to state the new fields.
- [ ] **Step 4: Run, expect pass**, then the whole package's tests and `check`.
- [ ] **Step 5: Commit** "Infra: flatten migrations for Alchemy, prebuilt Workers with assets, and sites with an entry".

### Task 3: Inventory, accounts and the stack map (`@shared/infra`)

**Files:**
- Create: `shared/infra/src/stacks.ts`, `shared/infra/tests/stacks.test.ts`
- Modify: `shared/infra/src/secrets/inventory.ts`, `shared/infra/src/accounts.ts`, `shared/infra/tests/secrets/inventory.test.ts`, `shared/infra/tests/accounts.test.ts`, `shared/infra/src/index.ts`, `shared/infra/scripts/check-github-secrets.ts` (only if it lists credential names itself)

**Interfaces:**
- Produces:
  ```ts
  // stacks.ts
  export type StackKey = "cire" | "musubi" | "zap" | "pulse";
  export const STACK_KEYS: readonly StackKey[]; // ["musubi", "cire", "zap", "pulse"] — deploy order
  /** The inventory Workers each stack deploys. */
  export const STACK_WORKERS: Readonly<Record<StackKey, readonly WorkerKey[]>>;
  // { musubi: ["osn-api"], cire: ["cire-api", "cire-invites"], zap: ["zap-api"], pulse: [] }
  /** Secrets a stack's deploy job reads besides its Workers' own, with the step that reads each. */
  export const STACK_STEP_SECRETS: Readonly<Record<StackKey, readonly { readonly name: string; readonly step: "deploy" }[]>>;
  // musubi: CIRE_OIDC_CLIENT_SECRET, CIRE_API_ARC_KEY_ID, CIRE_API_ARC_PRIVATE_KEY, each step "deploy" (they seed the OIDC row's hash and cire-api's ARC public key)
  // cire: [], zap: [], pulse: []
  // accounts.ts
  export const DEV_READONLY_CREDENTIALS: readonly string[]; // ["CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY"]
  ```
  `allowedCredentials("dev")` gains it; `knownCredentials()` gains it; `forbiddenCredentials("production")` therefore forbids it (the existing function derives that).

- [ ] **Step 1: Failing tests** I1–I4:
  - I1: `tierSecrets("zap-api", "dev")` → `{ scriptName: "zap-api-dev", secrets: ["INTERNAL_SERVICE_SECRET"], optional: [], forbidden: ["GROWTHBOOK_CLIENT_KEY"] }`.
  - I2: needs no new test: the existing test that every name two Workers hold on one tier is listed in `SHARED_SECRET_VALUES` fails once I1 lands, until the dev pair is listed.
  - I3: `tierSecrets("cire-api", "dev").secrets` does not contain `OSN_API_URL`; on dev, `apiWorkerProps` with `secrets.OSN_API_URL` throws `UndeclaredSecretsError` naming it (the secret check runs before the clash check, `shared/infra/src/worker.ts:146`); on production, `vars.OSN_API_URL` beside the declared secret throws `BindingNameClashError`.
  - I4: `allowedCredentials("dev")` contains `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY`; `forbiddenCredentials("production")` contains it.
  - Stacks: `STACK_WORKERS` lists each inventory Worker exactly once.
  - Every `STACK_STEP_SECRETS` name is a dev inventory secret of some Worker.
  - Accounts test "only the state-store workflow reaches the dev account" becomes "only `alchemy-state.yml`, `deploy.yml` and `free-tier-ceiling-alert.yml` reach the dev account". It fails until Tasks 11 and 13 land, so mark it `test.todo` here, and Task 11 turns it on.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.**
  - Inventory zap-api dev: `{ scriptName: "zap-api-dev", secrets: ["INTERNAL_SERVICE_SECRET"], optional: [], forbidden: ["GROWTHBOOK_CLIENT_KEY"] }`.
  - cire-api dev: drop `"OSN_API_URL"` and add a comment saying it is a var on dev, derived from the dev domain.
  - `SHARED_SECRET_VALUES` += `{ tier: "dev", name: "INTERNAL_SERVICE_SECRET", workers: ["osn-api", "zap-api"] }`.
  - The inventory file's header comment: the dev rows name what the new dev account's Workers hold.
  - `DEV_READONLY_CREDENTIALS` in `accounts.ts`, with a comment saying the free-tier ceiling alert reads it.
- [ ] **Step 4: Run, expect pass**, whole package, `check`.
- [ ] **Step 5: Commit** "Infra: zap-api on dev, OSN_API_URL as a dev var, the stack map and the dev read-only token".

### Task 4: The `dev-hosts` and `plan-summary` CLIs (`@shared/infra`)

**Files:**
- Create: `shared/infra/scripts/dev-hosts.ts`, `shared/infra/scripts/plan-summary.ts`, `shared/infra/src/plan-summary.ts` (pure parser), `shared/infra/tests/dev-hosts.test.ts`, `shared/infra/tests/plan-summary.test.ts`
- Modify: `shared/infra/package.json` (scripts `dev-hosts`, `plan-summary`)

**Interfaces:**
- `bun run --cwd shared/infra dev-hosts -- --stage <stage>` reads `DEV_DOMAIN`, writes to `$GITHUB_OUTPUT` (stdout when unset) one `key=value` line per key below, and appends a host table to `$GITHUB_STEP_SUMMARY` when set. Exit 2 with no output on a missing or invalid domain or stage (C1).
  Keys (snake_case of `StageHosts`, each an https origin): `musubi_social_origin`, `osn_api_origin`, `musubi_landing_origin`, `cire_landing_origin`, `cire_api_origin`, `cire_invites_origin`, `cire_host_origin`, `cire_vendor_origin`, `zap_api_origin`, `pulse_landing_origin`; plus `oidc_redirect_uri` (`<cire_api_origin>/api/auth/oidc/callback`), `stripe_webhook_url` (`<cire_api_origin>/api/stripe/webhook`), `stripe_platform_webhook_url` (`<cire_api_origin>/api/stripe/platform-webhook`). The two Stripe paths are cire-api's routes (`cire/api/src/routes/stripe-webhook.ts:228`, `cire/api/src/routes/stripe-platform-webhook.ts:99`).
  Export `devHostOutputs(domain: string, stage: string): ReadonlyMap<string, string>` from `shared/infra/src/hosts.ts` so tests and Task 11 read the key list from code.
- `src/plan-summary.ts`:
  ```ts
  export type PlanSummary =
    | { readonly kind: "no-changes" }
    | { readonly kind: "no-resources" }
    | { readonly kind: "changes"; readonly counts: Readonly<Record<string, number>> } // create, update, adopted, replace, delete, orphaned, binding changes, tasks
    | { readonly kind: "missing" };
  export function summarisePlan(output: string): PlanSummary; // strips ANSI (/\x1b\[[0-9;]*m/g), uses the LAST line containing "Plan:"
  ```
  `bun run --cwd shared/infra plan-summary -- --stack <name> [--expect-no-change] <log file>` writes `### <stack>: <summary>` with counts only to `$GITHUB_STEP_SUMMARY`. With no `Plan:` line it writes a warning annotation and exits 0, or exits 1 under `--expect-no-change` (C5); with `--expect-no-change` it exits 1 unless `no-changes` (C2, C3, C6). It never fails a deploy that did not ask for the check. The matcher is format-agnostic: strip ANSI (`/\x1b\[[0-9;]*m/g`, the real escape character), then match `/Plan:\s+(.+?)\s*$/` on each line and use the last match.

- [ ] **Step 1: Failing tests** C1–C7. Plan fixtures are the strings `formatPlanLines` produces (`ALC/Cli/LoggingCli.ts:84-135`) as the pretty console logger prints them (`ALC/Util/ConsoleSink.ts:5-17`, `ALC/Cli/GlobalLog.ts:64-76`): read those lines first and build each fixture with a real ESC character (`"\u001b"` in a TypeScript string literal) and the logger's own prefix, citing the lines in a comment. Cases: `Plan: no changes`; `Plan: 2 to create, 1 to update, 3 binding changes`; `Plan: no resources`; a log with no plan line. C7: the summary written for a log that also holds a 32-hex account id and a `secret_text` line contains neither.
  C1 runs the CLI with `Bun.spawnSync` and an env without `DEV_DOMAIN`: exit 2, stdout empty, a temp `GITHUB_OUTPUT` file left empty.
- [ ] **Step 2–4:** fail, implement, pass, as above. The CLIs import from `../src/*` only.
- [ ] **Step 5: Commit** "Infra: the dev-hosts and plan-summary commands".

### Task 5: The musubi stack (`musubi/infra`)

**Files:**
- Create: `musubi/infra/package.json`, `tsconfig.json`, `vitest.config.ts`, `turbo.json`, `alchemy.run.ts`, `src/declaration.ts`, `src/seeds.ts`, `tests/declaration.test.ts`, `tests/seeds.test.ts`, `tests/parity.test.ts`, `tests/no-literal-hosts.test.ts`
- Modify: `.gitignore` (`*/infra/.generated/`), `bun.lock`

**Interfaces:**
- Consumes: Tasks 1–3 exports; `apiWorker`, `siteWorker`, `retainedD1`, `requireSecrets`, `stackOptions`, `assertRetained`, `physicalName`.
- Produces: `musubiDeclaration(input: { stage: string; hosts: StageHosts; generatedDir: string }): MusubiDeclaration` (pure; every name, var, binding description, domain, observability, compatibility, cron, D1 and site input); `osnSeedSql(input: { cireApiOrigin: string; clientSecret: string; arcKeyId: string; arcPrivateJwk: string }): string`; `clientSecretHash(secret: string): string`; `arcPublicJwk(privateJwk: string): string`.

`package.json` (versioned; copy `shared/infra/package.json`'s fields):

```json
{
  "name": "@musubi/infra",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "author": "English Street Ventures Pty Ltd",
  "license": "UNLICENSED",
  "scripts": {
    "check": "tsc --noEmit",
    "test": "bunx --bun vitest",
    "test:run": "bunx --bun vitest run",
    "plan:dev": "DO_NOT_TRACK=1 bun alchemy plan --stage dev",
    "deploy:dev": "DO_NOT_TRACK=1 bun alchemy deploy --stage dev --yes"
  }
}
```

Dependencies are added with `bun add --exact --cwd musubi/infra alchemy@2.0.0-beta.83 effect@4.0.3 @effect/platform-bun@4.0.3 @effect/platform-node@4.0.3` (the CLI loads one of the platform packages at runtime, Facts) and `bun add --cwd musubi/infra @shared/infra@workspace:*` (dev: `vitest@5.0.3`, `@shared/typescript-config@workspace:*`). Check `git diff --stat bun.lock` shows only the new workspace's entries. Extend `shared/infra/tests/package.test.ts`: every `*/infra/package.json` pins `alchemy`, `effect`, `@effect/platform-bun` and `@effect/platform-node` at exactly `@shared/infra`'s versions, and `bun.lock` still holds one `effect` and one `alchemy`. `tsconfig.json`, `vitest.config.ts` copy `shared/infra`'s. `turbo.json` adds test inputs `$TURBO_ROOT$/osn/api/wrangler.toml`, `$TURBO_ROOT$/osn/api/src/services/auth/oidc.ts`, `$TURBO_ROOT$/osn/db/drizzle/**`.

**The declaration (`src/declaration.ts`, pure):**

- osn-api:
  - `worker: "osn-api"`, name `physicalName({ base: "osn-api", dev: "osn-api-dev", production: "osn-api-production" }, stage)`, `main: "../../osn/api/src/index.ts"`, `bundle: true`, `assets: null`.
  - `compatibility: { date: "2025-03-01", flags: ["nodejs_compat", "nodejs_compat_populate_process_env", "legacy_module_registry"] }` (Decision 7), `crons: ["0 */6 * * *"]`, `domain: hosts.osnApi`, `workersDev: false`.
  - vars (each from `osn/api/wrangler.toml` `[env.dev.vars]`, hosts from Decision 1's table):
    - `OSN_ENV: "dev"`, `OSN_RP_ID: hosts.musubiSocial`, `OSN_RP_NAME: "OSN (dev)"`;
    - `OSN_ORIGIN: origin(musubiSocial)`, `OSN_ISSUER_URL: origin(osnApi)`, `OSN_CORS_ORIGIN: origin(musubiSocial)`;
    - `DEV_LOGIN_RETURN_ORIGINS`: musubi social, cire host, cire vendor, cire invites origins, comma-joined;
    - `OSN_AUTHORIZE_UI_URL: ${origin(musubiSocial)}/authorize`, `OSN_COOKIE_DOMAIN: hosts.musubiSocial`, `OSN_EMAIL_FROM: "dev@cireweddings.com"`.
    - An investigation stage uses `OSN_ENV: "dev"` and `OSN_RP_NAME: "OSN (<stage>)"`.
  - bindings described as data: `{ DB: { kind: "d1" }, RL_AUTH_IP_5_60: { kind: "ratelimit", namespaceId: 2101, limit: 5, period: 60 }, … }` with the namespace ids and limits of `osn/api/wrangler.toml:214-237`.
  - observability `{ headSamplingRate: 1, redactQueryString: false, traces: { enabled: true, headSamplingRate: 1 }, invocationLogs: true, issues: true }` (`osn/api/wrangler.toml:239-246`; Wrangler leaves invocation logs on when unset).
- osn D1:
  - `name: physicalName({ base: "osn-db", dev: "osn-db-dev", production: "osn-db-prod" }, stage)`, `readReplication: "disabled"`, `jurisdiction: "default"`, `locationHint: "oc"`.
  - `migrations: <generatedDir>/migrations/osn-db`, flattened from `../../osn/db/drizzle`.
  - `importFiles: [<generatedDir>/seeds/osn-seed.sql]` (the `RetainedD1Input.importFiles` field from Task 2).
- musubi social site:
  - `name` from `{ base: "osn-social", dev: "osn-social-dev", production: "osn-social" }`, `directory: "../social/dist"`, `domain: hosts.musubiSocial`, `workersDev: false`.
  - `htmlHandling: "auto-trailing-slash"`, `notFoundHandling: "single-page-application"`, `redirectsFile: false` (Decision 15), `issues: true`, `entry: null`.
  - The smoke probe of a deep link (Task 10) proves the single-page fallback tomorrow.
- musubi landing site:
  - `{ base: "musubi-landing", dev: "musubi-landing-dev", production: "musubi-landing" }`, `directory: "../landing/dist"`, `domain: hosts.musubiLanding`, `entry: null`, `redirectsFile: true` (it has none).
  - `notFoundHandling: "404-page"` when `musubi/landing` builds a `404.html`, else `"none"`. Build it once (`bun run build --filter=@musubi/landing`) and record which in a comment.
- A production stage throws through `refuseProductionTier` (K8).

**Seeds (`src/seeds.ts`, pure).** `clientSecretHash(secret)` is `createHash("sha256").update(secret, "utf8").digest("hex")`, the same as `osn/api/src/services/auth/oidc.ts:269, 498`. `arcPublicJwk(privateJwk)` parses the raw JWK string (ARC keys are raw JWK, not base64: `wiki/shared/dev-environment.md:541-547`), refuses anything but `kty: "EC"`, `crv: "P-256"` with `x` and `y`, and returns `JSON.stringify({ kty, crv, x, y })`. `osnSeedSql` returns one file:

```sql
-- Generated by musubi/infra on every deploy; Alchemy re-imports it when it changes.
INSERT INTO oauth_clients (id, client_id, name, logo_url, redirect_uris, client_secret_hash, sector_identifier, allowed_scopes, is_first_party, owner_account_id, created_at, disabled_at)
VALUES ('oc_cire', 'cid_cire', 'Cire', NULL, '["<cire api origin>/api/auth/oidc/callback"]', '<hex>', 'cireweddings.com', 'openid profile email', 1, NULL, 1760659200, NULL)
ON CONFLICT(client_id) DO UPDATE SET redirect_uris = excluded.redirect_uris, client_secret_hash = excluded.client_secret_hash, sector_identifier = excluded.sector_identifier, allowed_scopes = excluded.allowed_scopes, is_first_party = excluded.is_first_party, disabled_at = NULL;
INSERT INTO service_accounts (service_id, allowed_scopes, created_at, updated_at)
VALUES ('cire-api', 'graph:read,graph:resolve-account,org:read,account:email-read', 1760659200, 1760659200)
ON CONFLICT(service_id) DO UPDATE SET allowed_scopes = excluded.allowed_scopes;
INSERT INTO service_account_keys (key_id, service_id, public_key_jwk, registered_at, expires_at, revoked_at)
VALUES ('<CIRE_API_ARC_KEY_ID>', 'cire-api', '<public JWK JSON>', 1760659200, NULL, NULL)
ON CONFLICT(key_id) DO UPDATE SET service_id = 'cire-api', public_key_jwk = excluded.public_key_jwk, expires_at = NULL, revoked_at = NULL;
```

- Column names and timestamp units come from `osn/db/src/schema/index.ts:233-269, 746-800` (Unix seconds); the writes mirror `osn/api/src/routes/graph-internal.ts:320-365`. Read both before writing, and cite them in a comment.
- The scopes are every scope cire-api's ARC tokens request (`cire/api/src/services/osn-bridge.ts`, the `ARC_*_SCOPE` constants, `account:email-read` among them at `:49`); osn-api refuses a token scope missing from `allowed_scopes` (`shared/crypto/src/arc.ts:244-254`). `wiki/shared/dev-environment.md:541-547` lists three and is out of date (Task 14 fixes it). S7 checks the seed's scopes against both files read as text.
- `created_at` and `registered_at` are fixed literals, so the file is byte-identical across runs (S5).
- The origin is validated by `stageHosts` and refused unless it matches `^https://[a-z0-9.-]+$`; the hash is hex; the key id must match a UUID (S9); the JWK's `x` and `y` must be base64url. No value can therefore carry a quote.
- Blank or padded secrets are refused through `requireSeedSecret` (S3). The private key's `d` never appears in the output (S4).

**The stack (`alchemy.run.ts`):**

```ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { apiWorker, assertDevDeployTarget, assertRetained, flattenMigrations, readDevDomain, requireSecrets, retainedD1, siteWorker, stackOptions, stageHosts } from "@shared/infra";
// …declaration, seeds

export default Alchemy.Stack(
  "musubi",
  stackOptions(),
  Effect.gen(function* () {
    const stage = assertDevDeployTarget(yield* Alchemy.Stage, process.env);
    const hosts = stageHosts(readDevDomain(process.env), stage);
    const declared = musubiDeclaration({ stage, hosts, generatedDir: ".generated" });
    flattenMigrations({ source: "../../osn/db/drizzle", target: declared.osnDb.migrations });
    refuseDotEnvFiles(process.cwd());
    writeSeed(declared.seeds.osn, osnSeedSql({
      cireApiOrigin: origin(hosts.cireApi),
      clientSecret: requireSeedSecret(process.env, "CIRE_OIDC_CLIENT_SECRET"),
      arcKeyId: requireSeedSecret(process.env, "CIRE_API_ARC_KEY_ID"),
      arcPrivateJwk: requireSeedSecret(process.env, "CIRE_API_ARC_PRIVATE_KEY"),
    }));
    const db = yield* retainedD1("OsnDb", declared.osnDb);
    const secrets = requireSecrets({ worker: "osn-api", stage, env: process.env });
    const osnApi = yield* apiWorker("OsnApi", { ...declared.osnApi, bindings: toBindings(declared.osnApi.bindings, { DB: db }), secrets });
    const social = yield* siteWorker("MusubiSocial", declared.musubiSocial);
    const landing = yield* siteWorker("MusubiLanding", declared.musubiLanding);
    assertRetained([db, osnApi, social, landing]);
    return { osnApi: hosts.osnApi, musubiSocial: hosts.musubiSocial, musubiLanding: hosts.musubiLanding };
  }),
);
```

- `toBindings` maps each described binding to an Alchemy value: `d1` → the database resource; `ratelimit` → `Cloudflare.RateLimit(name, { namespaceId, simple: { limit, period } })`.
- `requireSeedSecret` is Task 2's: it reads one name and refuses it unset, blank or padded, the same rule as `requireSecrets`.
- `writeSeed` is `mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, sql)`.
- The returned outputs are hostnames, never values. The logical ids (`OsnDb`, `OsnApi`, `MusubiSocial`, `MusubiLanding`) are permanent once deployed: state rows key on them.
- Compile-check the exact resource-binding call forms against `ALC/Cloudflare/Workers/RateLimit.ts:22-30, 99-110` and the P0 wrappers in `shared/infra/src/declare.ts` before writing them.

- [ ] **Step 0 (spike, 30 minutes at most): evaluate the stack offline.** Try `Stack.make` (`ALC/Stack.ts:267-330`) with `Alchemy.State.inMemoryState()` (or `Test.state()`, `ALC/Test/TestState.ts:5-37`) and `Cloudflare.providers()`, with no Cloudflare credentials in the environment and `DEV_DOMAIN=example.test`, `OSN_DEPLOY_TIER=dev`, `CLOUDFLARE_ACCOUNT_ID=<32 zeros>`, and placeholder secrets.
  - If the body evaluates without a network call, write `tests/stack.test.ts`: it evaluates `alchemy.run.ts` that way and asserts each resource's `Props` names, env keys, domains and crons. Prefer it to declaration-only tests where they overlap, and record "stack evaluated offline: yes" in `NEW-FEAT.md`.
  - If it makes a network call or cannot evaluate, record "no" with the error, and keep the pure declaration tests only.
  - Either way, bundle each API Worker offline with rolldown under Alchemy's options (`ALC/Bundle/Bundle.ts:19-25, 203-310`; the `prepareBundle` path in `ALC/Cloudflare/Workers/WorkerProvider.ts:2190`): `osn/api/src/index.ts`, `cire/api/src/index.ts`, `zap/api/src/index.ts`. Record for each: success or the error, and the gzip size of the output (the Workers Free limit is 3 MiB compressed). A Worker that does not bundle takes Decision 14's fallback in its own task (Tasks 5–7): `main` its package's `dist/index.js` from the existing `build` script, `bundle: false`, and its compatibility flags passed verbatim without `legacy_module_registry`; the stack job then runs that package's `build` before the deploy. Record it in `NEW-FEAT.md` as a deviation for NEEDS INPUT 6. The spike's results are evidence for tomorrow, not committed tests.
- [ ] **Step 1: Failing tests** K1–K8 and S1–S5:
  - K2, parity (`tests/parity.test.ts`):
    - Parse `osn/api/wrangler.toml` with `Bun.TOML.parse`. The production names are `[env.production.vars]` keys ∪ `[[env.production.ratelimits]]` names ∪ `DB` ∪ `tierSecrets("osn-api","production")` required and optional. The dev names are the declaration's vars ∪ binding names ∪ dev inventory secrets.
    - Assert dev minus production equals exactly `{ DEV_LOGIN_RETURN_ORIGINS: "dev-login targets exist only off production", DEV_LOGIN_SECRET: "dev login is refused on production" }`.
    - Assert production minus dev equals exactly `{ TURNSTILE_SECRET_KEY: "dev does not enforce Turnstile; osn-api is key-optional" }`.
    - Check each listed difference against the two wrangler blocks and the inventory before writing it.
  - K3: compatibility date and flags equal the TOML's top level, plus `legacy_module_registry`; crons equal `[env.production.triggers]`.
  - K7, `tests/no-literal-hosts.test.ts`: read `alchemy.run.ts` and `src/**`; fail on `/\b[a-z0-9-]+\.(com|social|events|dev|app)\b/` outside comments, allowing only `cireweddings.com` (the sector identifier and the email sender, each on a line commented as not a host).
  - S1: a text guard asserts `osn/api/src/services/auth/oidc.ts` still defines `hashClientSecret` as `sha256Hex(secret)` and `sha256Hex` as `createHash("sha256").update(input).digest("hex")`, plus a known vector for `clientSecretHash`.
  - S7–S10 on `osnSeedSql` and `arcPublicJwk`: S8 imports the produced JWK with `crypto.subtle.importKey("jwk", …, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"])`, from a private JWK the test generates with `crypto.subtle.generateKey`.
  - K9, `tests/reads.test.ts`: every `env.NAME` and `env["NAME"]` in `osn/api/src/**` is a declared var, binding or dev inventory secret (required or optional), or on a list of names deliberately unset on dev, each with a reason (for example `TURNSTILE_SECRET_KEY`: dev does not enforce Turnstile). Build the list by running the test, never by guessing.
  - S2: the redirect URI equals `${CIRE_API_ORIGIN}/api/auth/oidc/callback`, where `CIRE_API_ORIGIN` is the cire declaration's var. Task 6 adds the cross-stack assertion; here, compare with the string `cire/api/src/index.ts:459` builds, read as text.
  - S4: the secret is absent from the SQL. S5: two calls with the same inputs return equal strings.
- [ ] **Step 2–4:** fail, implement, pass; `bun run --cwd musubi/infra check`; `bun run check:alchemy-usage` (the stack file must not construct state).
- [ ] **Step 5: Commit** "Musubi stack: osn-api, its database and seed, musubi social and landing on dev".

### Task 6: The cire stack (`cire/infra`)

**Files:**
- Create: `cire/infra/package.json` (name `@cire/infra`, **no `version` field**, like every `@cire/*`; the same dependencies as Task 5's, platform packages included), `tsconfig.json`, `vitest.config.ts`, `turbo.json`, `alchemy.run.ts`, `src/declaration.ts`, `src/seeds.ts`, `tests/declaration.test.ts`, `tests/parity.test.ts`, `tests/reads.test.ts`, `tests/seeds.test.ts`, `tests/no-literal-hosts.test.ts`, `tests/cross-stack.test.ts`
- Modify: `bun.lock`

**The declaration:**

- cire-api:
  - `worker: "cire-api"`, names `{ base: "cire-api", dev: "cire-api-dev", production: "cire-api-production" }`, `main: "../api/src/index.ts"`, `bundle: true`, `assets: null`.
  - compatibility `2025-03-01` with `nodejs_compat`, `nodejs_compat_populate_process_env` and `legacy_module_registry`; `crons: ["0 4 * * *"]`; `domain: hosts.cireApi`; `workersDev: false`.
  - vars:
    - `OSN_ENV: "dev"`;
    - `WEB_ORIGIN`: invites, host, vendor origins, **in that order** (`cire/api/src/lib/web-origin.ts:46-57`);
    - `OSN_JWKS_URL: ${origin(osnApi)}/.well-known/jwks.json`, `OSN_ISSUER_URL: origin(osnApi)`, `OSN_AUDIENCE: "osn-access"`;
    - `CIRE_API_ORIGIN: origin(cireApi)`, `CIRE_OIDC_CLIENT_ID: "cid_cire"`, `GROWTHBOOK_API_HOST: "https://cdn.growthbook.io"`, `CIRE_R2_RECONCILE_DISABLED: "false"`;
    - `OSN_API_URL: origin(osnApi)` (Decision 10).
    - No `ZAP_API_URL`: dev does not call zap today (`cire/api/wrangler.toml:346-349`).
  - bindings:
    - `DB` (d1); `SHEETS` and `ASSETS` (r2);
    - `IMAGES` (`Cloudflare.Images.Images("IMAGES")`);
    - six rate limiters, names, limits and dev namespace ids 1101–1106 from `cire/api/wrangler.toml:390-428`.
  - observability: `{ headSamplingRate: 1, redactQueryString: false, traces: { enabled: true, headSamplingRate: 1 }, invocationLogs: false, issues: true }` (K4; `cire/api/wrangler.toml:453-463`).
- cire D1: `{ base: "cire-db", dev: "cire-db-dev", production: "cire-db" }`, `readReplication: "auto"`, `oc`, `migrations: .generated/migrations/cire-db` (flattened from `../db/migrations`).
  - `importFiles: ["../db/seed/dev-seed.sql", …(owner seat when set)]`.
- Buckets `{ base: "cire-assets", dev: "cire-assets-dev", production: "cire-assets" }` and `{ base: "cire-sheets", dev: "cire-sheets-dev", production: "cire-sheets" }`:
  - `storageClass: "Standard"`, `jurisdiction: "default"`, `locationHint: "enam"`, `publicAccess: false`, `cors: []`, `domains: []`;
  - `lifecycleRules`: one rule equal to production's — `Default Multipart Abort Rule`, enabled, every prefix, abort incomplete multipart uploads after 7 days (604800 s). Before writing it, map it onto `Cloudflare.R2.BucketProps["lifecycleRules"]` by reading `ALC/Cloudflare/R2/Bucket.ts`'s type.
- cire-invites (Decision 11):
  - `worker: "cire-invites"`, names `{ base: "cire-invites", dev: "cire-invites-dev", production: "cire-invites" }`, `main: "../invites/dist/server/entry.mjs"`, `bundle: false`.
  - `compatibility: { date: "2026-04-15", flags: ["nodejs_compat"] }` (`cire/invites/wrangler.jsonc:12-13`, used verbatim).
  - `assets`: `directory: "../invites/dist/client"`, with `htmlHandling`, `notFoundHandling` and `runWorkerFirst` equal to the `assets` block the adapter writes. Build once (`bun run build --filter=@cire/invites` with placeholder `PUBLIC_*`), read `cire/invites/dist/server/wrangler.json`, and record its `assets` block in a comment.
  - `domain: hosts.cireInvites`, `crons: []`, `vars: {}`, `bindings: {}`, `secrets: {}` (inventory: none).
  - The stack job builds it with the dev `PUBLIC_*` values and `ASTRO_KEY` before the deploy (Task 11); the declaration only points at the output. Source maps are not uploaded (Facts): a dev fidelity gap until P2.
  - observability `{ headSamplingRate: 1, redactQueryString: false, traces: { enabled: true, headSamplingRate: 1 }, invocationLogs: false, issues: true }` (the dev retarget at `.github/workflows/deploy.yml:406`; K4).
- Sites, each `entry: null`, `redirectsFile: true`, `workersDev: false`, `issues: true`, `htmlHandling: "auto-trailing-slash"`, `notFoundHandling` from whether its build emits `404.html` (record which):
  - cire host `{ base: "cire-host", dev: "cire-host-dev", production: "cire-host" }`, `../host/dist`, `hosts.cireHost`;
  - cire vendor `{ base: "cire-vendor", dev: "cire-vendor-dev", production: "cire-vendor" }`, `../vendor/dist`, `hosts.cireVendor`;
  - cire landing `{ base: "cire-landing", dev: "cire-landing-dev", production: "cire-landing" }`, `../landing/dist`, `hosts.cireLanding`.

**Seeds:** `ownerSeatSql(profileId)` returns the two statements of `scripts/cire-db-seed.sh:86-87` with the id substituted, after `^usr_[A-Za-z0-9_-]+$` (S6); unset or empty → no file and no `importFiles` entry.

**Cross-stack test (`tests/cross-stack.test.ts`, S2):** imports `musubiDeclaration` and `osnSeedSql` from `musubi/infra` by relative path (`../../../musubi/infra/src/…`, test-only), and asserts the seeded redirect URI equals `${cire declaration CIRE_API_ORIGIN}/api/auth/oidc/callback`, osn-api's `DEV_LOGIN_RETURN_ORIGINS` and cire-api's `WEB_ORIGIN` name the same three cire origins, and cire-api's `OSN_ISSUER_URL` equals osn-api's. `turbo.json` test inputs add `$TURBO_ROOT$/musubi/infra/src/**`, `$TURBO_ROOT$/cire/api/wrangler.toml`, `$TURBO_ROOT$/cire/db/migrations/**`, `$TURBO_ROOT$/cire/db/seed/dev-seed.sql`.

**Parity (K2) for cire-api.** Production names are `[env.production.vars]` keys ∪ the six limiter names ∪ `DB`, `SHEETS`, `ASSETS`, `IMAGES` ∪ the production inventory secrets. The expected differences, each checked against the files before writing:
- dev only: `STRIPE_PLATFORM_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (production does not run Stripe yet — confirm against `production-release.yml` and the production inventory row).
- production only: `ZAP_API_URL` (dev does not call zap) and `GROWTHBOOK_CLIENT_KEY` (dev has no GrowthBook key).
- `OSN_API_URL` is a var on dev and a secret on production: the same name, so not a difference.
- cire-invites has no vars or bindings on either tier; assert its env is empty.

**The stack (`alchemy.run.ts`)** follows Task 5's shape, `refuseDotEnvFiles` included. Logical ids `CireDb`, `CireAssets`, `CireSheets`, `CireApi`, `CireInvites`, `CireHost`, `CireVendor`, `CireLanding`. It calls `assertStackRetained({ stage, storage: [CireDb, CireAssets, CireSheets], workers: [the five Workers] })` (B9). Outputs are hostnames only. `CIRE_DEV_OWNER_PROFILE_ID` is read from `process.env` (a variable, not a secret).

- [ ] **Steps 1–5** as Task 5 (failing tests for K1–K9, S6, the cross-stack test; implement; pass; `check`; `check:alchemy-usage`). K9's deliberately-unset list for cire-api starts from the production-only names (`ZAP_API_URL`, `GROWTHBOOK_CLIENT_KEY`) and whatever the test finds. Commit "Cire stack: cire-api with its database, buckets and seeds, cire-invites prebuilt, and the cire sites on dev".

### Task 7: The zap stack (`zap/infra`)

Route: `mechanic` (the pattern is Task 5's, every value is below).

**Files:** `zap/infra/package.json` (name `@zap/infra`, version `0.0.0`; the same dependencies as Task 5's, platform packages included), `tsconfig.json`, `vitest.config.ts`, `turbo.json` (test inputs `$TURBO_ROOT$/zap/api/wrangler.toml`, `$TURBO_ROOT$/zap/db/drizzle/**`), `alchemy.run.ts`, `src/declaration.ts`, `tests/declaration.test.ts`, `tests/parity.test.ts`, `tests/no-literal-hosts.test.ts`; `bun.lock`.

- zap-api: `worker: "zap-api"`, names `{ base: "zap-api", dev: "zap-api-dev", production: "zap-api-production" }`, `main: "../api/src/index.ts"`, `bundle: true`, `assets: null`.
  - compatibility `2025-03-01` with `nodejs_compat`, `nodejs_compat_populate_process_env` and `legacy_module_registry` (`zap/api/wrangler.toml:1-11`); `crons: []`; `domain: hosts.zapApi`; `workersDev: false`.
  - vars `OSN_JWKS_URL: ${origin(osnApi)}/.well-known/jwks.json`, `OSN_ISSUER_URL: origin(osnApi)`, `OSN_API_URL: origin(osnApi)`, exactly the names of `[env.production.vars]` (`zap/api/wrangler.toml:93-98`) and no others.
  - bindings `DB` (d1). Secrets from `requireSecrets({ worker: "zap-api", stage, env })`.
  - observability `{ headSamplingRate: 1, redactQueryString: false, traces: { enabled: true, headSamplingRate: 1 }, invocationLogs: true, issues: true }`.
- zap D1: `{ base: "zap-db", dev: "zap-db-dev", production: "zap-db-prod" }`, `readReplication: "disabled"`, `oc`, migrations flattened from `../db/drizzle` into `.generated/migrations/zap-db`, `importFiles: []`.
- Parity (K2): dev and production names equal exactly (vars, `DB`, `INTERNAL_SERVICE_SECRET`); the forbidden `GROWTHBOOK_CLIENT_KEY` is in neither. K9 (`tests/reads.test.ts`) as in Task 5, over `zap/api/src/**`; a name production leaves unset goes on the deliberately-unset list with the reason "unset on production too".
- Logical ids `ZapDb`, `ZapApi`; `assertStackRetained({ stage, storage: [ZapDb], workers: [ZapApi] })` (B9); K10 for zap-api.
- Commit "Zap stack: zap-api and its first dev database".

### Task 8: The pulse stack and pulse landing's Worker entry

**Files:**
- Create: `pulse/landing/src/lib/geo.ts`, `pulse/landing/worker/index.ts`, `pulse/landing/tests/worker/geo.test.ts`, `pulse/infra/**` (as Task 7; name `@pulse/infra`, version `0.0.0`, platform packages included)
- Modify: `pulse/landing/functions/api/geo.ts` (becomes a thin wrapper over `src/lib/geo.ts`), `pulse/landing/tsconfig.json` or `vitest` config only if the new test path needs it, `bun.lock`

- `src/lib/geo.ts` exports `geoResponse(cf: { city?: string; region?: string; regionCode?: string; country?: string } | undefined): Response`. It holds the body, the FNV-1a `illustrativeCount` and the headers moved unchanged from `functions/api/geo.ts`. The Pages Function becomes `export const onRequestGet = (context) => geoResponse(context.request.cf)`, behaviour unchanged for the existing preview project.
- `worker/index.ts`:
  ```ts
  import { geoResponse } from "../src/lib/geo";
  interface Env { readonly ASSETS: { fetch(request: Request): Promise<Response> } }
  export default {
    fetch(request: Request, env: Env): Response | Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname !== "/api/geo") return env.ASSETS.fetch(request);
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return geoResponse((request as Request & { cf?: Parameters<typeof geoResponse>[0] }).cf);
    },
  };
  ```
- Tests G1–G3 call the default export with a stub `ASSETS`.
- Pulse landing's `PUBLIC_APP_URL` has no dev target (the Pulse app is not deployed on dev); the build leaves it unset, and the stack's declaration says so in a comment.
- The pulse stack declares one site with `redirectsFile: true`, `entry: { main: "../landing/worker/index.ts", compatibility: { date: "2026-08-31", flags: [] }, runWorkerFirst: ["/api/*"] }` (Decision 7: a new Worker takes Alchemy's defaults), names `{ base: "pulse-landing", dev: "pulse-landing-dev", production: "pulse-landing" }`, `directory: "../landing/dist"`, `domain: hosts.pulseLanding`, `notFoundHandling` from the build. No secrets; `requireSecrets` is not called (the pulse stack has no inventory Worker). Logical id `PulseLanding`; `assertStackRetained({ stage, storage: [], workers: [PulseLanding] })` (B9).
- K7 grep test.
- Commit "Pulse stack: pulse landing as a Worker serving /api/geo beside its assets".

### Task 9: The surface map learns stacks and dev-only surfaces

**Files:**
- Modify: `scripts/deploy-surfaces.ts`, `scripts/release-plan.ts`, `scripts/tests/deploy-surfaces.test.ts`, `scripts/tests/deploy-surfaces.cli.test.ts`, `scripts/tests/release-plan.test.ts`, `scripts/tests/deploy-surface-map.test.ts` (only if a regex it reads changes)

**Interfaces:**
- Produces:
  ```ts
  export type StackKey = "musubi" | "cire" | "zap" | "pulse";
  export type SurfaceKey = "cire_api" | "cire_invites" | "cire_host" | "cire_vendor" | "cire_landing"
    | "osn_api" | "osn_social" | "musubi_landing" | "zap_api" | "pulse_landing";
  export interface Surface {
    readonly key: SurfaceKey;
    readonly paths: RegExp;
    readonly stack: StackKey;
    /** The job in production-release.yml; none for a surface production does not ship yet. */
    readonly production?: Job;
    /** The record job in deploy.yml; it carries the surface's dev Deployment record. */
    readonly dev: Job;
  }
  export interface Stack {
    readonly key: StackKey;
    /** The Alchemy job in deploy.yml. */
    readonly job: Job;
    /** Paths that redeploy every dev surface of the stack and no production surface. */
    readonly paths: RegExp;
  }
  export const STACKS: readonly Stack[];
  export const PRODUCTION_SURFACES: readonly Surface[]; // SURFACES with production
  export function devStackDecisions(decisions: readonly Decision[], files: readonly string[] | undefined, event: string): readonly { key: StackKey; deploy: boolean }[];
  ```
  `scripts/smoke-check.ts` and `scripts/worker-deployments.ts` both count as `SMOKE_CHECK_FILE`-like files: a change to either redeploys every dev surface (P5), because every dev surface now runs the check.
- New surfaces:
  - `musubi_landing`: paths `^musubi\/landing\/`, stack `musubi`, dev job `{ id: "deploy-musubi-landing-dev", name: "Deploy musubi/landing — dev" }`, no production.
  - `pulse_landing`: paths `^pulse\/landing\/`, stack `pulse`, dev `{ id: "deploy-pulse-landing-dev", name: "Deploy pulse/landing — dev" }`, no production.
  - `zap_api` gains dev `{ id: "deploy-zap-api-dev", name: "Deploy zap/api — dev" }`.
  - Every existing dev job id and name stays exactly as it is.
- Stacks:
  - musubi `{ id: "stack-musubi-dev", name: "Alchemy musubi stack — dev" }`, paths `^musubi\/infra\/`, surfaces `osn_api`, `osn_social`, `musubi_landing`;
  - cire `{ id: "stack-cire-dev", name: "Alchemy cire stack — dev" }`, paths `^cire\/infra\/`, the five cire surfaces;
  - zap `{ id: "stack-zap-dev", name: "Alchemy zap stack — dev" }`, paths `^zap\/infra\/`, `zap_api`; `zap_api.paths` becomes `^zap\/(?!infra\/)` so an infra-only change offers nothing to production (P8);
  - pulse `{ id: "stack-pulse-dev", name: "Alchemy pulse stack — dev" }`, paths `^pulse\/infra\/`, `pulse_landing`.
- `cire_api.paths` drops `cire-dev-db-guard` (Task 12 deletes the file).
- `SHARED_CONTENT` no longer matches `shared/infra/` (Decision 16); every stack's `paths` adds `^shared\/infra\/` (P6).
- `release-plan.ts` keeps its 300-record walk on both tiers: 1000 could spend GITHUB_TOKEN's hourly request budget in one run when a surface has no record in the window (`scripts/release-plan.ts:339-371`). A dev run now leaves up to 14 records (4 stack jobs, 10 record jobs), so a surface whose last dev record falls out of the window is held back until it deploys again; a `workflow_dispatch` of **Deploy** redeploys every stack and refreshes every record. Task 14 states this in `wiki/shared/production-deploy.md`.
- `scripts/tests/fake-github.ts:142, 160` reads `surface(key).production.name` only for surfaces with a production job.
- CLI output adds `stack_<key>=true|false` lines after the surface lines (P3).
- `release-plan.ts` reads `PRODUCTION_SURFACES` wherever it lists, parses or plans production surfaces: lines 431, 440, 480 and 576 today. The dev gate keeps `surface(key).dev`, now always present.

- [ ] **Step 1: Failing tests** P1–P5 in `deploy-surfaces.test.ts`:
  - P1: `["cire/infra/alchemy.run.ts"]` → every cire dev surface true, `stack_cire` true; production `changesContent` false for every surface.
  - P2: `["musubi/landing/src/x.astro"]` → `stack_musubi` true.
  - P3: the CLI test reads `stack_*` lines.
  - P5: `["scripts/worker-deployments.ts"]` → every dev surface.
  - P4 in `release-plan.test.ts`: the planner's decisions and its `$GITHUB_OUTPUT` lines name exactly the eight production surfaces.
  - P6: `["shared/infra/src/hosts.ts"]` → every `stack_*` true, and `changesContent` false for every production surface; `["shared/ui/src/x.ts"]` still redeploys everything on both tiers.
  - P8: `["zap/infra/alchemy.run.ts"]` → `stack_zap` true and `changesContent(zap_api)` false; `["zap/api/src/index.ts"]` still true.
  - Update "names eight surfaces" to ten and "every surface but zap has a dev job" to "every surface has a dev job"; keep "job ids and names are distinct", now over surfaces and stacks.
- [ ] **Step 2–4:** fail, implement, pass: `bun test ./scripts/tests/deploy-surfaces.test.ts ./scripts/tests/deploy-surfaces.cli.test.ts ./scripts/tests/release-plan.test.ts ./scripts/tests/release-plan.cli.test.ts ./scripts/tests/deploy-surface-map.test.ts`.
  - `scripts/tests/deploy-workflows.test.ts` fails from here until Task 11 rewrites `deploy.yml`. Record that in `NEW-FEAT.md`, and do not change `deploy.yml` in this task.
- [ ] **Step 5: Commit** "Deploy map: stacks, musubi and pulse landing on dev, zap on dev".

### Task 10: The smoke check judges dev by origin and deployment id; `worker-deployments`

**Files:**
- Modify: `scripts/smoke-check.ts`, `scripts/tests/smoke-check.test.ts`, `scripts/tests/smoke-check.cli.test.ts`, `scripts/tests/smoke-targets.test.ts`
- Create: `scripts/worker-deployments.ts`, `scripts/tests/worker-deployments.test.ts`

**Interfaces:**
- `SMOKE_TARGETS[surface]` becomes `{ readonly dev?: DevSmokeTarget; readonly production?: SmokeTarget }` for every `SurfaceKey` that has one. Production entries are byte-for-byte what they are today.
  ```ts
  export interface DevSmokeTarget {
    readonly worker: string;                 // the dev script name (cire-api-dev, osn-social-dev, …)
    readonly access: boolean;                // browser hosts: true; API hosts: false
    readonly probes: (origins: { readonly origin: string; readonly marketing?: string }) => readonly Probe[];
    readonly needsMarketing: boolean;        // cire_invites only
  }
  ```
- Dev workers and probes:

  | Surface | Worker | Access | Probes |
  |---|---|---|---|
  | `osn_api` | `osn-api-dev` | no | `health`, `jwks` |
  | `cire_api` | `cire-api-dev` | no | `cireSession` |
  | `cire_invites` | `cire-invites-dev` | yes | `guestSite(origin, marketing)` |
  | `zap_api` | `zap-api-dev` | no | `health` |
  | `cire_host` | `cire-host-dev` | yes | `/` html |
  | `cire_vendor` | `cire-vendor-dev` | yes | `/` html |
  | `cire_landing` | `cire-landing-dev` | yes | `/` html |
  | `musubi_landing` | `musubi-landing-dev` | yes | `/` html |
  | `osn_social` | `osn-social-dev` | yes | `/` html, `/smoke-check-deep-link` html (the single-page fallback) |
  | `pulse_landing` | `pulse-landing-dev` | yes | `/` html, `/api/geo` jsonObject |

- New expectations: `{ kind: "html" }` (200 and `text/html`); `{ kind: "jsonObject" }` (200 and a body that parses to a JSON object).
- Dev environment, read by `runSmokeCheck` when `tier === "dev"`:
  - `SMOKE_ORIGIN`: required, an `https://` origin with no path, query or trailing slash; else exit 2 (Q1, Q2).
  - `SMOKE_MARKETING_ORIGIN`: required when `needsMarketing`.
  - `SMOKE_DEPLOYMENT`: required; a deployment id or `unchanged`; else exit 2 (Q3).
  - `WRANGLER_OUTPUT_FILE_PATH` is read on production only.
- Restore plan on dev:
  - `Deployment` gains `annotations?: { readonly "workers/message"?: string }`, read from the same GET (`scripts/smoke-check.ts:402-406`).
  - `unchanged`, and the newest deployment's `workers/message` starts with `Smoke check failed` (the annotation `rollbackMessage` writes, `scripts/smoke-check.ts:608-617`): the check fails at once without probing or rolling back, with an error saying an earlier smoke check restored this Worker and the next run will re-upload it with `--force` (Q15).
  - `unchanged` otherwise → `{ ok: false, refused: true, reason: "this run deployed nothing to <worker>" }` (Q4).
  - An id that is not the newest deployment's id at the first read → refused, "deployed again since this run" (Q5).
  - Otherwise the version that served at 100% in the newest deployment before it (Q6).
  - Export `devRestorePlan(newestFirst: readonly Deployment[], deployment: string): RestorePlan`.
- Access (Decision 12): a dev target with `access: true` sends the service-token headers when both are set, and otherwise probes without them. A redirect to `*.cloudflareaccess.com` is `blocked`, which fails the job without rollback, and the job's error names `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` (Q9). The "skipped, exit 0" path is removed.
- `SMOKE_FORCE_FAIL` keeps its meaning on dev for every dev surface.
- `scripts/worker-deployments.ts`:
  ```
  bun run scripts/worker-deployments.ts snapshot <file> <surface>...   # writes {"<surface>": "<newest deployment id>" | null}
  bun run scripts/worker-deployments.ts compare <file> <surface>...    # writes "<surface>_deployment=<id>|unchanged" to $GITHUB_OUTPUT
  ```
  - It reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` and uses `readDeployments` exported from `smoke-check.ts`. A Worker that does not exist answers Cloudflare error 10007; treat it as `null` (Q10).
  - Exit 1 on any other API failure (Q11); exit 2 on an unknown surface or a missing argument (Q12).
  - It never prints the token or the account id (Q13): every message passes through a function that replaces each 32-hex run with `<account>`.
  - `compare` reports `unchanged` when the newest id equals the snapshot's, and the newest id otherwise. It writes a line for every surface even when some fail: a Worker it cannot read, or that has no deployment after the deploy, gets `unknown`, and `compare` then exits 1 after writing every line.
  - The smoke check accepts `SMOKE_DEPLOYMENT=unknown`: it probes, never rolls back, and says the deployment could not be read (Q16).
  - `snapshot` also writes `force=true` to `$GITHUB_OUTPUT` when any listed Worker's newest deployment carries the smoke-check rollback annotation, and `force=false` otherwise (Q14), naming each such Worker on stdout.
  - Export the annotation prefix from `smoke-check.ts` (`ROLLBACK_MESSAGE_PREFIX = "Smoke check failed"`) and build `rollbackMessage` from it, so the writer and both readers share one constant.

- [ ] **Step 1: Failing tests** Q1–Q15.
  - Rewrite every existing dev-host case in `smoke-check.test.ts` to pass `SMOKE_ORIGIN` (for example `https://api.cire.example.test`) and `SMOKE_DEPLOYMENT`.
  - Keep every production case unchanged and passing.
  - `smoke-targets.test.ts` keeps its production cases; its dev cases are deleted ("Tests this change deletes" table) and replaced in Task 11.
  - Its "a change to the check redeploys exactly the dev Workers that run it" case becomes "every dev surface has a dev smoke target and every dev smoke target is a dev surface" (holds `SMOKE_CHECKED_ON_DEV`, now every dev surface, to `SMOKE_TARGETS`).
- [ ] **Step 2–4:** fail, implement, pass: `bun test ./scripts/tests/smoke-check.test.ts ./scripts/tests/smoke-check.cli.test.ts ./scripts/tests/smoke-targets.test.ts ./scripts/tests/worker-deployments.test.ts`; `bunx --bun tsc -p scripts/tsconfig.json`.
- [ ] **Step 5: Commit** "Smoke check: dev origins from the deploy, rollback judged by deployment id, and every dev site checked".

### Task 11: `deploy.yml` runs the stacks

**Files:**
- Rewrite: `.github/workflows/deploy.yml`
- Modify: `scripts/tests/deploy-workflows.test.ts`, `shared/infra/tests/accounts.test.ts` (turn on the Task 3 `todo` for `deploy.yml`)
- Create: `shared/infra/tests/workflow-secrets.test.ts`, `shared/infra/tests/workflow-hosts.test.ts`

**Shape.** Keep the header comment's role, rewritten to state what the workflow does now. Keep `changes` and `build` as they are; `changes` gains the `stack_*` outputs.

- `on`: push to `main`; `workflow_dispatch` with
  - `smoke_fail` (choice: `none` plus every dev surface key, default `none`);
  - `expect_no_change` (boolean, default false; "Fail each stack job unless its deploy planned no change");
  - `force` (boolean, default false; "Re-upload every resource, even unchanged ones").
- Workflow `env`: `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`, `DO_NOT_TRACK: "1"`.
- `permissions: contents: read`.
- Job `credential-scope` is deleted: it reported which of `CLOUDFLARE_API_TOKEN_DEV` and `CLOUDFLARE_API_TOKEN` a run held, and neither is read any more.
- **One job per stack**, in `STACK_KEYS` order, each needing only `build` and `changes`. No stack job needs another (Decision 2). The musubi job in full:

```yaml
  stack-musubi-dev:
    name: Alchemy musubi stack — dev
    needs: [build, changes]
    if: needs.changes.outputs.stack_musubi == 'true'
    runs-on: ubuntu-latest
    environment: dev
    timeout-minutes: 45
    concurrency:
      group: deploy-dev-musubi
      cancel-in-progress: false
    outputs:
      deployed: ${{ steps.deploy.outcome == 'success' && steps.deployments.outcome == 'success' }}
      osn_api_healthy: ${{ steps.smoke_osn_api.outcome == 'success' }}
      osn_social_healthy: ${{ steps.smoke_osn_social.outcome == 'success' }}
      musubi_landing_healthy: ${{ steps.smoke_musubi_landing.outcome == 'success' }}
    steps:
      - name: Refuse force with expect_no_change
        if: ${{ inputs.force == true && inputs.expect_no_change == true }}
        run: |
          echo "::error::force re-uploads every resource, so a plan can never be 'no changes'. Dispatch one or the other."
          exit 1
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version-file: .bun-version }
      - name: Cache bun dependencies      # as today's dev jobs
      - name: Restore turbo cache          # as today's dev jobs
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Dev hosts
        id: hosts
        run: bun run --cwd shared/infra dev-hosts -- --stage dev
        env:
          DEV_DOMAIN: ${{ vars.DEV_DOMAIN }}
      - name: Build musubi/social (dev)
        run: bun run build --filter=@musubi/social
        env:
          VITE_OSN_ISSUER_URL: ${{ steps.hosts.outputs.osn_api_origin }}
          VITE_TURNSTILE_SITEKEY: ${{ vars.PUBLIC_TURNSTILE_SITEKEY }}
      - name: Build musubi/landing (dev)
        run: bun run build --filter=@musubi/landing
        env:
          SITE: ${{ steps.hosts.outputs.musubi_landing_origin }}
          PUBLIC_APP_URL: ${{ steps.hosts.outputs.musubi_social_origin }}
      - name: Record each Worker's newest deployment
        id: snapshot
        run: bun run scripts/worker-deployments.ts snapshot "$RUNNER_TEMP/deployments.json" osn_api osn_social musubi_landing
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_DEV_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_DEV_ACCOUNT_API_TOKEN }}
      - name: Refuse expect_no_change while a rollback awaits re-upload
        if: ${{ inputs.expect_no_change == true && steps.snapshot.outputs.force == 'true' }}
        run: |
          echo "::error::A smoke check rolled a Worker back, so this run would re-upload it with --force and could not plan 'no changes'. Dispatch Deploy plainly first, then expect_no_change."
          exit 1
      - name: Deploy the musubi stack
        id: deploy
        working-directory: musubi/infra
        run: |
          set -o pipefail
          bun run deploy:dev ${FORCE:+--force} 2>&1 | tee "$RUNNER_TEMP/alchemy.log"
        env:
          FORCE: ${{ (inputs.force == true || steps.snapshot.outputs.force == 'true') && 'yes' || '' }}
          DO_NOT_TRACK: "1"
          OSN_DEPLOY_TIER: dev
          DEV_DOMAIN: ${{ vars.DEV_DOMAIN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_DEV_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_DEV_ACCOUNT_API_TOKEN }}
          # every dev inventory secret of osn-api, required and optional, one line each, e.g.
          DEV_LOGIN_SECRET: ${{ secrets.DEV_LOGIN_SECRET }}
          # … then STACK_STEP_SECRETS.musubi:
          CIRE_OIDC_CLIENT_SECRET: ${{ secrets.CIRE_OIDC_CLIENT_SECRET }}
          CIRE_API_ARC_KEY_ID: ${{ secrets.CIRE_API_ARC_KEY_ID }}
          CIRE_API_ARC_PRIVATE_KEY: ${{ secrets.CIRE_API_ARC_PRIVATE_KEY }}
      - name: Summarise the plan
        if: ${{ !cancelled() && steps.deploy.outcome != 'skipped' }}
        run: bun run --cwd shared/infra plan-summary -- --stack musubi ${EXPECT_NO_CHANGE:+--expect-no-change} "$RUNNER_TEMP/alchemy.log"
        env:
          EXPECT_NO_CHANGE: ${{ inputs.expect_no_change == true && 'yes' || '' }}
      - name: Find what the deploy changed
        id: deployments
        if: ${{ !cancelled() && steps.snapshot.outcome == 'success' }}
        continue-on-error: true
        run: bun run scripts/worker-deployments.ts compare "$RUNNER_TEMP/deployments.json" osn_api osn_social musubi_landing
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_DEV_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_DEV_ACCOUNT_API_TOKEN }}
      - name: Smoke check osn/api, rolling back on failure
        id: smoke_osn_api
        if: ${{ !cancelled() && steps.snapshot.outcome == 'success' }}
        continue-on-error: true
        timeout-minutes: 5
        run: bun run scripts/smoke-check.ts osn_api dev
        env:
          SMOKE_ORIGIN: ${{ steps.hosts.outputs.osn_api_origin }}
          SMOKE_DEPLOYMENT: ${{ steps.deployments.outputs.osn_api_deployment }}
          SMOKE_FORCE_FAIL: ${{ inputs.smoke_fail == 'osn_api' }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_DEV_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_DEV_ACCOUNT_API_TOKEN }}
      # … one smoke step per surface of the stack, same shape; Access targets add
      # CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.
      - name: Fail when any check failed
        if: ${{ !cancelled() && (steps.deployments.outcome == 'failure' || steps.smoke_osn_api.outcome == 'failure' || steps.smoke_osn_social.outcome == 'failure' || steps.smoke_musubi_landing.outcome == 'failure') }}
        run: |
          echo "::error::A smoke check failed, or the deployments could not be read; see the steps above."
          exit 1
```

- The smoke steps run `if: ${{ !cancelled() && steps.snapshot.outcome == 'success' }}`, so a deploy that fails part-way still checks, and rolls back, a Worker it managed to upload; a Worker `compare` could not read gets `unknown` and is checked without rollback.
- `deployed` is `false` when the deploy step or `compare` failed, and then no record job runs: a surface whose new version may not have uploaded must not record success.
- **cire stack job:** the same shape on `stack_cire`. Before the snapshot it builds:
  - cire invites, host, vendor and landing, with today's Astro font caches and exactly the `PUBLIC_*` names today's dev jobs set (`deploy.yml:362-370, 495-500, 578-579, 656-657`), every host value from `steps.hosts.outputs.*`, and Turnstile and Maps keys from `vars` as today. The invites build also sets `ASTRO_KEY: ${{ secrets.ASTRO_KEY }}` and first fails with an error naming it when it is empty;
  - then the bundle-size guards for invites, host, vendor and landing.
  - The deploy step's env carries cire-api's dev inventory secrets and `CIRE_DEV_OWNER_PROFILE_ID: ${{ vars.CIRE_DEV_OWNER_PROFILE_ID }}`.
  - Five smoke steps; `cire_invites` adds `SMOKE_MARKETING_ORIGIN: ${{ steps.hosts.outputs.cire_landing_origin }}`.
- **zap stack job:** no builds; one smoke step.
- **pulse stack job:** one build, `bun run build --filter=@pulse/landing` with `SITE: ${{ steps.hosts.outputs.pulse_landing_origin }}` and no `PUBLIC_APP_URL` (no dev Pulse app); one smoke step.
- If Task 5 Step 0 sent an API Worker to the fallback (Decision 14), its stack job runs that package's `bun run build --filter=<package>` before the snapshot, with no secret in the step.
- **One record job per dev surface**, id and name from `SURFACES[].dev`:

```yaml
  deploy-osn-api-dev:
    name: Deploy osn/api — dev
    needs: [stack-musubi-dev]
    if: ${{ !cancelled() && needs.stack-musubi-dev.outputs.deployed == 'true' && needs.stack-musubi-dev.outputs.osn_api_healthy == 'true' }}
    runs-on: ubuntu-latest
    environment: dev
    timeout-minutes: 2
    steps:
      # The stack job deployed osn-api-dev and its smoke check passed. This job
      # exists so the run leaves one dev Deployment record per surface, named
      # for the surface: scripts/release-plan.ts reads records by job name.
      - name: Record the dev deploy
        run: echo "osn-api-dev deployed and passed its smoke check in this run's musubi stack job."
```

- [ ] **Step 1: Failing tests** W1–W10.
  - `deploy-workflows.test.ts`:
    - W1, W2, W9, W10: replace the dev-job cases (`:99-114`, the dev rows of `:204-277`). The "jobs that run `wrangler deploy` are exactly the smoke targets' jobs" case keeps its production half; dev's half becomes "each stack job runs `smoke-check.ts <key> dev` once for every dev surface of the stack, with `SMOKE_ORIGIN` from `steps.hosts.outputs` and `SMOKE_DEPLOYMENT` from `steps.deployments.outputs`".
    - W4, W5, W6: no literal `https://` value in a dev build or smoke env; no `wrangler` in `deploy.yml` at all; every `bun install` frozen.
    - The `smoke_fail` options equal `["none", ...every dev smoke surface]`.
  - `shared/infra/tests/workflow-secrets.test.ts` (W3, W8), reading `deploy.yml` with `Bun.YAML.parse`:
    - each `Deploy the <stack> stack` step's `secrets.*` names equal the dev required and optional inventory secrets of `STACK_WORKERS[stack]`, plus that stack's `STACK_STEP_SECRETS`, plus `accountSecrets("dev")`;
    - every step whose `run` installs or builds reads no `secrets.*` and sets no `CLOUDFLARE_*`, except the cire invites build step, which reads exactly `secrets.ASTRO_KEY` (Decision 11);
    - the workflow reads no Cloudflare credential outside `accountSecrets("dev")`.
  - `shared/infra/tests/workflow-hosts.test.ts`: every `steps.hosts.outputs.<key>` the workflow reads is a key `devHostOutputs()` writes.
  - `accounts.test.ts`: turn on the Task 3 `todo`.
- [ ] **Step 2–4:** fail, write the workflow, pass:
  - `bun run test:scripts` and `bun run --cwd shared/infra test:run`;
  - `bun run check:alchemy-usage` (W7);
  - actionlint, if `command -v actionlint` finds it (`actionlint .github/workflows/deploy.yml`); otherwise record `actionlint: NOT RUN (not installed)` in `NEW-FEAT.md`.
- [ ] **Step 5: Commit** "Deploy: build the dev tier from the Alchemy stacks, check every surface in its stack job".

### Task 12: Retire the old dev tier's tooling

**Files:**
- Delete: `.github/workflows/cire-dev-db-rebuild.yml`, `scripts/cire-dev-db-guard.ts`, `scripts/tests/cire-dev-db-guard.test.ts`, `scripts/tests/cire-dev-db-guard.cli.test.ts`, `scripts/cire-db-reset.sh` (it serves `--dev` only — confirm with `grep -rn "cire-db-reset" --include='*.json' --include='*.sh' --include='*.yml' --include='*.ts' .` first)
- Modify:
  - `osn/api/wrangler.toml` — remove every `[env.dev…]` table and the comments that describe the deployed dev tier; keep the top level (`wrangler dev`) and `[env.staging]`, `[env.production]`. Reword any remaining comment that names a dev host.
  - `cire/api/wrangler.toml` — the same for `[env.dev…]` (`:324-465`).
  - `osn/db/package.json` — drop `db:migrate:dev`.
  - `cire/db/package.json` — drop `db:migrate:dev`, `db:seed:dev`, `db:reset:dev`.
  - `scripts/cire-db-seed.sh` — remove the `--dev` branch, keep local.
  - `scripts/cire-db-migrate.ts` and its tests — remove the dev target, if it names one.
  - `.github/workflows/set-osn-api-secret.yml` — tier `production` only; the token expression reads `secrets.CLOUDFLARE_API_TOKEN` only; remove the dev rows of its per-secret tier lists.
  - `.github/workflows/ci.yml` — reword the `script-tests` comment that cites the deleted guard.
  - `.github/workflows/cire-d1-latency-probe.yml` and `cire/api/scripts/d1-latency-probe.ts`, `cire/api/tests/scripts/d1-latency-probe.test.ts`:
    - the probe takes its origin from `CIRE_API_ORIGIN` (required, https) and its limiter from the top-level `[[unsafe.bindings]]` (same limit and period);
    - the workflow job gains `environment: dev`, `bun install --frozen-lockfile` and a `dev-hosts` step.
  - `cire/api/tests/index.test.ts:975-982` — read `[env.production.vars] WEB_ORIGIN`.
  - `cire/api/tests/app.test.ts:66-75` — run the preflight test against `[env.production.vars] WEB_ORIGIN`.
  - `cire/api/tests/lib/reconcile-alert-email.test.ts:128-139` — read `[env.production]`'s bucket names.
  - `cire/api/tests/services/r2-reconcile.test.ts:1250-1270` — expect tier keys `production` and `top`.
  - `scripts/tests/cire-db-migrate.test.ts:351-367` — expect two D1 blocks.
  - `zap/db/package.json` — drop `db:migrate:dev` (a remote migrator whose `[env.dev]` binding is a placeholder id, `zap/api/wrangler.toml:40-44`). `pulse/db` is left: `pulse/api` has no deploy.
  - Reword the comments `cire/build-tools/src/tier-headers.ts:12` and `osn/api/src/routes/auth/dev-login.ts:65`, which name old dev hosts.
  - Keep `cire/db` `assets:seed:dev`: it writes by bucket name with `--remote` and no `[env.dev]` (`cire/db/seed/assets.ts:195`), so it fills the new account's bucket when run with its credentials.

- [ ] **Step 1:** Grep for every reader before deleting:
  `grep -rn "env\.dev\|\[env\.dev\|db:migrate:dev\|db:seed:dev\|db:reset:dev\|cire-dev-db-guard\|cire-db-reset\|cire-dev-db-rebuild\|CLOUDFLARE_API_TOKEN_DEV" --include='*.ts' --include='*.sh' --include='*.yml' --include='*.toml' --include='*.json' . | grep -v node_modules`
  List each hit in `NEW-FEAT.md` with its fate. `zap/api/wrangler.toml` keeps `[env.dev]`: it is the local `wrangler dev` posture (`zap/api/package.json` `dev:wrangler`, `zap/db` `db:migrate:local`).
- [ ] **Step 2:** Make the edits. Run `bun run test:scripts`, `bun run --cwd cire/api test`, `bun run --cwd cire/db test`, `bun run --cwd osn/db test:run`.
- [ ] **Step 3:** Run the issue's grep:
  `grep -rn "dev.cireweddings.com\|dev.musubi.social" .github scripts osn cire zap musubi pulse shared --include='*.ts' --include='*.yml' --include='*.toml' --include='*.jsonc' | grep -v '/tests/' | grep -v node_modules`
  Expected: no output.
- [ ] **Step 4: Commit** "Retire the old dev tier: Wrangler dev blocks, the nightly rebuild, its guard and the dev migration scripts".

### Task 13: The free-tier ceiling alert watches the dev account

**Files:** `.github/workflows/free-tier-ceiling-alert.yml`, `scripts/check-free-tier-ceilings.ts`, `scripts/tests/check-free-tier-ceilings.test.ts`, `shared/infra/tests/accounts.test.ts`.

- The script takes a required `--account <production|dev>`. It appears in the issue title and in the marker the script uses to find its own open issue, so each account files and updates its own issue.
  - Before writing, read how it finds its issue today (`scripts/check-free-tier-ceilings.ts`, the `gh` calls near `:645`). Keep the production issue's title and marker byte-identical, so the open production issue is still found.
- The workflow:
  - today's job, renamed only if its name is not load-bearing, passes `--account production`;
  - a second job `dev`: `environment: dev`, `CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_DEV_ACCOUNT_ID }}`, `CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY }}`, `--account dev`;
  - when either secret is empty, the dev job fails with a message naming both.
- Tests:
  - the production title and marker are unchanged;
  - the dev title differs;
  - a missing `--account` exits 2;
  - `accounts.test.ts`: the alert's dev job reads exactly `CLOUDFLARE_DEV_ACCOUNT_ID` and `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY`.
- Commit "Free-tier alert: watch the dev account too".

### Task 14: Wiki, `AGENTS.md`, the spec and changesets

Invoke the `write-wiki` skill first. Edit pages with Edit and Write, never through the Obsidian MCP or CLI.

- `wiki/shared/infrastructure-as-code.md`:
  - the stacks exist;
  - the dev deploy flow (stack job with its smoke checks, record jobs, deployment-id rollback, `--force` after a rollback, the `force` and `expect_no_change` dispatch inputs);
  - `DEV_DOMAIN` and the host table;
  - flattening and why;
  - seeds and the ARC registration;
  - the module-registry decision;
  - `assertDevDeployTarget`;
  - the plan summary and `expect_no_change`.
- `wiki/shared/dev-environment.md`: rewrite for the new account. Bootstrap order (the owner list above), hosts, Access, Turnstile, Stripe, data that is no longer reset nightly, how to re-set `CIRE_DEV_OWNER_PROFILE_ID`. Remove the old step list and its "done" marks.
- `wiki/shared/production-deploy.md`: its dev-gate and smoke-check sections. Production steps are unchanged.
- `wiki/compliance/access-control.md`: the dev account and its three credentials; deleting `CLOUDFLARE_API_TOKEN_DEV` and the dev `CLOUDFLARE_ACCOUNT_ID`.
- `wiki/shared/monorepo-structure.md`: four new packages.
- `wiki/shared/database-environments.md`: dev databases in the new account, migrated by Alchemy, seeded by import.
- `wiki/shared/free-tier-limits.md`: two accounts.
- `wiki/osn/oidc-provider.md` and `wiki/osn/arc-tokens.md`: the dev client row and ARC key are made by the stacks. `wiki/shared/dev-environment.md` and `wiki/shared/production-deploy.md` list cire-api's ARC scopes as three; they are four (`account:email-read`, `cire/api/src/services/osn-bridge.ts:49`).
- `wiki/cire/cire-development.md`: dev commands removed.
- `wiki/osn/sessions.md`, `wiki/cire/cire-landing.md`, `wiki/cire/stripe-webhooks.md`: each names a dev host; state the host as derived from `DEV_DOMAIN`.
- `wiki/shared/dev-environment.md` also states the gap englishstreetventures/osn#1554 holds: a dev database left half-migrated has no scripted recovery yet (fix forward with a new migration meanwhile).
- `wiki/index.md` if a page is added.
- `AGENTS.md`: the line "A merge to `main` deploys the dev tier (`*.dev.…`) at once" names the dev domain from `DEV_DOMAIN` instead. Keep the file's style; one sentence.
- The spec's P1 section: englishstreetventures/osn#1537 blocks P3, not P1, and open questions 1–3 are answered (cite #1533). Keep the rest.
- Changesets (see "Changesets"): versioned and version-less in separate files. Run `bash scripts/validate-changesets.sh` and `git diff --name-only origin/main...HEAD | bash scripts/changeset-required.sh`.
- Commit "Docs: the dev tier on its own account, built by the Alchemy stacks".

### Task 15: Whole-branch review and gates

- Dispatch `reviewer` with: the branch against this plan; every failure mode has its test; no literal dev host; the production path unchanged (`production-release.yml` and the production rows of every config are byte-identical to the base, except `release-plan.ts`'s production-surface filter).
- Fix every finding (`implementer`), then run the gates and record real output in `NEW-FEAT.md`:
  - `bun install --frozen-lockfile`
  - `bun run check`
  - `bun run lint` and `bash scripts/guard-lint-warnings.sh`
  - `bun run test`, `bun run test:scripts`
  - `bun run fmt:check`
  - `bun audit --audit-level=high --ignore=GHSA-vfj7-8cjw-p6xm --ignore=GHSA-ch52-4w7c-c8xp`
  - `bun run check:alchemy-usage`
  - actionlint (or NOT RUN)
  - `bash scripts/validate-changesets.sh`
- `alchemy plan` against the new account: **NOT RUN** — the account does not exist. What proves it tomorrow is the issue's Done when, through the owner's sequence (above): the merge deploy; `expect_no_change: true` green; `force` with `smoke_fail: osn_social` rolls back and goes red, then a plain dispatch self-heals green; `force` with `smoke_fail: osn_api` rolls back or names the secrets refusal.

## Self-review against the spec (2026-10-17)

- P1 "Alchemy creates every dev Worker, D1 database and R2 bucket in the new account from `deploy.yml`, including zap's first dev Worker and database": Tasks 5–8, 11.
- "dev databases are built from migrations and seeds": Decisions 4–5, Tasks 5–6.
- "the dev Pages sites become static-assets Workers": Tasks 5, 6, 8.
- "Every dev host moves … each value that names a dev host changes with it": Decision 1, the host-value table, Tasks 1, 5–7, 11.
- "musubi social's single-page fallback … checked on Workers static assets, or replaced": `notFoundHandling: "single-page-application"` plus the deep-link probe (Tasks 5, 10).
- "The free-tier ceiling alert starts watching the new account too": Task 13.
- "removes the old dev tier's Wrangler jobs and dev migration scripts": Tasks 11–12.
- "A second deploy plans no change; smoke checks pass": `plan-summary` and `expect_no_change` (Tasks 4, 11); smoke steps in each stack job (Task 11). Both NOT RUN until the account exists.
- `cire-dev-db-rebuild.yml`: retired (Decision 6, Task 12).
- "One deploy per stack and stage at a time": per-stack concurrency group (Task 11).
- Smoke check and rollback after each Alchemy dev deploy, and the Cloudflare-API rollback for Alchemy uploads: Decision 3, Tasks 10–11. Whether Cloudflare treats Alchemy's re-sent secrets as "changed" (code 10220, which makes the smoke check refuse rollback) is unknown until the `force` plus `smoke_fail` dispatch; the check already reports that refusal by name and fails the job.

## Production effects of this change (none touches a production resource)

- The release planner gates zap's production releases on a zap dev deploy, as it gates every surface with a dev job (NEEDS INPUT 5).
- Surfaces that had no dev smoke check (cire host, vendor, landing; musubi social) are now checked on dev; a failed check holds their next production release, as it does for the Workers today.
- `bun.lock` changes (four new workspaces; the root `package.json` workspace globs already cover them), so the next production release offers every production surface; their builds are byte-identical to what runs.
- A stack job builds every site of its stack before it deploys, so one broken site build (cire vendor, say) holds every surface of that stack on dev, and so their next production release, until it is fixed.
- The merge itself is the first deploy: it changes `deploy.yml` and `scripts/deploy-surfaces.ts`, which redeploy every dev stack (`scripts/deploy-surfaces.ts:160-162`). Every `dev` Environment value must be set before the merge.
- `scripts/release-plan.ts` filters production surfaces and walks up to 1000 dev records; `production-release.yml` and every production config row are unchanged.
