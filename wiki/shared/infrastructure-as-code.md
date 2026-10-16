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
last-reviewed: 2026-10-16
---

# Infrastructure as code (Alchemy)

## What it is

Alchemy will deploy every Cloudflare resource the monorepo runs — Workers, D1 databases, R2 buckets, routes, domains and cron schedules — from one stack per product. `@shared/infra` ([`shared/infra/`](../../shared/infra/package.json)) holds the building blocks those stacks use, and pins `alchemy` at exactly `2.0.0-beta.83`.

**Nothing deploys through it yet.** Wrangler still deploys every Worker and Pages site, as [[production-deploy]] and [[dev-environment]] describe. The rollout's design is [`docs/superpowers/specs/2026-10-16-alchemy-rollout-design.md`](../../docs/superpowers/specs/2026-10-16-alchemy-rollout-design.md), under epic englishstreetventures/osn#1490.

Alchemy runs on Effect. Root `package.json` `overrides` hold `@effect/platform-node-shared`, `@effect/sql-d1` and `@effect/sql-sqlite-do` at `4.0.3`, so the tree keeps one copy of `effect`; `shared/infra/tests/package.test.ts` fails on a second copy or on any other Alchemy version.

## Accounts

Dev and production are separate Cloudflare accounts.

- **Production** stays in the current account. Alchemy will adopt its resources in place, under their existing names, so no guest domain moves.
- **Dev** will be built fresh in a new account (englishstreetventures/osn#1538), on a dev-only domain or `workers.dev`. Until that account exists, the old dev tier's Workers run in the production account.

[`TIER_ACCOUNTS`](../../shared/infra/src/accounts.ts) names, for each tier, the GitHub Environment and the two Environment secrets that give its jobs their account. A job maps them to `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, the two variables Alchemy reads. No file holds an account id.

| Tier | Environment | Account id secret | API token secret |
|---|---|---|---|
| `dev` | `dev` | `CLOUDFLARE_DEV_ACCOUNT_ID` | `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN` |
| `production` | `production` | `CLOUDFLARE_ACCOUNT_ID` | `CLOUDFLARE_API_TOKEN` |

Dev's names are new because the `dev` Environment's `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN_DEV` reach the production account: they drive the old dev tier's Wrangler deploys, and an Alchemy run that read them would reach production. `accounts.ts` lists those two as `RETIRING_DEV_CREDENTIALS`, deleted with the old dev tier, and the repository-level `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN_READONLY` (read-only, production account) as `REPOSITORY_CREDENTIALS`.

Tests hold the names in place:

- `shared/infra/tests/accounts.test.ts` reads every `.github/workflows/*.yml`. It fails when a workflow reads a Cloudflare credential `accounts.ts` does not classify, and when any workflow but `alchemy-state.yml` reaches the dev account.
- `secrets:check-github` (below) fails when an Environment holds the other tier's credential (`forbiddenCredentials()`): `dev` must not hold `CLOUDFLARE_API_TOKEN`; `production` must not hold `CLOUDFLARE_API_TOKEN_DEV`, `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN` or `CLOUDFLARE_DEV_ACCOUNT_ID`.

Only the credentials a run carries choose the account. Neither `stackOptions()` nor `tierOf()` compares a stage with the account, so the Environment a job runs in must match its stage.

## The building blocks

Every builder takes each setting where Alchemy's default differs from today's Wrangler config as a required input, so a stack cannot inherit a default by leaving a field out. Each `*Props()` function is pure and tested; the wrapper of the same name without `Props` declares the Alchemy resource with its removal policy.

| Export | What it does | Alchemy default or behaviour it overrides |
|---|---|---|
| `apiWorker()`, `apiWorkerProps()` | An API Worker: entry, compatibility date and flags, custom domain (`null` detaches every one), crons, the stable `workers.dev` URL, vars, bindings, secrets and observability, all required. Version preview URLs off on production and on elsewhere. Invocation logs off unless the input turns them on. Zone routes stay unmanaged. Refuses a name used in two of vars, bindings and secrets, or one starting `ALCHEMY_` (`BindingNameClashError`), and on production an unredacted query string or native traces (`ProductionObservabilityError`). | `workers.dev` and version preview URLs on; invocation logs on when `observability` is omitted; five `ALCHEMY_*` plain-text bindings bound first, so a secret of the same name is silently dropped |
| `siteWorker()`, `siteWorkerProps()` | A static-assets Worker for a built site, with no `main`. Alchemy applies the directory's `_headers` and `_redirects`; HTML and not-found handling and the stable `workers.dev` URL are required. Version preview URLs off on production. Query strings redacted, native traces and invocation logs off, on every stage. | `workers.dev` and version preview URLs on; invocation logs on |
| `retainedD1()`, `retainedD1Props()` | A D1 database kept on destroy: name, read replication and jurisdiction. `migrations` only once Alchemy is the database's migrator. A location hint only on a stage that creates the database; on production it throws `AdoptedLocationHintError`. | Removal policy `destroy`; a declared `primaryLocationHint` that differs from live replaces the database |
| `retainedBucket()`, `retainedBucketProps()` | An R2 bucket kept on destroy: storage class, jurisdiction, public access, lifecycle rules, CORS and custom domains all required; `forceDestroy: false`; object locks left unmanaged. The same location-hint rule as D1. | Removal policy `destroy`; omitted lifecycle rules, CORS or custom domains are cleared; a changed location hint replaces the bucket |
| `requireSecrets()` | Reads every secret the inventory names for a Worker's tier from `env` and returns them `Redacted`; throws `MissingSecretsError` before anything uploads ([[#Secrets]]). | An upload keeps only the secrets the stack declares and drops every other secret the Worker holds |
| `stackOptions()` | The providers and state store every stack passes to `Alchemy.Stack`: `Cloudflare.providers()` and `Cloudflare.state()` ([[#State store]]). | — |
| `removalFor()`, `assertRetained()` | Storage is always retained; a Worker on `dev` or `production` is retained, because deleting it deletes its secrets; an investigation stage's Workers are destroyed with it. A stack calls `assertRetained()` on every resource a long-lived stage keeps, so a lost `retain()` fails the plan rather than a destroy. | Every resource's removal policy is `destroy` |
| `parseStage()`, `tierOf()`, `isLongLivedStage()`, `physicalName()` | The stage rules ([[#Stages]]). | Alchemy's generated `${app}-${stage}-${id}` names: a long-lived resource always passes its name |
| `TIER_ACCOUNTS`, `accountSecrets()`, `allowedCredentials()`, `forbiddenCredentials()`, `knownCredentials()` | Credential names per tier ([[#Accounts]]). | — |
| `SECRET_INVENTORY`, `tierSecrets()`, `SHARED_SECRET_VALUES`, `DEPLOY_ENVIRONMENT` | The secret inventory ([[#Secrets]]). `DEPLOY_ENVIRONMENT` lists the names a deploy job sets itself (`CI`, `DO_NOT_TRACK` and every credential), which no Worker secret may share. | — |

Storage on production is adopted, and adoption converges a resource to what is declared, so a production declaration states each setting exactly as it is live. A stage that creates storage — `dev` or an investigation stage — passes a location hint to place it where production's is; every D1 database is in `oc` ([[database-environments]]).

## Stages

`parseStage()` ([`shared/infra/src/stage.ts`](../../shared/infra/src/stage.ts)) accepts lowercase letters and digits in groups joined by single hyphens, starting with a letter, 1 to 20 characters. It refuses three names besides:

| Stage | Why it is refused |
|---|---|
| `prod` | The production D1 databases are `osn-db-prod` and `zap-db-prod`, so a stage `prod` derives a live production name |
| `staging` | `osn-db-staging` exists, and `osn/api/wrangler.toml` declares `[env.staging]` |
| `local` | It is the `OSN_ENV` posture of `wrangler dev` (`osn/api/wrangler.toml` `[vars]`) |

`dev` and `production` are the long-lived stages, and `physicalName()` gives each resource today's name on them: production by adoption, dev by creating the new account's resources under the same names. Any other stage is an investigation stage and derives `<base>-<stage>` (`cire-db-pr-7`); `physicalName()` refuses a derived name equal to a dev or production name, or longer than 63 characters, Cloudflare's limit for Worker script and R2 bucket names.

Only the stage spelled exactly `production` is the production tier (`tierOf()`). Every other stage, investigation stages included, runs on the dev tier, in the dev account, with the `dev` Environment's secrets.

## Secrets

### The inventory

[`SECRET_INVENTORY`](../../shared/infra/src/secrets/inventory.ts) lists every secret each deployed Worker holds — `osn-api`, `cire-api`, `zap-api` and `cire-invites` — with the directory whose code reads them. For each tier it gives:

| Field | Meaning |
|---|---|
| `scriptName` | The deployed script name, or `null` where the tier has no Worker (zap-api has no dev Worker) |
| `secrets` | Required names, sorted. Declared on every deploy; a missing value fails it |
| `optional` | Names declared only while their GitHub secret holds a value. Today only osn-api's `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS`, set while a TOTP key rotation drains |
| `forbidden` | Names that must never be set on that Worker on that tier |

Alchemy uploads a Worker with exactly the secrets its stack declares and drops the rest. A Worker therefore starts holding a new secret only through an inventory change in a reviewed pull request: setting a GitHub secret alone deploys nothing, and a live secret the inventory lacks is deleted by that Worker's first Alchemy deploy. `shared/infra/tests/secrets/inventory.test.ts` checks that each Worker's code reads every required and optional name declared for it.

Forbidden today: `DEV_LOGIN_SECRET` on osn-api production, `RESEND_API_URL` on osn-api and cire-api on both tiers, and `GROWTHBOOK_CLIENT_KEY` on zap-api production. No zap code reads that key; it stays live until zap-api's first Alchemy deploy deletes it (englishstreetventures/osn#1532). cire-api production keeps its own `GROWTHBOOK_CLIENT_KEY`.

### GitHub Environment secrets

Each value lives in the GitHub Environment secret **of the same name**, in the `dev` or `production` Environment. A name two Workers hold on one tier is therefore one GitHub secret, and the next Alchemy deploy gives both Workers its one value. `SHARED_SECRET_VALUES` lists each such pair on purpose, and a test fails on a shared name it does not list. Today it holds one: `INTERNAL_SERVICE_SECRET` on production, shared by osn-api and zap-api, because zap-api registers its ARC key at osn-api with it.

Production values are today's live values, which the owner holds; each one with a public or stored counterpart is shown to match live before the first Alchemy deploys of osn-api and cire-api (englishstreetventures/osn#1537). Dev values are new, made for the new dev account (englishstreetventures/osn#1538).

Until a Worker deploys through Alchemy, `wrangler secret put` and [`.github/workflows/set-osn-api-secret.yml`](../../.github/workflows/set-osn-api-secret.yml) still set its live secrets. That Worker's first Alchemy deploy uploads the GitHub Environment's value over the live one, so **a production value changed that way must be changed in the `production` Environment too**.

Set a value with no trailing newline:

```bash
printf '%s' "$VALUE" | gh secret set NAME --env <dev|production> --repo englishstreetventures/osn
```

`requireSecrets()` refuses a value with leading or trailing whitespace rather than trimming it: the run fails and names the secret, never its value. A required name that is unset or blank fails the same way; an optional one is left out.

`requireSecrets()` runs in the stack body, which Alchemy evaluates for `plan` and `destroy` as well as `deploy`. Every Alchemy run for a stage therefore needs that stage's secrets: a production plan job runs in the `production` Environment, and tearing down an investigation stage needs the `dev` Environment's.

### Checking the inventory

Two read-only scripts compare the inventory with what is live. Each takes `--tier`, because one credential reaches one account. Both read names only and never print a value. Any error text a tool prints passes through `redactAccountIds()`, which replaces each 32-hex-character account id before it reaches the log.

| Command | Compares | Needs | Exits |
|---|---|---|---|
| `bun run --cwd shared/infra secrets:check-live -- --tier <tier>` | The inventory with `wrangler secret list` on each of the tier's live Workers | `CLOUDFLARE_ACCOUNT_ID` naming the account that serves the tier's Workers — it refuses to run without one and passes it to Wrangler explicitly — and a `wrangler login` or `CLOUDFLARE_API_TOKEN` | 0 when every Worker matches; 1 on a missing, unlisted or forbidden name; 2 on a bad argument, no account id, or a Wrangler that cannot start, exits non-zero or prints output the check cannot read |
| `bun run --cwd shared/infra secrets:check-github -- --tier <tier>` | The inventory's required names and the tier's two account credentials with the names in the tier's GitHub Environment | A `gh` login that can list Environment secrets | 0 when nothing required is missing and the Environment holds none of the other tier's credentials; 1 otherwise; 2 on a bad argument or a `gh` that cannot start or exits non-zero. A name that is neither a Worker secret nor a credential is printed but does not fail |

Today the production live check exits 1 with exactly one `DIFF` line, the key englishstreetventures/osn#1532 retires; any other `DIFF` line is new drift. The dev live check, run against the old dev Workers in the production account, exits 0. Both GitHub checks exit 1: each Environment holds one Worker secret so far, and `dev` lacks the dev account's credentials.

```
DIFF  zap-api production (zap-api-production) — forbidden but set: GROWTHBOOK_CLIENT_KEY
```

*Measured 2026-10-16 — `CLOUDFLARE_ACCOUNT_ID=<production account id> bun run --cwd shared/infra secrets:check-live -- --tier production` (and `--tier dev`); `bun run --cwd shared/infra secrets:check-github -- --tier dev` (18 missing) and `--tier production` (14 missing)*

## State store

Alchemy keeps its state in a store on each Cloudflare account, so dev and production state never mix and neither tier's token reaches the other's state. The store is the Worker `alchemy-state-store` on the account's `workers.dev` subdomain, with its bearer token `AlchemyStateStoreToken` and encryption key `AlchemyStateStoreEncryptionKey` in the account's Secrets Store. `Cloudflare.state()` takes no name: the account is whichever `CLOUDFLARE_ACCOUNT_ID` the run carries. Every stack reaches it through `stackOptions()`, and `scripts/check-alchemy-usage.ts` refuses any other state constructor in a stack file.

**State holds a copy of every deployed secret value.** Alchemy writes each `Redacted` prop's value into state, so a token that can read the store reads every secret on its account. [[access-control#Deploy credentials and secret copies]] lists who can.

The **Alchemy state store** workflow ([`.github/workflows/alchemy-state.yml`](../../.github/workflows/alchemy-state.yml)) runs by hand with two inputs, `tier` (`dev` or `production`) and `action`. Its job runs in the chosen tier's Environment, and each tier has one step that reads only that tier's two credential secrets; `shared/infra/tests/accounts.test.ts` holds both steps to `TIER_ACCOUNTS` and fails if any other part of the workflow reads a secret.

| `action` | Runs | What it does | Token needs |
|---|---|---|---|
| `check` (default) | `bun run state:check` → `alchemy state ls --backend cloudflare` | Lists the store's stack names and writes no state. Like every CI run against the store, it uploads a temporary edge-preview Worker to read the store's bearer token, so it is not read-only on Cloudflare | Workers Scripts Edit and Secrets Store Read |
| `bootstrap` | `bun run state:bootstrap` → `alchemy provider cloudflare bootstrap` | Deploys the store when absent. When it is serving, refreshes credentials and upgrades it only if its version differs from the pinned Alchemy's | Workers Scripts Edit and Secrets Store Edit |

Neither store exists yet. The owner bootstraps production's once the production token holds Secrets Store Edit, and dev's once englishstreetventures/osn#1538 has created the dev account and its token.

In CI (`CI=true`), a run against a missing or out-of-date store fails unless it passes `--yes`; `deploy --yes` deploys a missing store or upgrades an out-of-date one, which needs Secrets Store Edit. A CI run against a store at the pinned version keeps the store's URL and bearer token in memory. A run that deploys or upgrades the store writes them to `~/.alchemy/credentials/` on the runner, which GitHub deletes with the runner.

No committed command prints state, because run logs on this repository are public. The guard allows `alchemy state ls` (or `list`) and refuses every other `state` subcommand, bare `alchemy state` (an explorer that reads records), `provider cloudflare state logs`, `nuke`, `drift … --repair` and `provider cloudflare teardown`, in package scripts, workflows and composite actions.

## Production observability

`apiWorkerProps()`, and so `apiWorker()`, throws `ProductionObservabilityError` for a production stage whose input sets `redactQueryString: false` or turns native traces on. Production request paths carry ids and slugs, which no setting redacts. It is the rule `scripts/check-trace-redaction.ts` holds today's API Workers' Wrangler configs to while they still deploy.

`siteWorker()` keeps query strings redacted and native traces off on every stage. cire-invites, the guest Worker, runs production with native traces on (`cire/invites/wrangler.jsonc`) and is not built with `apiWorker()`.

## Merging an infra change

`scripts/deploy-surfaces.ts` treats a change under `shared/` or `patches/`, or to the root `bun.lock`, `package.json`, `turbo.json`, `tsconfig.json` or `.browserslistrc`, as shared content (`SHARED_CONTENT`). A merged change there redeploys every dev surface through `deploy.yml`, and the next production release ships every surface. A change to `@shared/infra` deploys nothing through Alchemy, but it still redeploys everything through Wrangler; so does the version-bump commit `release.yml` pushes to `main` after it.

## Telemetry

Every Alchemy command runs with `DO_NOT_TRACK=1`, in package scripts and in CI. [`scripts/check-alchemy-usage.ts`](../../scripts/check-alchemy-usage.ts) (`bun run check:alchemy-usage`) checks every tracked `package.json`, workflow and composite action:

- It joins backslash-continued lines, splits each command on `&&`, `||`, `;` and `|`, and checks each part that runs Alchemy on its own.
- A package script's Alchemy command carries an inline `DO_NOT_TRACK=1`.
- A workflow step's Alchemy command carries it inline, unless the step, job or workflow `env` sets `DO_NOT_TRACK: "1"`. The nearest level that sets `DO_NOT_TRACK` decides, so a step `env` that sets any other value overrides a `"1"` above it, and the command must then carry `DO_NOT_TRACK=1` inline.
- A stack file (`*/infra/*.ts` or `*alchemy.run.ts`, tests excluded) calls no state constructor; only `shared/infra/src/stack.ts` calls `Cloudflare.state()`.
- It fails closed: when `git ls-files` fails, it exits 1 and says nothing was checked.

CI runs it against the committed tree in the `script-tests` job of `.github/workflows/ci.yml`; its tests, `scripts/tests/check-alchemy-usage.test.ts`, run in the same job under `bun run test:scripts`.

## Stack layout and releases

Each product will get one stack, `<product>/infra/alchemy.run.ts`, in a workspace named `@<product>/infra`. None exists yet.

| Directory | Stack name | Declares |
|---|---|---|
| `cire/infra` (`@cire/infra`, version-less like every `@cire/*`) | `cire` | cire-api with its D1 database and R2 buckets, cire-invites, cire host, cire vendor, cire landing |
| `zap/infra` | `zap` | zap-api and its D1 database |
| `musubi/infra` | `musubi` | Our identity instance: osn-api with its D1 database, musubi social, musubi landing |
| `pulse/infra` | `pulse` | Pulse landing |

The stack name equals the directory name. It keys Alchemy's state rows and becomes the `ALCHEMY_STACK_NAME` binding on every Worker, so it never changes after a stack's first deploy. `osn/` stays headless: the hosted instance's configuration is Musubi's ([[osn-and-musubi]]), and a stack template for independent OSN instances, `osn/infra`, is englishstreetventures/osn#1539. `pulse/api` has no deploy job and no stack.

Production ships today through `production-release.yml`, with one approval of the `production` Environment ([[production-deploy]]). When production deploys through Alchemy, each release takes two approvals: an Alchemy plan job in the `production` Environment, then the deploy (englishstreetventures/osn#1490).
