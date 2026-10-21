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
last-reviewed: 2026-10-21
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

Two checks enforce these names:

- `shared/infra/tests/accounts.test.ts` reads every `.github/workflows/*.yml`. It fails when a workflow reads a Cloudflare credential `accounts.ts` does not classify, and when any workflow but `alchemy-state.yml` reaches the dev account.
- `secrets:check-github` (below) fails when an Environment holds the other tier's credential (`forbiddenCredentials()`): `dev` must not hold `CLOUDFLARE_API_TOKEN`; `production` must not hold `CLOUDFLARE_API_TOKEN_DEV`, `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN` or `CLOUDFLARE_DEV_ACCOUNT_ID`.

Only the credentials a run carries choose the account. Neither `stackOptions()` nor `tierOf()` compares a stage with the account, so the Environment a job runs in must match its stage.

A token can reach more than one account: one created with "All accounts" by a member of both reaches production from the `dev` Environment, which has no reviewer. So before Alchemy runs, `bun run --cwd shared/infra token:check` ([`scripts/check-token-reach.ts`](../../shared/infra/scripts/check-token-reach.ts)) lists the accounts `CLOUDFLARE_API_TOKEN` reaches (`GET /accounts`) and stops the run unless it is exactly the one `CLOUDFLARE_ACCOUNT_ID` names: exit 1 when it reaches another account or none, 2 when it cannot list them. It prints no account id. A job that runs Alchemy runs it first; today those are the two tier steps of `alchemy-state.yml`.

## The building blocks

Every builder takes each setting where Alchemy's default differs from today's Wrangler config as a required input, so a stack cannot inherit a default by leaving a field out. Each `*Props()` function is pure and tested; the wrapper of the same name without `Props` declares the Alchemy resource with its removal policy.

| Export | What it does | Alchemy default or behaviour it overrides |
|---|---|---|
| `apiWorker()`, `apiWorkerProps()` | An API Worker. Every setting is required: the Worker's inventory key (`worker`), entry, compatibility date and flags, custom domain, crons, the stable `workers.dev` URL, version preview URLs, vars, bindings, secrets and observability, Workers Issues included. A `null` domain detaches every custom domain. Production refuses preview URLs. No var or binding may take a name the secret inventory lists for the Worker. Invocation logs are off unless the input turns them on. Zone routes stay unmanaged. Its refusals are in [[#Errors]]. | An upload keeps only the secrets it declares and deletes the rest, so a stack that passed `{}` or a subset would delete live secrets; `workers.dev` and version preview URLs on; invocation logs on when `observability` is omitted; Workers Issues turned off on the next full deploy when `observability.issues` is omitted; five `ALCHEMY_*` plain-text bindings bound first, so a secret of the same name is silently dropped |
| `siteWorker()`, `siteWorkerProps()` | A static-assets Worker for a built site, with no `main`. Alchemy applies the directory's `_headers` and `_redirects`; HTML and not-found handling, the stable `workers.dev` URL, version preview URLs and Workers Issues are required; production refuses preview URLs. Query strings redacted, native traces and invocation logs off, on every stage. | `workers.dev` and version preview URLs on; invocation logs on; Workers Issues turned off on the next full deploy when `observability.issues` is omitted |
| `retainedD1()`, `retainedD1Props()` | A D1 database kept on destroy: name, read replication and jurisdiction. `migrations` only once Alchemy is the database's migrator. A location hint only on a stage that creates the database. | Removal policy `destroy`; a declared `primaryLocationHint` that differs from live replaces the database |
| `retainedBucket()`, `retainedBucketProps()` | An R2 bucket kept on destroy: storage class, jurisdiction, public access, lifecycle rules, CORS and custom domains all required; `forceDestroy: false`; object locks left unmanaged. The same location-hint rule as D1. | Removal policy `destroy`; omitted lifecycle rules, CORS or custom domains are cleared; a changed location hint replaces the bucket |
| `requireSecrets()` | Reads every secret the inventory names for a Worker's tier from `env` and returns them `Redacted`, and refuses before anything uploads ([[#Secrets]]). | An upload keeps only the secrets the stack declares and drops every other secret the Worker holds |
| `stackOptions()` | The providers and state store every stack passes to `Alchemy.Stack`: `Cloudflare.providers()` and `Cloudflare.state()` ([[#State store]]). | — |
| `removalFor()`, `assertRetained()` | Storage is always retained; a Worker on `dev` or `production` is retained, because deleting it deletes its secrets; an investigation stage's Workers are destroyed with it. A stack calls `assertRetained()` on every resource a long-lived stage keeps, so a lost `retain()` fails the plan rather than a destroy. | Workers, D1 databases and R2 buckets default to removal policy `destroy` |
| `parseStage()`, `tierOf()`, `isLongLivedStage()`, `physicalName()` | The stage rules ([[#Stages]]). | Alchemy's generated `${app}-${stage}-${id}` names: a long-lived resource always passes its name |
| `TIER_ACCOUNTS`, `accountSecrets()`, `allowedCredentials()`, `forbiddenCredentials()`, `knownCredentials()` | Credential names per tier ([[#Accounts]]). | — |
| `SECRET_INVENTORY`, `tierSecrets()`, `SHARED_SECRET_VALUES`, `DEPLOY_ENVIRONMENT` | The secret inventory ([[#Secrets]]). `DEPLOY_ENVIRONMENT` lists the names a deploy job sets itself (`CI`, `DO_NOT_TRACK` and every credential), which no Worker secret may share. | — |

`shared/infra/tests/declare.test.ts` registers each wrapper on a bare stack, with no provider or credentials, and checks the removal policy Alchemy records for it on `dev`, `production` and an investigation stage.

### Errors

Each refusal is a `Data.TaggedError`. Every one names secret names, never values.

| Error | Thrown by | When |
|---|---|---|
| `UndeclaredSecretsError` | `apiWorkerProps()` | `secrets` leaves out a name the inventory requires of that Worker on the stage's tier, or passes a name the inventory does not declare there |
| `BindingNameClashError` | `apiWorkerProps()` | One name appears in two of vars, bindings and secrets, or starts with `ALCHEMY_` |
| `SecretAsPlainBindingError` | `apiWorkerProps()` | A var or binding takes a name the inventory lists for that Worker on either tier (required, optional or forbidden). A var reaches the Worker as plain text that `wrangler secret list` never shows |
| `ProductionPreviewUrlsError` | `apiWorkerProps()`, `siteWorkerProps()` | `previewUrls` is true on production. Each version's preview URL is a public `workers.dev` host outside any Access gate |
| `ProductionObservabilityError` | `apiWorkerProps()` | On production, query strings are not redacted or native traces are on ([[#Production observability]]) |
| `AdoptedLocationHintError` | `retainedD1Props()`, `retainedBucketProps()` | A location hint is declared on production, where the storage is adopted |
| `MissingSecretsError` | `requireSecrets()` | A required secret is unset, empty or only whitespace, or any value has leading or trailing whitespace |
| `NoWorkerOnTierError` | `tierSecrets()` | The Worker has no deployed script on that tier (zap-api on dev) |
| `UnretainedResourceError` | `assertRetained()` | A resource a long-lived stage keeps would be deleted on destroy or replacement |
| `InvalidStageError` | `parseStage()` and everything that calls it | The stage breaks the rules in [[#Stages]] |

Storage on production is adopted, and an adopted resource is changed to match its declaration, so a production declaration states each setting exactly as it is live. A stage that creates storage — `dev` or an investigation stage — passes a location hint to place it where production's is; every D1 database is in `oc` ([[database-environments]]).

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

Alchemy uploads a Worker with exactly the secrets its stack declares and drops the rest. A Worker therefore starts holding a new secret only through an inventory change in a reviewed pull request: setting a GitHub secret alone deploys nothing, and a live secret the inventory lacks is deleted by that Worker's first Alchemy deploy. `shared/infra/tests/secrets/inventory.test.ts` checks that each Worker's code reads every required and optional name declared for it. It also reads its expectations from the files that set them: osn-api requires every secret `osn/api/wrangler.toml` marks `REQUIRED non-local` and every name the production preflight requires, and production forbids every name a production preflight in `production-release.yml` refuses.

Forbidden today: `DEV_LOGIN_SECRET` on osn-api production, `RESEND_API_URL` on osn-api and cire-api on both tiers, and `GROWTHBOOK_CLIENT_KEY` on zap-api production. No zap code reads that key; it stays live until zap-api's first Alchemy deploy deletes it (englishstreetventures/osn#1532). cire-api production keeps its own `GROWTHBOOK_CLIENT_KEY`.

### GitHub Environment secrets

Each value lives in the GitHub Environment secret **of the same name**, in the `dev` or `production` Environment. A name two Workers hold on one tier is therefore one GitHub secret, and the next Alchemy deploy gives both Workers its one value. `SHARED_SECRET_VALUES` lists each such pair on purpose, and a test fails on a shared name it does not list. Today it holds one: `INTERNAL_SERVICE_SECRET` on production, shared by osn-api and zap-api, because zap-api registers its ARC key at osn-api with it.

Production values are today's live values. Each one with a public or stored counterpart is shown to match live before P1 starts (englishstreetventures/osn#1537); P1 builds dev in the new account. Dev values are new, made for the new dev account (englishstreetventures/osn#1538).

> [!warning] `OSN_PAIRWISE_SALT` may have no copy outside Cloudflare
> [`set-osn-api-secret.yml`](../../.github/workflows/set-osn-api-secret.yml) generates the salt inside its job, and Cloudflare never returns a secret's value. The salt is never rotated: a new one changes every pairwise `sub`, so every relying party sees its users as strangers ([[production-deploy]]). The inventory requires it, so osn-api cannot deploy to production through Alchemy without a copy. Whether a copy exists, and what that deploy does if none does, is settled in englishstreetventures/osn#1537 before osn-api's first Alchemy deploy.

Until a Worker deploys through Alchemy, `wrangler secret put` and [`.github/workflows/set-osn-api-secret.yml`](../../.github/workflows/set-osn-api-secret.yml) still set its live secrets. That Worker's first Alchemy deploy uploads the GitHub Environment's value over the live one, so **a production value changed that way must be changed in the `production` Environment too**.

Set a value with no trailing newline:

```bash
printf '%s' "$VALUE" | gh secret set NAME --env <dev|production> --repo englishstreetventures/osn
```

`requireSecrets()` refuses a value with leading or trailing whitespace rather than trimming it: the run fails and names the secret, never its value. A required name that is unset, empty or only whitespace fails the same way. An optional name is left out only when it is unset or empty; one holding only whitespace, such as a pasted newline, fails as malformed, because leaving it out would delete the live secret — during a TOTP key rotation, the outgoing key.

`requireSecrets()` runs in the stack body, which Alchemy evaluates for `plan` and `destroy` as well as `deploy`. Every Alchemy run for a stage therefore needs that stage's secrets: a production plan job runs in the `production` Environment, and tearing down an investigation stage needs the `dev` Environment's.

### Checking the inventory

Two read-only scripts compare the inventory with what is live. Each takes `--tier`, because one credential reaches one account. Both read names only and never print a value. Any error text a tool prints passes through `redactAccountIds()`, which replaces each 32-hex-character account id before it reaches the log. The scripts are wrappers; the rules, exit codes included, are `checkLive()` and `checkGithub()` in [`shared/infra/src/secrets/check.ts`](../../shared/infra/src/secrets/check.ts), which `tests/secrets/check.test.ts` drives with stub tool runs.

The live check lists the first Worker on its own, so a `wrangler login` whose access token has expired refreshes it once, then lists the rest together. It prints in inventory order, and when Wrangler fails it names the first failing Worker in that order. The GitHub check lets `gh` fill in `{owner}/{repo}`, so run it inside the repository or with `GH_REPO` set.

| Command | Compares | Needs | Exits |
|---|---|---|---|
| `bun run --cwd shared/infra secrets:check-live -- --tier <tier>` | The inventory with `wrangler secret list` on each of the tier's live Workers | `CLOUDFLARE_ACCOUNT_ID` naming the account that serves the tier's Workers — it refuses to run without one and passes it to Wrangler explicitly — and a `wrangler login` or `CLOUDFLARE_API_TOKEN` | 0 when every Worker matches; 1 on a name that is missing, not in the inventory or forbidden; 2 on a bad argument, no account id, or a Wrangler that cannot start, exits non-zero or prints output the check cannot read |
| `bun run --cwd shared/infra secrets:check-github -- --tier <tier>` | The inventory's required names and the tier's two account credentials with the names in the tier's GitHub Environment | A `gh` login that can list Environment secrets | 0 when nothing required is missing and the Environment holds none of the other tier's credentials; 1 otherwise; 2 on a bad argument or a `gh` that cannot start or exits non-zero. A name that is neither a Worker secret nor a credential is printed but does not fail |

Today the production live check exits 1 with exactly one `DIFF` line, the key englishstreetventures/osn#1532 retires; any other `DIFF` line is new drift. The dev live check, run against the old dev Workers in the production account, exits 0. Both GitHub checks exit 1: each Environment holds one Worker secret so far, and `dev` lacks the dev account's credentials.

```
DIFF  zap-api production (zap-api-production) — forbidden but set: GROWTHBOOK_CLIENT_KEY
```

*Measured 2026-10-16 — `env CLOUDFLARE_ACCOUNT_ID=<production account id> bun run --cwd shared/infra secrets:check-live -- --tier production` (and `--tier dev`); 2026-10-19 — `bun run --cwd shared/infra secrets:check-github -- --tier dev` (18 missing; it also prints `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` as not in the inventory, which does not fail it) and `--tier production` (14 missing)*

## State store

Alchemy keeps its state in a store on each Cloudflare account, so dev and production state never mix and neither tier's token reaches the other's state. The store is the Worker `alchemy-state-store` on the account's `workers.dev` subdomain, with its bearer token `AlchemyStateStoreToken` and encryption key `AlchemyStateStoreEncryptionKey` in the account's Secrets Store. `Cloudflare.state()` takes no name: the account is whichever `CLOUDFLARE_ACCOUNT_ID` the run carries. Every stack reaches it through `stackOptions()`, and `scripts/check-alchemy-usage.ts` refuses any other state constructor in a stack file.

**State holds a copy of every deployed secret value.** Alchemy writes each `Redacted` prop's value into state, so a token that can read the store reads every secret on its account. [[access-control#Deploy credentials and secret copies]] lists who can.

The **Alchemy state store** workflow ([`.github/workflows/alchemy-state.yml`](../../.github/workflows/alchemy-state.yml)) runs by hand with two inputs, `tier` (`dev` or `production`) and `action`. Its job runs in the chosen tier's Environment, and each tier has one step that reads only that tier's two credential secrets; `shared/infra/tests/accounts.test.ts` holds both steps to `TIER_ACCOUNTS` and fails if any other part of the workflow reads a secret.

| `action` | Runs | What it does | Token needs |
|---|---|---|---|
| `check` (default) | `bun run state:check` → `alchemy state ls --backend cloudflare` | Lists the store's stack names and writes no state. Like every CI run against the store, it uploads a temporary edge-preview Worker to read the store's bearer token, so it is not read-only on Cloudflare | Workers Scripts Edit and Secrets Store Read |
| `bootstrap` | `bun run state:bootstrap` → `alchemy provider cloudflare bootstrap` | Deploys the store when absent. When it is serving, refreshes credentials and upgrades it only if its version differs from the pinned Alchemy's | Workers Scripts Edit and Secrets Store Edit |

Neither store exists yet. The owner bootstraps production's once the production token holds Secrets Store Edit, and dev's once englishstreetventures/osn#1538 has created the dev account and its token.

In CI (`CI=true`), a run against a missing or out-of-date store fails unless it passes `--yes`; `deploy --yes` deploys a missing store or upgrades an out-of-date one, which needs Secrets Store Edit. A CI run against a store at the pinned version keeps the store's URL and bearer token in memory. A run that deploys or upgrades the store writes them to `~/.alchemy/credentials/` on the runner. A run that creates the store also writes the new bearer token and encryption key in plain text to `.alchemy/state/` under its working directory (`shared/infra/.alchemy/state/` in the workflow), and deletes them once it has copied that state into the new store; a run that fails between the two leaves them there. GitHub deletes both directories with the runner.

Run logs on this repository are public, so no committed command may print state, a credential or Worker logs, and none may delete a long-lived stage. The guard allows `alchemy state ls` (or `list`) and refuses every other `state` subcommand, bare `alchemy state` (an explorer that reads records), `provider cloudflare state logs`, `provider cloudflare token` (it prints the Cloudflare API token it creates), `logs` (it prints a stage's Worker logs, which carry request paths), `nuke`, `drift … --repair` and `provider cloudflare teardown`, in package scripts, workflows and composite actions.

A committed `destroy` passes only when it names exactly one stage with a literal `--stage` (or `--stage=`) that has a stage's shape and is neither `dev` nor `production`. Without `--stage`, Alchemy takes the stage from `ALCHEMY_STAGE` in the environment, an `--env-file` or `.env`, and a variable or a workflow expression may hold a long-lived stage, so every form the guard cannot read fails.

### Replacing a state store

The bearer token cannot be rotated in place, so a leaked token, or a leaver who ran `state:check` or `state:bootstrap` on their own machine, means replacing the whole store. A token that read the store also read every secret value in its state, so replacing the store alone does not end the exposure. The owner runs these by hand on their own machine with the tier's token, never in CI; the guard refuses `teardown` in committed commands for that reason.

1. Hold every Alchemy run and release on that account.
2. Set a new value for every Worker secret the account's stacks declare, in the tier's GitHub Environment ([[#GitHub Environment secrets]]). Never rotate `OSN_PAIRWISE_SALT` (see the warning there).
3. `DO_NOT_TRACK=1 bun alchemy provider cloudflare teardown --yes` in `shared/infra`. It deletes the store Worker, the state it holds, and its token and encryption key; it touches no stack resource.
4. Run the **Alchemy state store** workflow with `action: bootstrap`. The new store has a new token and key, and no state.
5. Plan, then deploy, each stack on the account with `--adopt`: Alchemy adopts every live resource under its existing name, writes new state rows and uploads the new secret values.
6. Delete every local copy of the old token and state: `~/.alchemy/credentials/<profile>/cloudflare-state-store.json` and any `.alchemy/state/` directory, on every machine that ran against the store.

Rehearse it on the dev account before production's store holds secrets (englishstreetventures/osn#1538).

## Production observability

`apiWorkerProps()`, and so `apiWorker()`, throws `ProductionObservabilityError` for a production stage whose input sets `redactQueryString: false` or turns native traces on. Production request paths carry ids and slugs, which no setting redacts. It is the rule `scripts/check-trace-redaction.ts` holds today's API Workers' Wrangler configs to while they still deploy.

`siteWorker()` keeps query strings redacted and native traces off on every stage. cire-invites, the guest Worker, runs production with native traces on (`cire/invites/wrangler.jsonc`), so it cannot be built with `apiWorker()`, which refuses native traces on production, nor with `siteWorker()`, which takes no `main`. It deploys through Alchemy's Astro path in P2 (the rollout spec), with observability settings of its own.

## Dependency review

`alchemy` runs with each tier's deploy token, so its tree was reviewed before it was pinned. All 23 `alchemy`, `@alchemy.run/*` and `@distilled.cloud/*` versions in `bun.lock` were published by GitHub Actions with SLSA v1 provenance, from the `alchemy-run` repositories, by the same three npm maintainers (`sam-goodwin`, `pear-alchemy`, `blankparticle`). Loading `alchemy` and `alchemy/Cloudflare` pulls in seven of them: `@alchemy.run/cloudflare-runtime`, `@alchemy.run/node-utils`, `@alchemy.run/sigil` (an alpha), `@distilled.cloud/aws`, `@distilled.cloud/cloudflare`, `@distilled.cloud/core` and `@distilled.cloud/iceberg`. The rest of the tree, the other `@distilled.cloud/*` provider SDKs included, installs but does not load on that path.

*Measured 2026-10-19 — `npm view <name>@<version> _npmUser.name dist.attestations.provenance.predicateType maintainers` for each such entry in `bun.lock`, and the module cache after importing `alchemy` and `alchemy/Cloudflare` under Bun*

`alchemy` stays on an exact pin, and `shared/infra/tests/package.test.ts` fails on any other version. Repeat this review on every bump.

The CI lint, OpenAPI-freshness, E2E and migration-workflow jobs and every product deploy job in `deploy.yml` and `production-release.yml` never load `@shared/infra`, so they install with `--filter '!@shared/infra'`: the full tree minus about 100 Alchemy-only packages. The jobs that build, test or type-check it keep the full install, and `alchemy-state.yml` installs `--filter @shared/infra` alone. `scripts/tests/deploy-workflows.test.ts` accepts either install form in the two deploy workflows.

*Measured 2026-10-19 on Bun 1.4.2, darwin-arm64, in a scratch copy of the tree — the filtered install equals the full one minus 102 packages, leaves `bun.lock` unchanged, and `bun run lint` reports the same 878 warnings*

## Testing

`@shared/infra`'s tests are two vitest projects ([`vitest.config.ts`](../../shared/infra/vitest.config.ts)). `repo` holds the three files that read outside the package (the Worker sources, `osn/api/wrangler.toml`, `bun.lock` and the workflows) and runs as the turbo task `test:repo`, whose inputs name those files. `package` holds the rest and runs as `test`, cached on the package's own files and run after `test:repo`. `bun run --cwd shared/infra test:run` runs both.

## Merging an infra change

`scripts/deploy-surfaces.ts` treats a change under `shared/` or `patches/`, or to the root `bun.lock`, `package.json`, `turbo.json`, `tsconfig.json` or `.browserslistrc`, as shared content (`SHARED_CONTENT`). A merged change there redeploys every dev surface through `deploy.yml`, and the next production release ships every surface. A change to `@shared/infra` deploys nothing through Alchemy, but it still redeploys everything through Wrangler; so does the version-bump commit `release.yml` pushes to `main` after it.

## Telemetry

Every Alchemy command runs with `DO_NOT_TRACK=1`, in package scripts and in CI. [`scripts/check-alchemy-usage.ts`](../../scripts/check-alchemy-usage.ts) (`bun run check:alchemy-usage`) checks every tracked `package.json`, workflow and composite action:

- It joins backslash-continued lines, splits each command on `&&`, `||`, `;`, `|` and a background `&` (never the `&` of a redirection such as `2>&1`), and checks each part that runs Alchemy on its own.
- A package script's Alchemy command carries an inline `DO_NOT_TRACK=1`. When its leading assignments set `DO_NOT_TRACK` more than once, the last one decides.
- A workflow step's Alchemy command carries it inline, unless the step, job or workflow `env` sets `DO_NOT_TRACK: "1"`. The nearest level that sets `DO_NOT_TRACK` decides, so a step `env` that sets any other value overrides a `"1"` above it, and the command must then carry `DO_NOT_TRACK=1` inline. An inline `DO_NOT_TRACK=` on the command overrides every `env`, and must then be `1`.
- A stack file (`*/infra/*.ts` or `*alchemy.run.ts`, tests excluded) calls no state constructor (`localState`, `inMemoryState`, `postgresState`, `makeLocalState`, `makePostgresState`, `makeHttpStateStore`, `InMemoryService`), names no `alchemy/State` module in any import form, and makes no `.state(` call at all when it imports `alchemy/Cloudflare` or `alchemy/AWS` in any form; only `shared/infra/src/stack.ts` calls `Cloudflare.state()`.
- When `git ls-files` fails, or lists no root `package.json`, it exits 1 and says nothing was checked.

CI runs it against the committed tree in the "Check Alchemy usage" step of the `script-tests` job in `.github/workflows/ci.yml`. Its tests run in the same job under `bun run test:scripts`: `scripts/tests/check-alchemy-usage.test.ts` checks each rule, and `scripts/tests/check-alchemy-usage.cli.test.ts` runs the script with no usable git and with git listing nothing (exit 1 each), and in a scratch repository with a finding in a manifest, a workflow, a composite action and two stack files (exit 1, naming each).

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
