---
title: Infrastructure as code (Alchemy)
aliases:
  - Alchemy
  - "@shared/infra"
  - IaC
tags:
  - infra
  - deploy
  - cloudflare
  - secrets
related:
  - "[[production-deploy]]"
  - "[[dev-environment]]"
  - "[[access-control]]"
  - "[[monorepo-structure]]"
  - "[[database-environments]]"
  - "[[osn-and-musubi]]"
last-reviewed: 2026-10-20
---

# Infrastructure as code (Alchemy)

## What it is

Alchemy deploys the Cloudflare resources the monorepo runs — Workers, D1 databases, R2 buckets, custom domains and cron schedules — from one stack per product. `@shared/infra` ([`shared/infra/`](../../shared/infra/package.json)) holds the building blocks those stacks use, and pins `alchemy` at exactly `2.0.0-beta.83`.

**The dev tier deploys through it; production does not yet.** Four stacks build the dev tier in its own Cloudflare account from `.github/workflows/deploy.yml` ([[#The dev deploy]], [[dev-environment]]). Wrangler still deploys every production Worker and Pages site, as [[production-deploy]] describes, until phase P3 of the rollout adopts them. The rollout's design is [`docs/superpowers/specs/2026-10-16-alchemy-rollout-design.md`](../../docs/superpowers/specs/2026-10-16-alchemy-rollout-design.md), under epic englishstreetventures/osn#1490.

Alchemy runs on Effect. Root `package.json` `overrides` hold `@effect/platform-node-shared`, `@effect/sql-d1` and `@effect/sql-sqlite-do` at `4.0.3`, so the tree keeps one copy of `effect`; `shared/infra/tests/package.test.ts` fails on a second copy or on any other Alchemy version.

## Accounts

Dev and production are separate Cloudflare accounts.

- **Production** stays in the current account. Alchemy will adopt its resources in place, under their existing names, so no guest domain moves.
- **Dev** is built fresh in its own account (englishstreetventures/osn#1538), on a zone of its own named by `DEV_DOMAIN` ([[#Dev hosts]]).

[`TIER_ACCOUNTS`](../../shared/infra/src/accounts.ts) names, for each tier, the GitHub Environment and the two Environment secrets that give its jobs their account. A job maps them to `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, the two variables Alchemy reads. No file holds an account id.

| Tier | Environment | Account id secret | API token secret |
|---|---|---|---|
| `dev` | `dev` | `CLOUDFLARE_DEV_ACCOUNT_ID` | `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN` |
| `production` | `production` | `CLOUDFLARE_ACCOUNT_ID` | `CLOUDFLARE_API_TOKEN` |

Dev's names are new because the `dev` Environment's `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN_DEV` reach the production account: they drove the old dev tier's Wrangler deploys, and an Alchemy run that read them would reach production. `accounts.ts` lists those two as `RETIRING_DEV_CREDENTIALS`; no workflow reads them, and the owner deletes them from the `dev` Environment once the new tier has passed its checks ([[dev-environment#Retiring the old dev tier]]). It lists the dev account's read-only token, `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY`, as `DEV_READONLY_CREDENTIALS`, and the repository-level `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN_READONLY` (read-only, production account) as `REPOSITORY_CREDENTIALS`.

Two checks enforce these names:

- `shared/infra/tests/accounts.test.ts` reads every `.github/workflows/*.yml`. It fails when a workflow reads a Cloudflare credential `accounts.ts` does not classify, and when any workflow but `alchemy-state.yml`, `deploy.yml` and `free-tier-ceiling-alert.yml` reaches the dev account.
- `secrets:check-github` (below) fails when an Environment holds the other tier's credential (`forbiddenCredentials()`): `dev` must not hold `CLOUDFLARE_API_TOKEN`; `production` must not hold `CLOUDFLARE_API_TOKEN_DEV`, `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN`, `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY` or `CLOUDFLARE_DEV_ACCOUNT_ID`.

The credentials a run carries choose the account, and no stack checks which account that is. `assertDevDeployTarget()` checks only that `OSN_DEPLOY_TIER` names the stage's tier and that both credentials are set ([[#How a stack run starts]]); `token:check`, below, is the one check that ties a token to its tier, and only a run that calls it first gets it. So the Environment a job runs in, or the credentials a person exports, must match the stage.

A token can reach more than one account: one created with "All accounts" by a member of both reaches production from the `dev` Environment, which has no reviewer. A token also holds zone grants apart from its accounts, so a grant on another account's zone need not show in its account list. So before Alchemy runs, `bun run --cwd shared/infra token:check -- --tier <dev|production>` ([`scripts/check-token-reach.ts`](../../shared/infra/scripts/check-token-reach.ts)) lists the accounts `CLOUDFLARE_API_TOKEN` reaches (`GET /accounts`) and stops the run unless it is exactly the one `CLOUDFLARE_ACCOUNT_ID` names. With `--tier dev` it needs `DEV_DOMAIN` too, reads every page of the zones the token can act on (`GET /zones`), and refuses a zone of another account, a production zone or a name under one, and a token that cannot act on the `DEV_DOMAIN` zone; the last also refuses an account id that names production. It exits 1 on any of those, 2 when an argument or variable is missing or a listing fails, and prints no account id. Every CI job that runs Alchemy runs it first: the two tier steps of `alchemy-state.yml` (`--tier dev` with `DEV_DOMAIN`, and `--tier production`), and each stack job of `deploy.yml` before its first step that holds the dev token (W12 in `shared/infra/tests/workflow-secrets.test.ts`). No stack and no package script runs it, so a run by hand runs it first ([[#How a stack run starts]]).

## The building blocks

Every builder takes each setting where Alchemy's default differs from today's Wrangler config as a required input, so a stack cannot inherit a default by leaving a field out. Each `*Props()` function is pure and tested; the wrapper of the same name without `Props` declares the Alchemy resource with its removal policy.

| Export | What it does | Alchemy default or behaviour it overrides |
|---|---|---|
| `apiWorker()`, `apiWorkerProps()` | A Worker with code. Every setting is required: the Worker's inventory key (`worker`), entry, whether Alchemy bundles it (`bundle`), the static assets it serves beside its code (`assets`, or `null`), compatibility date and flags, custom domain, crons, the stable `workers.dev` URL, version preview URLs, vars, bindings, secrets and observability, Workers Issues included. A bundled Worker passes rolldown `WORKER_BUNDLE_EXTERNAL`: Alchemy's own `lightningcss` and `fsevents`, plus `BUN_ONLY_MODULES` (`drizzle-orm/bun-sqlite`), so no bundle names `bun:sqlite`. A prebuilt Worker (`bundle: false`) passes no build options. A `null` domain detaches every custom domain. Production refuses preview URLs. No var or binding may take a name the secret inventory lists for the Worker, except a var the stage's own tier lists in `plainVars`. Invocation logs are off unless the input turns them on. Zone routes stay unmanaged. Its refusals are in [[#Errors]]. | An upload keeps only the secrets it declares and deletes the rest, so a stack that passed `{}` or a subset would delete live secrets; `workers.dev` and version preview URLs on; invocation logs on when `observability` is omitted; Workers Issues turned off on the next full deploy when `observability.issues` is omitted; five `ALCHEMY_*` plain-text bindings bound first, so a secret of the same name is silently dropped; an `external` list replaces Alchemy's own rather than adding to it |
| `siteWorker()`, `siteWorkerProps()` | A static-assets Worker for a built site. Alchemy applies the directory's `_headers`, and its `_redirects` unless `redirectsFile` is `false`, which sends an empty list that overrides the file. A site with an `entry` runs that module for the paths its `runWorkerFirst` rules name; one with `entry: null` uploads no script. HTML and not-found handling, the stable `workers.dev` URL, version preview URLs and Workers Issues are required; production refuses preview URLs. Query strings redacted, native traces and invocation logs off, on every stage. | `workers.dev` and version preview URLs on; invocation logs on; Workers Issues turned off on the next full deploy when `observability.issues` is omitted |
| `retainedD1()`, `retainedD1Props()` | A D1 database kept on destroy: name, read replication and jurisdiction. `migrations` only once Alchemy is the database's migrator. `importFiles`, SQL files imported after the migrations, re-imported only when a file's hash changes, refused on production. A location hint only on a stage that creates the database. | Removal policy `destroy`; a declared `primaryLocationHint` that differs from live replaces the database |
| `retainedBucket()`, `retainedBucketProps()` | An R2 bucket kept on destroy: storage class, jurisdiction, public access, lifecycle rules, CORS and custom domains all required; `forceDestroy: false`; object locks left unmanaged. The same location-hint rule as D1. | Removal policy `destroy`; omitted lifecycle rules, CORS or custom domains are cleared; a changed location hint replaces the bucket |
| `flattenMigrations()` | Copies the top-level `*.sql` files of a migrations directory, names and bytes unchanged, into a target it empties first ([[#Migrations]]). Throws `MigrationsSourceError` when the source holds no `.sql` file or the target is inside it. | Alchemy refuses a directory holding `meta/_journal.json` |
| `requireSecrets()` | Reads every secret the inventory names for a Worker's tier from `env` and returns them `Redacted`, and refuses before anything uploads: a required value unset or blank, a value with leading or trailing whitespace, or a value that breaks a rule its tier sets ([[#Secrets]]). | An upload keeps only the secrets the stack declares and drops every other secret the Worker holds |
| `requireSeedValue()` | Reads one value a stack builds its own seed from, which no Worker receives; throws `SeedValueError`, naming the variable and never its value, when it is unset, blank or padded. | — |
| `assertSiteBuiltFor()`, `PrebuiltSite` | Refuses a prebuilt site directory that is missing, or whose text files, taken together, lack an origin the site's build bakes in for the stage ([[#Sites]]). | Alchemy uploads whatever the directory holds |
| `stackOptions()` | The providers and state store every stack passes to `Alchemy.Stack`: `Cloudflare.providers()` and `Cloudflare.state()` ([[#State store]]). | — |
| `removalFor()`, `assertRetained()`, `assertStackRetained()` | Storage is always retained; a Worker on `dev` or `production` is retained, because deleting it deletes its secrets; an investigation stage's Workers are destroyed with it. Every stack ends with `assertStackRetained({ stage, storage, workers })`, which asserts its storage always and its Workers where `removalFor()` retains them, so a lost `retain()` fails the plan rather than a destroy. | Workers, D1 databases and R2 buckets default to removal policy `destroy` |
| `parseStage()`, `tierOf()`, `isLongLivedStage()`, `physicalName()` | The stage rules ([[#Stages]]). | Alchemy's generated `${app}-${stage}-${id}` names: a long-lived resource always passes its name |
| `parseDevDomain()`, `readDevDomain()`, `stageHosts()`, `origin()`, `devHostOutputs()` | The dev host layout ([[#Dev hosts]]). | — |
| `assertDevDeployTarget()`, `refuseDotEnvFiles()`, `refuseProductionTier()` | The checks a stack makes before it declares anything ([[#How a stack run starts]]). | Credentials from a stored profile when either variable is unset; `.env` files loaded into `process.env` |
| `STACK_KEYS`, `STACK_WORKERS`, `STACK_STEP_SECRETS` | The four stacks in deploy order, the inventory Workers each deploys, and the secrets a stack job reads besides its Workers' own, each with the step that reads it: `deploy`, which runs Alchemy, or `cire_seed`, the musubi job's step that derives osn-api's seed values ([[#Seeds and the ARC registration]]). Only the musubi stack has any, and `cire_seed` reads all three. `shared/infra/tests/workflow-secrets.test.ts` holds each stack job in `deploy.yml` to them. | — |
| `TIER_ACCOUNTS`, `accountSecrets()`, `allowedCredentials()`, `forbiddenCredentials()`, `knownCredentials()` | Credential names per tier ([[#Accounts]]). | — |
| `SECRET_INVENTORY`, `tierSecrets()`, `SHARED_SECRET_VALUES`, `DEPLOY_ENVIRONMENT` | The secret inventory ([[#Secrets]]). `DEPLOY_ENVIRONMENT` lists the names a deploy job sets itself (`CI`, `DO_NOT_TRACK` and every credential), which no Worker secret may share. | — |

`shared/infra/tests/declare.test.ts` registers each wrapper on a bare stack, with no provider or credentials, and checks the removal policy Alchemy records for it on `dev`, `production` and an investigation stage.

### Errors

Each refusal is a `Data.TaggedError`. Every one names secret names, never values.

| Error | Thrown by | When |
|---|---|---|
| `UndeclaredSecretsError` | `apiWorkerProps()` | `secrets` leaves out a name the inventory requires of that Worker on the stage's tier, or passes a name the inventory does not declare there |
| `BindingNameClashError` | `apiWorkerProps()` | One name appears in two of vars, bindings and secrets, or starts with `ALCHEMY_` |
| `SecretAsPlainBindingError` | `apiWorkerProps()` | A var or binding takes a name the inventory lists for that Worker on either tier (required, optional or forbidden), unless it is a var the stage's own tier lists in `plainVars`. A var reaches the Worker as plain text that `wrangler secret list` never shows |
| `ProductionPreviewUrlsError` | `apiWorkerProps()`, `siteWorkerProps()` | `previewUrls` is true on production. Each version's preview URL is a public `workers.dev` host outside any Access gate |
| `ProductionObservabilityError` | `apiWorkerProps()` | On production, query strings are not redacted or native traces are on ([[#Production observability]]) |
| `AdoptedLocationHintError` | `retainedD1Props()`, `retainedBucketProps()` | A location hint is declared on production, where the storage is adopted |
| `MissingSecretsError` | `requireSecrets()` | A required secret is unset, empty or only whitespace (`missing`), any value has leading or trailing whitespace (`malformed`), or a value breaks a rule its tier sets (`breaksRule`): on dev, `STRIPE_SECRET_KEY` must start `sk_test_` or `rk_test_`, and `DEV_LOGIN_SECRET` must be at least 32 characters |
| `NoWorkerOnTierError` | `tierSecrets()` | The Worker has no deployed script on that tier |
| `UnretainedResourceError` | `assertRetained()`, `assertStackRetained()` | A resource a long-lived stage keeps would be deleted on destroy or replacement |
| `ProductionSeedError` | `retainedD1Props()` | `importFiles` on production, whose data no seed may touch |
| `MigrationsSourceError` | `flattenMigrations()` | The source holds no `.sql` file, or the target is inside it |
| `SeedValueError` | `requireSeedValue()` | A seed value is unset, blank or padded |
| `SiteBuildError` | `assertSiteBuiltFor()` | A prebuilt site's directory is missing, or lacks an origin its build bakes in for the stage. It names the site, the directory and each missing origin |
| `StageNotDeclaredError` | `refuseProductionTier()`, `assertDevDeployTarget()`, `stageHosts()` and every stack declaration | The stage is the production tier, which the stacks declare from P3 |
| `DeployTargetError` | `assertDevDeployTarget()`, `refuseDotEnvFiles()` | `OSN_DEPLOY_TIER` does not name the stage's tier, a Cloudflare credential is unset or blank, or the stack directory holds a `.env` file Bun would load ([[#How a stack run starts]]) |
| `MissingDevDomainError` | `readDevDomain()` | `DEV_DOMAIN` is unset or empty |
| `InvalidDevDomainError` | `parseDevDomain()`, `stageHosts()` | `DEV_DOMAIN` is not a bare lower-case domain, is or is under a production zone or `workers.dev`/`pages.dev`, or a derived host passes 253 characters ([[#Dev hosts]]) |
| `InvalidStageError` | `parseStage()` and everything that calls it | The stage breaks the rules in [[#Stages]] |

Storage on production is adopted, and an adopted resource is changed to match its declaration, so a production declaration states each setting exactly as it is live. A stage that creates storage — `dev` or an investigation stage — passes a location hint to place it where production's is, and declares production's settings: every D1 database in `oc` with its production database's read replication, and the R2 buckets `Standard`, `enam`, private, with no CORS or custom domain and production's one lifecycle rule ([[database-environments]]).

## Stages

`parseStage()` ([`shared/infra/src/stage.ts`](../../shared/infra/src/stage.ts)) accepts lowercase letters and digits in groups joined by single hyphens, starting with a letter, 1 to 20 characters. It refuses three names besides:

| Stage | Why it is refused |
|---|---|
| `prod` | The production D1 databases are `osn-db-prod` and `zap-db-prod`, so a stage `prod` derives a live production name |
| `staging` | `osn-db-staging` exists, and `osn/api/wrangler.toml` declares `[env.staging]` |
| `local` | It is the `OSN_ENV` posture of `wrangler dev` (`osn/api/wrangler.toml` `[vars]`) |

`dev` and `production` are the long-lived stages, and `physicalName()` gives each resource today's name on them: production by adoption, dev by creating the dev account's resources under the old dev tier's names (`osn-api-dev`, `cire-db-dev`, …). Any other stage is an investigation stage and derives `<base>-<stage>` (`cire-db-pr-7`); `physicalName()` refuses a derived name equal to a dev or production name, or longer than 63 characters, Cloudflare's limit for Worker script and R2 bucket names.

Only the stage spelled exactly `production` is the production tier (`tierOf()`). Every other stage, investigation stages included, runs on the dev tier, in the dev account, with the `dev` Environment's secrets.

## The stacks

Each product has one stack, `<product>/infra/alchemy.run.ts`, in a workspace named `@<product>/infra`. Its declaration is a pure module, `src/declaration.ts`, which the tests evaluate offline; `alchemy.run.ts` reads the environment, writes the generated files and turns the declaration into resources.

| Directory | Stack name | Declares (dev names) |
|---|---|---|
| `musubi/infra` (`@musubi/infra`) | `musubi` | Our identity instance: osn-api (`osn-api-dev`) with its D1 database (`osn-db-dev`) and seed, musubi social (`osn-social-dev`), musubi landing (`musubi-landing-dev`) |
| `cire/infra` (`@cire/infra`, version-less like every `@cire/*`) | `cire` | cire-api (`cire-api-dev`) with its D1 database (`cire-db-dev`), seeds and R2 buckets (`cire-assets-dev`, `cire-sheets-dev`), cire-invites (`cire-invites-dev`), cire host, cire vendor, cire landing (`cire-host-dev`, `cire-vendor-dev`, `cire-landing-dev`) |
| `zap/infra` (`@zap/infra`) | `zap` | zap-api (`zap-api-dev`) and its D1 database (`zap-db-dev`) |
| `pulse/infra` (`@pulse/infra`) | `pulse` | Pulse landing (`pulse-landing-dev`), a Worker serving `/api/geo` beside its assets |

The stack name equals the directory name. It keys Alchemy's state rows and becomes the `ALCHEMY_STACK_NAME` binding on every Worker, so it never changes after a stack's first deploy; the logical ids in `alchemy.run.ts` (`OsnApi`, `CireDb`, …) key the rows too. `osn/` stays headless: the hosted instance's configuration is Musubi's ([[osn-and-musubi]]), and a stack template for independent OSN instances, `osn/infra`, is englishstreetventures/osn#1539. `pulse/api` has no deploy job and no stack.

**Every stack refuses the production tier.** Each declaration throws `StageNotDeclaredError`, naming phase P3 of englishstreetventures/osn#1490, for any stage `tierOf()` calls production. Investigation stages are accepted: their names come from `physicalName()` and their hosts from `stageHosts()`.

**What the tests hold.** Each label below begins a test's name, so a search finds it. Each stack's tests check its names against the old dev tier's (K1), its bindings, vars and secret names against Wrangler's `[env.production]` with every difference listed and given a reason (K2), compatibility date, flags and crons (K3), invocation logs off on cire-api and cire-invites (K4), every storage resource retained (K5), production's storage settings (K6), no literal host in stack source (K7), a production stage refused (K8), every `env.NAME` each API Worker's source reads declared or listed as deliberately unset on dev (K9), and an offline rolldown bundle of each API Worker that names no `bun:sqlite` and whose files, source maps included, gzip to 3 MiB or less, the Workers Free limit (K10; the measured sizes are in [[free-tier-limits]]).

Every stack is also evaluated offline through Alchemy with an in-memory state and a `fetch` that throws (`tests/stack.test.ts`). The evaluation holds:

- no Worker serving a `workers.dev` host or version preview URLs, each a public host outside Access (K11). englishstreetventures/osn#1578 turns preview URLs on for per-pull-request previews;
- every refusal made before the stack writes a file or calls Cloudflare: `OSN_DEPLOY_TIER` unset or naming production, a blank credential, a production zone as `DEV_DOMAIN`, the production stage, a `.env` file in the working directory, and every required secret blank (K12);
- each dev surface's smoke target naming the Worker the stack deploys for it (K13);
- each cire site uploading its build as it is: the guest site Astro's server entry, unbundled, with its client output as assets, and the others their output alone (K14);
- a prebuilt site accepted when its output holds the origins its dev build bakes in, and refused when built for other hosts or none (SB9).

The helpers every stack's tests share live in `shared/infra/tests/support/`: `literal-hosts.ts` (the K7 scanner), `evaluate-stack.ts` (the offline evaluation) and `refused-targets.ts` (the K12 table).

### How a stack run starts

`alchemy.run.ts` reads and checks every input before it writes a file or declares a resource, so a refused run writes nothing:

Each stack body takes its working directory as an input, `workingDir`; `alchemy.run.ts` passes `process.cwd()`.

1. `refuseDotEnvFiles(workingDir)` refuses a stack directory holding any of the eight `.env` files Bun loads (`.env`, `.env.local`, and the `.development`, `.production` and `.test` pairs). Alchemy's CLI hands off to Bun, which would load one into `process.env` and so into the stack.
2. `assertDevDeployTarget(stage, env)` requires `OSN_DEPLOY_TIER` equal to the stage's tier and both `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` non-blank. Alchemy takes the account from the environment only when both are set; otherwise it loads a stored profile, whose account may be production's. The deploy step sets `OSN_DEPLOY_TIER: dev` beside the dev credentials. It does not check which account the credentials reach ([[#Accounts]]).
3. `readDevDomain(env)` and `stageHosts()` derive every host ([[#Dev hosts]]).
4. `assertSiteBuiltFor()` checks each prebuilt site directory, resolved from `workingDir`, against the stage's hosts ([[#Sites]]). The musubi, cire and pulse stacks have prebuilt sites; zap has none.
5. `requireSecrets()` reads every Worker secret, and the musubi stack's `requireSeedValue()` the three seed values its job's `cire_seed` step derives ([[#Seeds and the ARC registration]]).
6. Only then: `flattenMigrations()`, the generated seed files, the resources, and `assertStackRetained()`.

Generated files go under `<product>/infra/.generated/` (git-ignored, `*/infra/.generated/`).

**Running a stack by hand.** Export the dev credentials as `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, and `DEV_DOMAIN`, then:

1. `bun run --cwd shared/infra token:check -- --tier dev`. Go on only when it exits 0: nothing in the stack checks which account the token reaches.
2. Build the stack's sites with that stage's hosts: `bun run --cwd shared/infra dev-hosts -- --stage <stage>` prints them, and each build takes the values its stack job in `deploy.yml` passes. A site built for other hosts, or not built, fails the site check before anything is written.
3. For the musubi stack, set `CIRE_API_ARC_KEY_ID`, `CIRE_API_ARC_PUBLIC_JWK` and `CIRE_OIDC_CLIENT_SECRET_SHA256`: `GITHUB_OUTPUT=<file> bun --no-install musubi/infra/scripts/derive-cire-seed.ts`, with the three cire secrets set, writes them to `<file>` as `key_id`, `public_jwk` and `client_secret_sha256`.
4. From the stack's directory, with `OSN_DEPLOY_TIER=dev` and the stack's secrets set: `bun run plan:dev` or `bun run deploy:dev` (each sets `DO_NOT_TRACK=1`).

An investigation stage runs the same steps with its own stage, `DO_NOT_TRACK=1 bun alchemy deploy --stage <name>`, its sites built for that stage's hosts.

### Dev hosts

One GitHub `dev` Environment **variable**, `DEV_DOMAIN`, names a zone in the dev account: the bare domain, no scheme. `stageHosts(domain, stage)` ([`shared/infra/src/hosts.ts`](../../shared/infra/src/hosts.ts)) derives every host from it, under `DEV_DOMAIN` for stage `dev` and under `<stage>.<DEV_DOMAIN>` for an investigation stage. The labels mirror production's shape, so each product keeps its own same-site relationships:

| Key | Dev host | Production |
|---|---|---|
| `musubiSocial` (WebAuthn RP ID, osn-api cookie domain) | `musubi.<D>` | `musubi.social` |
| `osnApi` (OIDC issuer) | `id.musubi.<D>` | `id.musubi.social` |
| `musubiLanding` | `www.musubi.<D>` | none |
| `cireLanding` | `cire.<D>` | `cireweddings.com` |
| `cireApi` | `api.cire.<D>` | `api.cireweddings.com` |
| `cireInvites` | `invite.cire.<D>` | `invite.cireweddings.com` |
| `cireHost` | `host.cire.<D>` | `host.cireweddings.com` |
| `cireVendor` | `vendor.cire.<D>` | `vendor.cireweddings.com` |
| `zapApi` | `zap.cire.<D>` | `zap.cireweddings.com` |
| `pulseLanding` | `pulse.<D>` | none |

`parseDevDomain()` refuses a value that is not a bare lower-case domain of two or more labels, a production zone (`cireweddings.com`, `musubi.social`, `pulse.events`) or a name under one, and `workers.dev` or `pages.dev` or a name under either: their hosts take the shape `<script>.<subdomain>.workers.dev`, which this layout cannot use. `readDevDomain()` refuses an unset or empty `DEV_DOMAIN`. One gap follows from one zone: cire and musubi dev hosts are same-site with each other, while in production they are cross-site, so a defect that depends on them being cross-site does not show on dev.

The stacks call `stageHosts()` for every var and domain that names a host. The workflow reaches the same values through the `dev-hosts` command (`bun run --cwd shared/infra dev-hosts -- --stage dev`), which writes each host's origin as a step output (`<key>_origin`, the key in snake case: `cire_api_origin`, `musubi_social_origin`, …), plus `oidc_redirect_uri`, `stripe_webhook_url` and `stripe_platform_webhook_url`, and appends them to the run summary. It exits 2, writing nothing, when `DEV_DOMAIN` is missing or refused. `shared/infra/tests/workflow-hosts.test.ts` checks that every `steps.hosts.outputs.<key>` any workflow reads is one `dev-hosts` writes, from a `hosts` step earlier in the same job.

### Migrations

Alchemy is each dev database's only migrator, through the D1 resource's `migrations` prop; no Wrangler migration step runs against a dev database. Alchemy refuses a migrations directory holding `meta/_journal.json`, and all three of ours hold one (`cire/db/migrations/`, `osn/db/drizzle/`, `zap/db/drizzle/`). So each run calls `flattenMigrations()`, which copies the top-level `*.sql` files, names and bytes unchanged, into `.generated/migrations/<database>/`, after emptying it so a file deleted upstream cannot linger, and the `migrations` prop points there. The names stay Wrangler's ledger names, which the production ledger conversion in P3 matches on.

Alchemy keeps its own ledger, `__alchemy_migrations`, and applies any file it has not recorded. A migration that fails part-way is not rolled back, because D1's HTTP API has no transactions; the dev database then fails every later deploy on that migration. No scripted recovery exists yet (englishstreetventures/osn#1554); fix forward with a new migration.

### Seeds and the ARC registration

Seeds reach a dev database through the D1 resource's `importFiles`, which run after the migrations and re-import a file only when its hash changes. Every generated file is byte-identical for identical inputs, so a second deploy re-imports nothing. No stack calls another.

- **musubi** generates one file for `osn-db-dev` ([`musubi/infra/src/seeds.ts`](../../musubi/infra/src/seeds.ts)):
  - an upsert of the `cid_cire` OIDC client row ([[oidc-provider]]), its redirect URI `${origin(cireApi)}/api/auth/oidc/callback` and its hash the SHA-256 hex of `CIRE_OIDC_CLIENT_SECRET`, as osn-api's own check computes it;
  - an upsert of cire-api's ARC service account and key ([[arc-tokens]]), the public JWK of `CIRE_API_ARC_PRIVATE_KEY` under `CIRE_API_ARC_KEY_ID`, with the four scopes cire-api requests (`graph:read`, `graph:resolve-account`, `org:read`, `account:email-read`).

  A re-import never undoes what an operator did in the database. It leaves a disabled client disabled and a revoked or expired key so, because the upserts never write `disabled_at`, `revoked_at` or `expires_at`; and it leaves a key id that another service holds to that service. So replacing a revoked or expired key takes a new `CIRE_API_ARC_KEY_ID`.

  The stack takes no cire secret. The musubi job's `cire_seed` step, "Derive osn-api's cire seed values", alone holds `CIRE_OIDC_CLIENT_SECRET`, `CIRE_API_ARC_KEY_ID` and `CIRE_API_ARC_PRIVATE_KEY` (`STACK_STEP_SECRETS`). It runs [`musubi/infra/scripts/derive-cire-seed.ts`](../../musubi/infra/scripts/derive-cire-seed.ts) with `bun --no-install`, so no package code runs beside them, and writes three step outputs: `key_id`, `public_jwk` (`kty`, `crv`, `x` and `y`, never `d`) and `client_secret_sha256`. The deploy step reads them as `CIRE_API_ARC_KEY_ID`, `CIRE_API_ARC_PUBLIC_JWK` and `CIRE_OIDC_CLIENT_SECRET_SHA256`, through `requireSeedValue()`, and the stack refuses a public key that carries `d`. The SQL carries the hash and the public key, never the client secret or the private key.
- **cire** imports `cire/db/seed/dev-seed.sql`, then, when the `dev` Environment variable `CIRE_DEV_OWNER_PROFILE_ID` is set, a generated file that gives the seeded wedding's owner seat to that profile. The value must match `^usr_[A-Za-z0-9_-]+$`; empty means no file. `cire/infra/tests/seeds.test.ts` holds the statements equal to the local seed's in `scripts/cire-db-seed.sh`.
- **zap** imports nothing.

Known risk, unverified: Alchemy's import fails when Cloudflare's import call returns no upload URL, which may happen when a file's content returns to one imported before — `CIRE_DEV_OWNER_PROFILE_ID` set back to an earlier value, say. Changing the content again recovers.

The dev asset bucket is filled once by hand ([[dev-environment]]).

### Bundling and the module registry

Alchemy bundles osn-api, cire-api and zap-api from their `src/index.ts` with rolldown (`bundle: true`). Each declares Wrangler's flags plus `legacy_module_registry`, so it keeps the module registry Wrangler deploys it with; without that flag a bundled Worker gets the new registry. Moving to the new registry is a later change, on both tiers at once.

cire-invites keeps its Astro build on dev: the stack uploads `cire/invites/dist/server/entry.mjs` as a prebuilt Worker (`bundle: false`) with `dist/client` as its assets, and passes its flags verbatim (`["nodejs_compat"]`). A prebuilt upload leaves out `*.js.map`, so its source maps do not reach dev. Its dev build takes `ASTRO_KEY` from a `dev` Environment secret so two builds of one commit are byte-identical and a second deploy plans no change; root `turbo.json` passes `ASTRO_KEY` through to the build (`passThroughEnv`) without hashing it. Astro writes the key into the server output's manifest, so the cire stack job builds `@cire/invites` with turbo's cache off (`--cache=local:,remote:`): it never replays a build made with another key, and never leaves the key in `.turbo`, which the job saves to a cache other runs restore. No cache key is made from a secret (`scripts/tests/deploy-workflows.test.ts`).

### Sites

Every dev site is a Workers static-assets site, not a Pages project. Each applies its built `_headers` and `_redirects`, except musubi social: its `_redirects` (`/* /index.html 200`) stays for production's Pages project, and on the Worker the stack sends an empty redirect list and serves deep links through `notFoundHandling: "single-page-application"`. The other sites build no `404.html`, so their not-found handling is `none`: an unknown path answers 404 where Pages served `index.html`. The organiser and vendor portals route in the URL hash, so no deep link reaches the server.

The stack uploads each site's build output as it is, so before it writes or declares anything it checks each prebuilt directory with `assertSiteBuiltFor()`: the directory must exist, and its text files (`.html`, `.js`, `.mjs`, `.css`, `.json`, `.xml`, `.txt`, `_headers`, `_redirects`), taken together, must hold every origin the site's build bakes in for the stage, each as a whole origin. Output that lacks one was built for other hosts, or none, and would call the wrong API. `SiteBuildError` names the site, the directory and each missing origin.

| Site | Origins its dev build must hold |
|---|---|
| musubi social | osn-api |
| musubi landing | musubi social, musubi landing |
| cire-invites, client output | cire-api |
| cire-invites, server output | cire-api, cire-invites, cire landing |
| cire host | cire-api, musubi social, cire-invites |
| cire vendor | cire-api, musubi social |
| cire landing | cire landing, cire host |
| pulse landing | pulse landing |

So any run that evaluates a stack with sites — `plan`, `deploy` or `destroy`, on `dev` or an investigation stage — needs those sites built with that stage's hosts first.

Pulse landing's `GET /api/geo`, a Pages Function on the Pages preview project, is served on dev by the Worker's own entry ([`pulse/landing/worker/index.ts`](../../pulse/landing/worker/index.ts)), which runs for `/api/*` (`runWorkerFirst`) and hands every path but `/api/geo` to the assets; the Pages Function and the Worker share one handler (`pulse/landing/src/lib/geo.ts`).

## The dev deploy

`.github/workflows/deploy.yml` runs on every push to `main` and on dispatch. Its shape:

```
changes ──┐
          ├──> stack-<stack>-dev ──> deploy-<surface>-dev  (one per surface)
build ────┘
```

`changes` writes one output per dev surface and one per stack (`stack_<key>`) from [`scripts/deploy-surfaces.ts`](../../scripts/deploy-surfaces.ts). A change under a stack's own `infra/` directory runs that stack; one under `shared/infra/` runs every stack. Neither offers a production surface.

**One stack job per stack** (`stack-musubi-dev`, `stack-cire-dev`, `stack-zap-dev`, `stack-pulse-dev`, "Alchemy <stack> stack — dev") deploys the whole stack, in the `dev` Environment, in its own concurrency group `deploy-dev-<stack>` that never cancels. In order:

1. Refuse `force` together with `expect_no_change`.
2. Install with `--frozen-lockfile`, run `dev-hosts`, and build the stack's sites against those hosts. No install or build step holds a credential or a Worker secret; the invites build reads `ASTRO_KEY` alone. Each job then runs `scripts/guard-bundle-size.sh` on every guarded site it built: cire's four, musubi landing and pulse landing ([[bundle-size-guards]]).
3. **Token check**: `token:check -- --tier dev` stops the job unless the dev token reaches the dev account and no other, and acts on the `DEV_DOMAIN` zone and no production zone ([[#Accounts]]). No earlier step holds the token.
4. **Snapshot**: `scripts/worker-deployments.ts snapshot` records each Worker's newest deployment, and writes `force=true` when any Worker's newest deployment carries the smoke check's rollback message.
5. Refuse `expect_no_change` while the snapshot says `force`.
6. **Seed values** (musubi only): the `cire_seed` step derives osn-api's seed values from the three cire secrets it alone holds ([[#Seeds and the ARC registration]]).
7. **Deploy**: `bun run deploy:dev` in the stack directory, with `--force` when dispatched with `force` or when the snapshot says so. Its env holds the dev credentials, `OSN_DEPLOY_TIER: dev`, `DEV_DOMAIN`, `DO_NOT_TRACK: "1"` and exactly the dev inventory secrets of the stack's Workers; the musubi step also reads the `cire_seed` step's three outputs, and the cire step the `CIRE_DEV_OWNER_PROFILE_ID` variable.
8. **Plan summary**: `plan-summary` appends the plan's change counts and the stack name to the run summary, never a line of Alchemy's output. With `expect_no_change` it fails unless the plan was `no changes`.
9. **Compare**: `scripts/worker-deployments.ts compare` names, per Worker, the deployment the deploy made, or `unchanged`, or `unknown` when it cannot read the Worker. Snapshot and compare try each read of a Worker's deployments up to three times, 1 s then 2 s apart, after a network error, a timeout, a 429 or a 5xx; `unknown` means all three failed, or the Worker has no deployment after the deploy.
10. **One smoke check per surface**, `scripts/smoke-check.ts <surface> dev`, with `SMOKE_ORIGIN` from `dev-hosts` and `SMOKE_DEPLOYMENT` from the compare step. A failed check rolls back only the deployment this run made, and only while it is still the newest. A browser host's check also fails, with no rollback, when Cloudflare Access does not guard it ([[production-deploy#7. Post-deploy verification (smoke checks)]]).
11. Fail the job when any check failed or the compare step failed.

**Build caches.** The musubi, cire and pulse jobs each keep a turbo cache of their own, since turbo hashes each dev build's `PUBLIC_*`, `VITE_*` and `SITE` values and the `build` job's cache never holds a dev build. Each saves `.turbo` under `<os>-turbo-dev-<stack>-<bun.lock hash>-<commit>`. With no cache under that key, it restores the newest cache under the first of these prefixes that has one: `<os>-turbo-dev-<stack>-<bun.lock hash>-`, `<os>-turbo-dev-<stack>-`, then the `build` job's `<os>-turbo-build-`. zap builds nothing and keeps none. The guest site always builds with the cache off ([[#Bundling and the module registry]]).

**Rollback is judged by deployment id.** Alchemy reports no version id for a normal deploy, and it plans against its own state, not the live Worker. So the smoke check never rolls back an `unchanged` Worker, and after a rollback the stack's state still names the code the rollback removed: the next run's snapshot sees the rollback message, deploys with `--force`, and re-uploads what the commit declares. An `unchanged` Worker whose newest deployment is a rollback fails its check at once, so a failed heal never records success. Roll a dev Worker back only through the smoke check: a rollback made by hand carries no rollback message, so no run sees it and dev keeps serving it.

**One record job per surface** keeps the job id and name the release planner reads (`deploy-cire-api-dev`, "Deploy cire/api — dev", …). It runs in the `dev` Environment when its stack job's deploy step succeeded, its compare step read every Worker, and its own surface's check passed, and does nothing else: it leaves that surface's dev Deployment record. `scripts/tests/deploy-workflows.test.ts` holds the stack jobs, record jobs and smoke steps to the surface map.

**Dispatch inputs:**

| Input | Effect |
|---|---|
| `smoke_fail` | That dev surface's check fails on purpose: its stack job goes red, rolling the Worker back when this run uploaded it |
| `expect_no_change` | Each stack job fails unless its deploy planned no change: the proof that a second deploy is a no-op |
| `force` | Every resource is re-uploaded, unchanged ones too |

A dispatch deploys every stack. A stack job builds every site of its stack before it deploys, so one broken site build holds every surface of that stack on dev, and so their next production release.

## Secrets

### The inventory

[`SECRET_INVENTORY`](../../shared/infra/src/secrets/inventory.ts) lists every secret each deployed Worker holds — `osn-api`, `cire-api`, `zap-api` and `cire-invites` — with the directory whose code reads them. For each tier it gives:

| Field | Meaning |
|---|---|
| `scriptName` | The deployed script name, or `null` where the tier has no Worker |
| `secrets` | Required names, sorted. Declared on every deploy; a missing value fails it |
| `optional` | Names declared only while their GitHub secret holds a value. Today only osn-api's `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS`, set while a TOTP key rotation drains |
| `forbidden` | Names that must never be set on that Worker on that tier |
| `plainVars` | Names this tier holds as plain-text vars although another tier holds them as secrets. Only cire-api's dev `OSN_API_URL`, osn-api's dev origin derived from the dev domain |

Alchemy uploads a Worker with exactly the secrets its stack declares and drops the rest. A Worker therefore starts holding a new secret only through an inventory change in a reviewed pull request: setting a GitHub secret alone deploys nothing, and a live secret the inventory lacks is deleted by that Worker's next Alchemy deploy. `shared/infra/tests/secrets/inventory.test.ts` checks that each Worker's code reads every required and optional name declared for it. It also reads its expectations from the files that set them: osn-api requires every secret `osn/api/wrangler.toml` marks `REQUIRED non-local` and every name the production preflight requires, and production forbids every name a production preflight in `production-release.yml` refuses.

On dev, cire-api's `OSN_API_URL` is a var derived from the dev domain, not a secret; passing it as a dev secret throws `UndeclaredSecretsError`. Production keeps it as a secret. zap-api's dev Worker requires `INTERNAL_SERVICE_SECRET`.

Forbidden today: `DEV_LOGIN_SECRET` on osn-api production, `RESEND_API_URL` on osn-api and cire-api on both tiers, and `GROWTHBOOK_CLIENT_KEY` on zap-api on both tiers. No zap code reads that key; it stays live on production until zap-api's first production Alchemy deploy deletes it (englishstreetventures/osn#1532). cire-api production keeps its own `GROWTHBOOK_CLIENT_KEY`.

### GitHub Environment secrets

Each value lives in the GitHub Environment secret **of the same name**, in the `dev` or `production` Environment. A name two Workers hold on one tier is therefore one GitHub secret, and the next Alchemy deploy gives both Workers its one value. `SHARED_SECRET_VALUES` lists each such pair on purpose, and a test fails on a shared name it does not list. It holds `INTERNAL_SERVICE_SECRET` on both tiers, shared by osn-api and zap-api, because zap-api registers its ARC key at osn-api with it.

Production values are today's live values, which the owner holds; each one with a public or stored counterpart is shown to match live before production moves to Alchemy (englishstreetventures/osn#1537). Dev values are new, made for the dev account (englishstreetventures/osn#1538); [[dev-environment#4. Bootstrapping the dev account]] lists them.

> [!warning] `OSN_PAIRWISE_SALT` may have no copy outside Cloudflare
> [`set-osn-api-secret.yml`](../../.github/workflows/set-osn-api-secret.yml) generates the salt inside its job, and Cloudflare never returns a secret's value. The salt is never rotated: a new one changes every pairwise `sub`, so every relying party sees its users as strangers ([[production-deploy]]). The inventory requires it, so osn-api cannot deploy to production through Alchemy without a copy. Whether a copy exists, and what that deploy does if none does, is settled in englishstreetventures/osn#1537 before osn-api's first Alchemy deploy.

**Dev secrets change only in the `dev` Environment.** Set or rotate one there and dispatch **Deploy**; the next deploy uploads it. A `wrangler secret put` on a dev Worker is overwritten by the next deploy. Production Workers still deploy through Wrangler, so `wrangler secret put` and [`.github/workflows/set-osn-api-secret.yml`](../../.github/workflows/set-osn-api-secret.yml) (production only) still set their live secrets. A production Worker's first Alchemy deploy uploads the GitHub Environment's value over the live one, so **a production value changed that way must be changed in the `production` Environment too**.

Set a value with no trailing newline:

```bash
printf '%s' "$VALUE" | gh secret set NAME --env <dev|production> --repo englishstreetventures/osn
```

`requireSecrets()` refuses a value with leading or trailing whitespace rather than trimming it: the run fails and names the secret, never its value. A required name that is unset, empty or only whitespace fails the same way. An optional name is left out only when it is unset or empty; one holding only whitespace, such as a pasted newline, fails as malformed, because leaving it out would delete the live secret — during a TOTP key rotation, the outgoing key.

A tier can also set a rule for a value, which `requireSecrets()` checks after the whitespace rules. Each rule is a prefix or a length, so it cannot refuse a correct value. On dev:

| Secret | Rule | Why |
|---|---|---|
| `STRIPE_SECRET_KEY` | starts `sk_test_` or `rk_test_` | A test-mode key only, so no dev deploy can move real money |
| `DEV_LOGIN_SECRET` | at least 32 characters | It alone stands between a public route and the seeded owner's session ([[dev-environment#Passkey-less sign-in on local and dev]]) |

Production sets no rule. A value that breaks one fails the run, naming the secret and its rule, never the value.

`requireSecrets()` runs in the stack body, which Alchemy evaluates for `plan` and `destroy` as well as `deploy`. Every Alchemy run for a stage therefore needs that stage's secrets, and its sites built for that stage's hosts ([[#Sites]]): a production plan job runs in the `production` Environment, and tearing down an investigation stage needs the `dev` Environment's.

### Checking the inventory

Two read-only scripts compare the inventory with what is live. Each takes `--tier`, because one credential reaches one account. Both read names only and never print a value. Any error text a tool prints passes through `redactAccountIds()`, which replaces each 32-hex-character account id before it reaches the log. The scripts are wrappers; the rules, exit codes included, are `checkLive()` and `checkGithub()` in [`shared/infra/src/secrets/check.ts`](../../shared/infra/src/secrets/check.ts), which `tests/secrets/check.test.ts` drives with stub tool runs.

The live check lists the first Worker on its own, so a `wrangler login` whose access token has expired refreshes it once, then lists the rest together. It prints in inventory order, and when Wrangler fails it names the first failing Worker in that order. The GitHub check lets `gh` fill in `{owner}/{repo}`, so run it inside the repository or with `GH_REPO` set.

| Command | Compares | Needs | Exits |
|---|---|---|---|
| `bun run --cwd shared/infra secrets:check-live -- --tier <tier>` | The inventory with `wrangler secret list` on each of the tier's live Workers | `CLOUDFLARE_ACCOUNT_ID` naming the account that serves the tier's Workers — the dev account for `dev` — which it refuses to run without and passes to Wrangler explicitly, and a `wrangler login` or `CLOUDFLARE_API_TOKEN` for that account | 0 when every Worker matches; 1 on a name that is missing, not in the inventory or forbidden; 2 on a bad argument, no account id, or a Wrangler that cannot start, exits non-zero or prints output the check cannot read |
| `bun run --cwd shared/infra secrets:check-github -- --tier <tier>` | The inventory's required names and the tier's two account credentials with the names in the tier's GitHub Environment | A `gh` login that can list Environment secrets | 0 when nothing required is missing and the Environment holds none of the other tier's credentials; 1 otherwise; 2 on a bad argument or a `gh` that cannot start or exits non-zero. A name that is neither a Worker secret nor a credential is printed but does not fail |

The production live check exited 1 with exactly one `DIFF` line, the key englishstreetventures/osn#1532 retires; any other `DIFF` line is new drift.

```
DIFF  zap-api production (zap-api-production) — forbidden but set: GROWTHBOOK_CLIENT_KEY
```

*Measured 2026-10-16 — `env CLOUDFLARE_ACCOUNT_ID=<production account id> bun run --cwd shared/infra secrets:check-live -- --tier production`*

## State store

Alchemy keeps its state in a store on each Cloudflare account, so dev and production state never mix and neither tier's token reaches the other's state. The store is the Worker `alchemy-state-store` on the account's `workers.dev` subdomain, with its bearer token `AlchemyStateStoreToken` and encryption key `AlchemyStateStoreEncryptionKey` in the account's Secrets Store. `Cloudflare.state()` takes no name: the account is whichever `CLOUDFLARE_ACCOUNT_ID` the run carries. Every stack reaches it through `stackOptions()`, and `scripts/check-alchemy-usage.ts` refuses any other state constructor in a stack file.

**State holds a copy of every deployed secret value.** Alchemy writes each `Redacted` prop's value into state, so a token that can read the store reads every secret on its account. [[access-control#Deploy credentials and secret copies]] lists who can.

The **Alchemy state store** workflow ([`.github/workflows/alchemy-state.yml`](../../.github/workflows/alchemy-state.yml)) runs by hand with two inputs, `tier` (`dev` or `production`) and `action`. Its job runs in the chosen tier's Environment, and each tier has one step that reads only that tier's two credential secrets; `shared/infra/tests/accounts.test.ts` holds both steps to `TIER_ACCOUNTS` and fails if any other part of the workflow reads a secret.

| `action` | Runs | What it does | Token needs |
|---|---|---|---|
| `check` (default) | `bun run state:check` → `alchemy state ls --backend cloudflare` | Lists the store's stack names and writes no state. Like every CI run against the store, it uploads a temporary edge-preview Worker to read the store's bearer token, so it is not read-only on Cloudflare | Workers Scripts Edit and Secrets Store Read |
| `bootstrap` | `bun run state:bootstrap` → `alchemy provider cloudflare bootstrap` | Deploys the store when absent. When it is serving, refreshes credentials and upgrades it only if its version differs from the pinned Alchemy's | Workers Scripts Edit and Secrets Store Edit |

The owner bootstraps dev's store before the first dev deploy ([[dev-environment#4. Bootstrapping the dev account]]), and production's once the production token holds Secrets Store Edit.

In CI (`CI=true`), a run against a missing or out-of-date store fails unless it passes `--yes`; `deploy --yes` deploys a missing store or upgrades an out-of-date one, which needs Secrets Store Edit. A CI run against a store at the pinned version keeps the store's URL and bearer token in memory. A run that deploys or upgrades the store writes them to `~/.alchemy/credentials/` on the runner. A run that creates the store also writes the new bearer token and encryption key in plain text to `.alchemy/state/` under its working directory (`shared/infra/.alchemy/state/` in the workflow), and deletes them once it has copied that state into the new store; a run that fails between the two leaves them there. GitHub deletes both directories with the runner.

Run logs on this repository are public, so no committed command may print state, a credential or Worker logs, and none may delete a long-lived stage. The guard allows `alchemy state ls` (or `list`) and refuses every other `state` subcommand, bare `alchemy state` (an explorer that reads records), `provider cloudflare state logs`, `provider cloudflare token` (it prints the Cloudflare API token it creates), `logs` (it prints a stage's Worker logs, which carry request paths), `nuke`, `drift … --repair` and `provider cloudflare teardown`, in package scripts, workflows and composite actions.

A committed `destroy` passes only when it names exactly one stage with a literal `--stage` (or `--stage=`) that has a stage's shape and is neither `dev` nor `production`. Without `--stage`, Alchemy takes the stage from `ALCHEMY_STAGE` in the environment, an `--env-file` or `.env`, and a variable or a workflow expression may hold a long-lived stage, so every form the guard cannot read fails.

### Replacing a state store

The bearer token cannot be rotated in place, so a leaked token, or a leaver who ran `state:check` or `state:bootstrap` on their own machine, means replacing the whole store. A token that read the store also read every secret value in its state, so replacing the store alone does not end the exposure. The owner runs these by hand on their own machine with the tier's token, never in CI; the guard refuses `teardown` in committed commands for that reason.

1. Hold every Alchemy run and release on that account, and run `bun run --cwd shared/infra token:check -- --tier <tier>` with the tier's credentials (and `DEV_DOMAIN` for dev). Go on only when it exits 0.
2. Set a new value for every Worker secret the account's stacks declare, in the tier's GitHub Environment ([[#GitHub Environment secrets]]). Never rotate `OSN_PAIRWISE_SALT` (see the warning there).
3. `DO_NOT_TRACK=1 bun alchemy provider cloudflare teardown --yes` in `shared/infra`. It deletes the store Worker, the state it holds, and its token and encryption key; it touches no stack resource.
4. Run the **Alchemy state store** workflow with `action: bootstrap`. The new store has a new token and key, and no state.
5. Plan, then deploy, each stack on the account with `--adopt`: Alchemy adopts every live resource under its existing name, writes new state rows and uploads the new secret values.
6. Delete every local copy of the old token and state: `~/.alchemy/credentials/<profile>/cloudflare-state-store.json` and any `.alchemy/state/` directory, on every machine that ran against the store.

Rehearse it on the dev account before production's store holds secrets (englishstreetventures/osn#1538).

## Production observability

`apiWorkerProps()`, and so `apiWorker()`, throws `ProductionObservabilityError` for a production stage whose input sets `redactQueryString: false` or turns native traces on. Production request paths carry ids and slugs, which no setting redacts. It is the rule `scripts/check-trace-redaction.ts` holds today's API Workers' Wrangler configs to while they still deploy.

`siteWorker()` keeps query strings redacted and native traces off on every stage. cire-invites, the guest Worker, runs production with native traces on (`cire/invites/wrangler.jsonc`), so on production it cannot be built with `apiWorker()`, which refuses native traces there. On dev the cire stack builds it with `apiWorker()` as a prebuilt Worker ([[#Bundling and the module registry]]); its production deploy moves to Alchemy's Astro path in P2 (the rollout spec), with observability settings of its own.

On dev every API Worker traces every request. osn-api, cire-api and cire-invites redact query strings: dev sign-in takes its secret in one, cire-api's OIDC callback its code, and the guest site a claim code. zap-api keeps them. Invocation logs are on for osn-api and zap-api, and off for cire-api and cire-invites, whose request paths carry wedding slugs.

## Dependency review

`alchemy` runs with each tier's deploy token, so its tree was reviewed before it was pinned. All 23 `alchemy`, `@alchemy.run/*` and `@distilled.cloud/*` versions in `bun.lock` were published by GitHub Actions with SLSA v1 provenance, from the `alchemy-run` repositories, by the same three npm maintainers (`sam-goodwin`, `pear-alchemy`, `blankparticle`). Loading `alchemy` and `alchemy/Cloudflare` pulls in seven of them: `@alchemy.run/cloudflare-runtime`, `@alchemy.run/node-utils`, `@alchemy.run/sigil` (an alpha), `@distilled.cloud/aws`, `@distilled.cloud/cloudflare`, `@distilled.cloud/core` and `@distilled.cloud/iceberg`. The rest of the tree, the other `@distilled.cloud/*` provider SDKs included, installs but does not load on that path.

*Measured 2026-10-19 — `npm view <name>@<version> _npmUser.name dist.attestations.provenance.predicateType maintainers` for each such entry in `bun.lock`, and the module cache after importing `alchemy` and `alchemy/Cloudflare` under Bun*

`alchemy` stays on an exact pin, and `shared/infra/tests/package.test.ts` fails on any other version. Repeat this review on every bump.

The CI lint, OpenAPI-freshness and E2E jobs and every product deploy job in `production-release.yml` never load the Alchemy tree, so they install with `--filter '!@*/infra'`, which leaves out `@shared/infra` and every `@<product>/infra` stack: each stack depends on `alchemy` itself, so leaving out `@shared/infra` alone installs the whole tree anyway. The jobs that build, test or type-check those packages keep the full install, and so do `deploy.yml`'s stack jobs, which run Alchemy. `alchemy-state.yml` and the D1 latency probe (`cire-d1-latency-probe.yml`) install `--filter @shared/infra` alone; the probe then runs its script with `bun --no-install`. `scripts/tests/deploy-workflows.test.ts` accepts either install form in the two deploy workflows.

A job that caches bun's store keys the cache on its install form: `<os>-bun-noinfra-<bun.lock hash>` for `--filter '!@*/infra'`, `<os>-bun-shared-infra-<bun.lock hash>` for `--filter @shared/infra`, and `<os>-bun-<bun.lock hash>` for a full install. GitHub saves a key once, from the first job that misses it, so a filtered install that saved the full install's key would leave every full install fetching the Alchemy tree. `scripts/tests/deploy-workflows.test.ts` holds every workflow's bun cache key to the install its job runs.

*Measured 2026-10-19 on Bun 1.4.2, darwin-arm64, in scratch copies of the tree with the four stacks — `bun install --frozen-lockfile --filter '!@*/infra'` leaves 962 entries in `node_modules/.bun` against 1064 for the full install and for `--filter '!@shared/infra'`, installs no `alchemy`, leaves `bun.lock` unchanged, and `bash scripts/guard-lint-warnings.sh --count` reports the same 870 warnings as on the full install*

## Testing

`@shared/infra`'s tests are two vitest projects ([`vitest.config.ts`](../../shared/infra/vitest.config.ts)). `repo` holds the five files that read outside the package (the Worker sources, `osn/api/wrangler.toml`, `bun.lock`, the root `turbo.json` and the workflows) and runs as the turbo task `test:repo`, whose inputs name those files. `package` holds the rest and runs as `test`, cached on the package's own files and run after `test:repo`. `bun run --cwd shared/infra test:run` runs both.

## Merging an infra change

`scripts/deploy-surfaces.ts` treats a change under `shared/` (except `shared/infra/`) or `patches/`, or to the root `bun.lock`, `package.json`, `turbo.json`, `tsconfig.json` or `.browserslistrc`, as shared content (`SHARED_CONTENT`). A merged change there redeploys every dev stack through `deploy.yml`, and the next production release ships every surface. `shared/infra/` is deploy tooling no surface imports: a change there runs every dev stack and offers nothing to production. So does a change under a stack's own `infra/` directory, for that stack. The version-bump commit `release.yml` pushes to `main` changes `bun.lock`, which holds each workspace's version, so it redeploys every dev stack.

## Telemetry

Every Alchemy command runs with `DO_NOT_TRACK=1`, in package scripts and in CI. [`scripts/check-alchemy-usage.ts`](../../scripts/check-alchemy-usage.ts) (`bun run check:alchemy-usage`) checks every tracked `package.json`, workflow and composite action:

- It joins backslash-continued lines, splits each command on `&&`, `||`, `;`, `|` and a background `&` (never the `&` of a redirection such as `2>&1`), and checks each part that runs Alchemy on its own.
- A package script's Alchemy command carries an inline `DO_NOT_TRACK=1`. When its leading assignments set `DO_NOT_TRACK` more than once, the last one decides.
- A workflow step's Alchemy command carries it inline, unless the step, job or workflow `env` sets `DO_NOT_TRACK: "1"`. The nearest level that sets `DO_NOT_TRACK` decides, so a step `env` that sets any other value overrides a `"1"` above it, and the command must then carry `DO_NOT_TRACK=1` inline. An inline `DO_NOT_TRACK=` on the command overrides every `env`, and must then be `1`.
- A stack file (`*/infra/*.ts` or `*alchemy.run.ts`, tests excluded) calls no state constructor (`localState`, `inMemoryState`, `postgresState`, `makeLocalState`, `makePostgresState`, `makeHttpStateStore`, `InMemoryService`), names no `alchemy/State` module in any import form, and makes no `.state(` call at all when it imports `alchemy/Cloudflare` or `alchemy/AWS` in any form; only `shared/infra/src/stack.ts` calls `Cloudflare.state()`.
- When `git ls-files` fails, or lists no root `package.json`, it exits 1 and says nothing was checked.

CI runs it against the committed tree in the "Check Alchemy usage" step of the `script-tests` job in `.github/workflows/ci.yml`. Its tests run in the same job under `bun run test:scripts`: `scripts/tests/check-alchemy-usage.test.ts` checks each rule, and `scripts/tests/check-alchemy-usage.cli.test.ts` runs the script with no usable git and with git listing nothing (exit 1 each), and in a scratch repository with a finding in a manifest, a workflow, a composite action and two stack files (exit 1, naming each).

## Releases

Production ships through `production-release.yml`, with one approval of the `production` Environment ([[production-deploy]]). When production deploys through Alchemy, each release takes two approvals: an Alchemy plan job in the `production` Environment, then the deploy (englishstreetventures/osn#1490).
