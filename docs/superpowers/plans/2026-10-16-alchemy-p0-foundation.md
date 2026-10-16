# Alchemy rollout P0 — foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@shared/infra` (the pinned Alchemy version and the building blocks every product stack uses), a committed secret inventory that equals every live Worker's secret names, the names of the GitHub Environment secrets that hold each tier's Cloudflare account and token, a deliberate way to bootstrap and check each account's Alchemy state store, and a repository guard that keeps Alchemy telemetry off — without deploying any resource through Alchemy, and without needing the new dev account or the dev domain, which do not exist yet.

**Architecture:** A new versioned workspace `shared/infra` holds pure functions that turn typed inputs into Alchemy resource props (tested without Alchemy at runtime), thin wrappers that hand those props to Alchemy with the right removal policy, the secret inventory as a typed TypeScript module that a test, `requireSecrets()` and two read-only check scripts all read, and `TIER_ACCOUNTS`, which names each tier's credential secrets so no code names an account. A `workflow_dispatch` workflow bootstraps or checks one tier's state store with that tier's credentials, in that tier's account. A guard under `scripts/` checks every package script and workflow that runs the Alchemy CLI.

**Tech Stack:** Bun 1.4.2, TypeScript 6, Effect 4.0.3 (`Data`, `Redacted`), Alchemy `2.0.0-beta.83` (`alchemy/Cloudflare`), Vitest 5.0.3 under `bunx --bun`, `bun:test` for `scripts/`, GitHub Actions, Wrangler 4.149.0 (read-only `secret list`), `gh`.

**Spec:** `docs/superpowers/specs/2026-10-16-alchemy-rollout-design.md` (owner-approved; owner answers applied 2026-10-16, https://github.com/englishstreetventures/osn/issues/1533#issuecomment-6206254623). Scope: the spec's **P0 — foundation** only.

**Issue:** englishstreetventures/osn#1533, a sub-issue of englishstreetventures/osn#1490.

**Branch:** `feat/alchemy-foundation` in `/Users/ac/.work/osn.git/alchemy-foundation`, rebased on 2026-10-16 onto `origin/main` `2d428e2bc` (#1524, the production release workflow). Not on the remote. The P0 pull request targets `main` and carries the spec and plan commits with it.

---

## Global Constraints

Copied verbatim from the spec. Every task's requirements include this section.

### Decisions (owner, 2026-10-16)

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

### Constraints

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

### Repository rules that bind this plan (`AGENTS.md`)

- Tests in `tests/` at the package root; no test helpers in `src/`. `scripts/` tests live in `scripts/tests/` and run under `bun test ./scripts/`.
- No `console.*` in new code: write with `process.stdout.write` / `process.stderr.write`. `oxlint` warns on `no-console` (`oxlintrc.json:23`) and `scripts/guard-lint-warnings.sh` fails a branch that raises the warning count.
- Source (not tests) must pass the `anti-slop/*` rules at error level (`oxlintrc.json:86-114`; tests are exempt at `oxlintrc.json:413-448`), and the pre-commit hook lints staged files (`lefthook.yml:18`). The ones this plan's code is written around: no `Record<…, unknown | any | object>` (`no-unsafe-dictionary-type`), no `...(cond ? {} : {…})` (`no-conditional-empty-object-spread`), no returning an object literal accumulator widened to a `Record` (`no-known-value-widening`), no `unknown` return types, no symbol containing "shape". Every task that adds source runs `bunx --bun oxlint -c oxlintrc.json <its files>` before committing; fix a hit within the rule's intent, never by disabling the rule.
- Never a bare `bun install`. Add dependencies with `bun add --exact --cwd shared/infra …`; check with `bun install --frozen-lockfile`.
- Comments state what the code guarantees now; a deferral carries only an issue link.
- Never commit to `main`. Never push or open the pull request from this plan's executor without the owner's go-ahead.
- Never run an Alchemy command that writes to Cloudflare (no `deploy`, no `provider cloudflare bootstrap`). P0 deploys nothing through Alchemy and declares no product resource. Its Cloudflare writes are the owner's (token permissions) and the state-store bootstraps the owner runs after merge. Merging it does redeploy every dev surface through `deploy.yml`, and the next production release ships every surface, because it changes `shared/`, `bun.lock` and `package.json`, which every surface builds from (`scripts/deploy-surfaces.ts:126-128` `SHARED_CONTENT`, read by `deploy.yml`'s `changes` job and by `scripts/release-plan.ts`); the changesets "version packages" commit does the same on dev.

## Review Focus

The six inputs or failure modes the spec implies but no task would otherwise exercise, most likely first. Each has a test in the task named.

1. **A GitHub secret value with a trailing newline or surrounding spaces** (pasted from a password manager, or `gh secret set NAME < file`). Uploaded as-is it silently changes `OSN_PAIRWISE_SALT` (every pairwise subject changes) or breaks a JWK. `requireSecrets()` refuses it, naming the secret. Task 4.
2. **A diagnostic that prints a secret value** — an error message, a script's output, a workflow log on this public repository. Every message carries names only; tests assert no value appears. Tasks 4 and 5; the guard forbids `alchemy state read`/`cat` (Task 8).
3. **A secret set but empty, or several missing at once.** An empty string counts as missing, and the error lists every missing name in one run, not the first. Task 4.
4. **A secret name Alchemy silently drops or shadows**: a name starting `ALCHEMY_` (Alchemy injects five `ALCHEMY_*` plain-text bindings first and skips any later env entry with the same name), or one name used as both a var and a secret. The inventory test refuses an `ALCHEMY_` secret name (Task 3); `apiWorkerProps()` refuses an `ALCHEMY_` name in any group and a name used in two of vars, bindings and secrets (Task 6).
5. **An investigation stage name that derives a live name** (`prod` → `osn-db-prod`, `staging` → `osn-db-staging`) or exceeds Cloudflare's 63-character limit. Refused by `parseStage()`/`physicalName()`. Task 2.
6. **A tier's Alchemy job given the other account's credentials.** Dev and production are separate accounts with separate state stores; a dev run with the production token would read and write production state. P0 covers the credential names and the one workflow it adds: `TIER_ACCOUNTS` gives each tier its own secret names, a test holds every workflow's Cloudflare credentials to them, and each Environment check fails on the other tier's credential (Tasks 3 and 5); a test holds the state-store workflow's two steps to their own tier (Task 9). A stack run whose stage and account disagree (a local `--stage dev` with a production login) is not caught in P0, which has no stack; P1 must add that check (Facts later phases must handle).

---

## Facts checked

Each fact below was checked on 2026-10-15/16 (UTC 2026-10-15T16:55Z at the time of the release-age check; workflow facts re-read on 2026-10-16T02:00Z after the rebase onto `2d428e2bc`). Package source was read from tarballs unpacked under `/tmp/alchemy-research/` (outside the repository, read as data, never executed). File:line citations into Alchemy refer to `alchemy@2.0.0-beta.83/src/`.

### Alchemy version and the release-age rule

```
$ npm view alchemy dist-tags --json
{ "next": "2.0.0-beta.72", "latest": "2.0.0-beta.83" }
$ npm view alchemy time --json | grep beta.8
  "2.0.0-beta.80": "2026-10-02T12:20:38.000Z",
  "2.0.0-beta.81": "2026-10-05T17:59:52.868Z",
  "2.0.0-beta.82": "2026-10-12T20:09:50.958Z",
  "2.0.0-beta.83": "2026-10-12T23:21:57.871Z"
$ grep -n minimumReleaseAge bunfig.toml
4:minimumReleaseAge = 259200
48:minimumReleaseAgeExcludes = []
$ bun run check:release-age-excludes
✅ check-release-age-excludes: bunfig.toml passes the release-age guard.
$ date -u
2026-10-15T16:55:12Z
```

- **Pin `alchemy@2.0.0-beta.83`.** It cleared the three-day soak at **2026-10-15T23:21:57Z**; its exact-pinned siblings cleared earlier (`@alchemy.run/cloudflare-runtime`, `floci`, `node-utils` at 23:11–23:12Z, `@distilled.cloud/*@1.0.0-rc.15` at 19:33Z, `rolldown@1.2.5` and `@alchemy.run/sigil@0.1.0-alpha.1` long since). `latest` is still beta.83 on 2026-10-16T02:00Z. No `minimumReleaseAgeExcludes` entry is needed.
- `effect` is a peer of Alchemy (`^4.0.0`); the repository pins `effect` `4.0.3` everywhere (`osn/api/package.json:44`, `cire/api/package.json:42`, …; `bun.lock` holds only `effect@4.0.3`).
- **Second Effect copy, expected.** Alchemy depends on `@effect/sql-d1` and `@effect/sql-sqlite-do` at `^4.0.0`. Their `4.0.4` releases (2026-10-13T04:31Z) clear the soak at 2026-10-16T04:31Z and declare `peerDependencies: { effect: "^4.0.4" }` (`npm view @effect/sql-d1@4.0.4 peerDependencies`), which the repository's `4.0.3` does not satisfy. `4.0.3` of both declares `effect: ^4.0.3`. The same holds for `@effect/platform-node-shared`, which `@effect/platform-bun@4.0.3` and `@effect/platform-node@4.0.3` depend on at `^4.0.3`: its `4.0.4` (2026-10-13T04:32Z, clears the soak 2026-10-16T04:32Z) declares `effect: ^4.0.4` (`npm view @effect/platform-node-shared@4.0.4 peerDependencies`). Before 04:31Z the soak alone keeps all three at `4.0.3`; after it, only the overrides do. Task 1's package test fails on any second copy (it counts `effect@` entries in `bun.lock`); the fix is exact root `overrides` to `4.0.3` for all three, added whatever time Task 1 runs. Closed PR englishstreetventures/osn#1506 hit the same two-copies problem ("Two Effect versions would ship two copies").
- **Existing root overrides reach the new tree.** `package.json` `overrides` pins `ws ^8.21.0`, `undici`, `vite`, `sharp`, `picomatch`, `yaml`, `esbuild` and others. In #1506's lock this kept `ws@8.21.3` under `@effect/platform-node-shared`, whose declared range is `^8.22.0` (`npm view @effect/platform-node-shared@4.0.3 dependencies`; `ws@8.22.0` published 2026-09-26). Task 1 Step 6 lists every existing override the new tree reaches and records whether it satisfies the dependent's range. The `overrides` block is not alphabetical (`smol-toml` follows `tinypool`).
- **`bun audit` overrides, expected.** englishstreetventures/osn#1506 found its Alchemy tree needed root overrides for `hono` (`^4.13.7`), `@hono/node-server` (`^1.19.15`) and `lodash` (`^4.18.0`) to pass `bun audit --audit-level=high`, because `@prisma/dev`, whose only release in Alchemy's `^0.20.0` range is `0.20.0`, pins `hono 4.11.4` and `@hono/node-server 1.19.9` (`npm view @prisma/dev@0.20.0 dependencies`). beta.83 keeps `@prisma/dev ^0.20.0`. None of `hono`, `@hono/node-server`, `lodash`, `@effect/sql-d1`, `@effect/sql-sqlite-do`, `@effect/platform-bun`, `@effect/platform-node` is in `bun.lock` today, so every override touches only the new tree.
- The CLI loads `@effect/platform-bun` or `@effect/platform-node` at runtime (`Util/PlatformServices.ts:63-120`); both are optional peers, so they are direct dependencies of `@shared/infra` at `4.0.3`, as #1506 had them.

### Alchemy behaviour this plan relies on

| Fact | Source |
|---|---|
| A Worker upload sends `keepBindings: undefined`: every secret the props do not declare is dropped. | `Cloudflare/Workers/WorkerProvider.ts:3808` |
| `env` values route by shape: `Redacted<string>` → `secret_text`, `string` → `plain_text`, other → `json`. | `WorkerProvider.ts:2451-2509`, `Worker.ts:771-792` |
| Alchemy first pushes `ALCHEMY_PHASE`, `ALCHEMY_WORKER_NAME`, `ALCHEMY_STACK_NAME`, `ALCHEMY_STAGE`, `ALCHEMY_CLOUDFLARE_ACCOUNT_ID` as plain-text bindings, then skips any `env` key already bound. A secret named `ALCHEMY_*` is silently dropped. | `WorkerProvider.ts:2487-2499` |
| `workersDev` defaults to `true` with `previewsEnabled: true`. | `Worker.ts:164-182, 562-574` |
| `observability` defaults to `{ enabled: true, logs: { enabled: true, invocationLogs: true } }` when omitted. | `Worker.ts:655-666`, `WorkerAsyncBindings.ts:815` |
| The upload's observability accepts `enabled`, `headSamplingRate`, `logs`, `traces`, `issues`, `redactQueryString`. | `@distilled.cloud/cloudflare@1.0.0-rc.15/src/services/workers.ts` `PutScriptMetadataObservability` |
| `domain` omitted leaves custom domains unmanaged; `null` detaches every one. `routes` omitted leaves zone routes unmanaged. | `Worker.ts:855-869`; `WorkerProvider.ts:921-924` |
| Bundled Workers get `new_module_registry` added unless `legacy_module_registry` is listed, and `nodejs_compat` added for compatibility dates before 2026-08-04. | `Worker.ts:726-757`; `@alchemy.run/cloudflare-runtime@2.0.0-beta.83/src/core/internal/constants.ts:13-52` |
| An assets-only Worker (no `main`) reads `_headers` and `_redirects` from the assets directory. | `Workers/Assets.ts:232-255` |
| D1 `migrations`: Alchemy keeps its own `__alchemy_migrations` table and converts a Wrangler `d1_migrations` ledger once; every ledger row must match a local file by name or the deploy fails with `MigrationHistoryConflictError`. | `D1/Database.ts:81-95`; `SQL/Migrations/Convert.ts:173-216`; `AlchemyFormat.ts:140-160` |
| D1 replaces (deleting first when the name is explicit) on a name, jurisdiction or declared `primaryLocationHint` change; `readReplication` is the only in-place update and adoption patches it to the declared mode. | `D1/Database.ts:286-309, 464-481` |
| Adoption stores the declared props as the old props and forces one update, so a creation-only hint left out of the declaration never triggers a replacement. | `Plan.ts:1409-1432` |
| R2: omitting `lifecycleRules`, `cors` or `domains` clears them; `locks` left undeclared stays unmanaged; a changed `locationHint` or jurisdiction replaces. | `R2/Bucket.ts:200-243, 1220-1226, 1348-1365` |
| Default removal policy is `destroy`; `RemovalPolicy.retain()` piped onto the resource Effect sets `retain`. Resource objects expose `LogicalId` and `RemovalPolicy`. | `Resource.ts:333, 432-440`; `RemovalPolicy.ts` |
| `Cloudflare.state()` takes no arguments; the store is the Worker `alchemy-state-store` on the account's `workers.dev`, with its bearer token `AlchemyStateStoreToken` and key `AlchemyStateStoreEncryptionKey` in the account's single Secrets Store. One store per account serves every stack and stage on that account, and the account is whichever `CLOUDFLARE_ACCOUNT_ID` the run carries — so separate accounts give separate stores with no stack code naming either. (alchemy.run/state-store documents a `workerName` option; beta.83's `state()` has none.) | `Cloudflare/StateStore/State.ts:49-59`, `Api.ts:20`, `Token.ts` |
| In CI (`CI=true`) a missing or out-of-date store fails the run unless `--yes` is passed; `alchemy provider cloudflare bootstrap` deploys it, or, when it is serving, refreshes credentials and upgrades it only when its version differs. Every CI run — `state ls` included — uploads a short-lived edge-preview Worker bound to the Secrets Store to read the bearer token, so each token that reaches the store needs Workers Scripts edit as well as Secrets Store read; bootstrap creates the Secrets Store entries, so the token that bootstraps needs Secrets Store edit. | `State.ts:94-142, 199-215, 270-345, 708-768`; `Alchemist/routes/state.ts:54-58`; `Token.ts` |
| State persists each resource's resolved props, encoding `Redacted` values with a marker rather than dropping them. | `Apply.ts:843, 894, 910`; `State/StateEncoding.ts:65-83` |
| Cloudflare credentials come from `CLOUDFLARE_ACCOUNT_ID` plus `CLOUDFLARE_API_TOKEN` whenever both are set, CI or not, before any profile. | `Auth/Resolve.ts:38-62`; `Cloudflare/Auth/AuthProvider.ts:486-510` |
| Telemetry is off when `DO_NOT_TRACK`, `NO_TRACK` or `ALCHEMY_TELEMETRY_DISABLED` is set to any non-empty value. | `Telemetry/Attributes.ts:122-131` |
| `bin/cli.js` is a Node-shebang launcher; `bun alchemy …` from a package script is the form #1506 ran successfully. | `bin/cli.js:1-30`; #1506 test plan |
| `alchemy state ls --backend cloudflare` lists the store without a stack file; `state read`/`cat` print records; bare `alchemy state` opens an interactive explorer that reads records; `alchemy provider cloudflare state logs` reads the store Worker's logs. | `Cli/commands/state.ts:20-128, 156-256`; `Cli/commands/cloudflare.ts:295-357` |
| Alchemy evaluates a stack's body for `plan`, `deploy` and `destroy` alike, with no way for the body to tell them apart. | #1506 PR body, "Teardown skips the checks instead of running them" |

### Live Workers and their secret names (names only)

```
$ (Cloudflare MCP) workers_list
englishstreetventures-com, cire-invites-dev, cire-api-dev, osn-api-dev,
zap-api-production, cire-invites, cire-api-production, osn-api-production
$ for w in …; do wrangler@4.149.0 secret list --name "$w" --format json | (names); done
osn-api-dev         DEV_LOGIN_SECRET INTERNAL_SERVICE_SECRET OSN_JWT_PRIVATE_KEY OSN_JWT_PUBLIC_KEY OSN_PAIRWISE_SALT OSN_SESSION_IP_PEPPER OSN_TOTP_ENCRYPTION_KEY RESEND_API_KEY UPSTASH_REDIS_REST_TOKEN UPSTASH_REDIS_REST_URL
osn-api-production  INTERNAL_SERVICE_SECRET OSN_JWT_PRIVATE_KEY OSN_JWT_PUBLIC_KEY OSN_PAIRWISE_SALT OSN_SESSION_IP_PEPPER OSN_TOTP_ENCRYPTION_KEY RESEND_API_KEY TURNSTILE_SECRET_KEY UPSTASH_REDIS_REST_TOKEN UPSTASH_REDIS_REST_URL
cire-api-dev        CIRE_API_ARC_KEY_ID CIRE_API_ARC_PRIVATE_KEY CIRE_OIDC_CLIENT_SECRET OSN_API_URL STRIPE_PLATFORM_WEBHOOK_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET
cire-api-production CIRE_API_ARC_KEY_ID CIRE_API_ARC_PRIVATE_KEY CIRE_OIDC_CLIENT_SECRET GROWTHBOOK_CLIENT_KEY OSN_API_URL
zap-api-production  GROWTHBOOK_CLIENT_KEY INTERNAL_SERVICE_SECRET
cire-invites        (none)
cire-invites-dev    (none)
$ wrangler secret list --name zap-api-production --format json     # stdout is pure JSON
[ { "name": "GROWTHBOOK_CLIENT_KEY", "type": "secret_text" }, { "name": "INTERNAL_SERVICE_SECRET", "type": "secret_text" } ]
```

- All of these live in the current Cloudflare account, which stays the production account. The dev Workers above are the old dev tier; P1 builds their successors in the new dev account under the same names and the owner then deletes these. Until then the inventory's dev rows equal these Workers' names, and they are also the names the new dev Workers will hold.
- There is **no `zap-api-dev` Worker** and no zap dev D1 (`zap/api/wrangler.toml` `[env.dev]` binds `database_id = "placeholder-replace-after-d1-create"`). P1 creates both in the new account, with an inventory change.
- `englishstreetventures-com` is not in this repository. No stack may declare it.
- Every live name is read by its Worker's code (`grep -rlw <name> <worker>/src`), **except `GROWTHBOOK_CLIENT_KEY` on zap-api**: nothing under `zap/api/src` reads it and `zap/api/package.json` does not depend on `@shared/feature-flags`. The owner retired it (#1532): the inventory forbids it on zap-api, `secrets:check-live --tier production` reports it until P3's zap-api step deletes it, and cire-api production keeps its own `GROWTHBOOK_CLIENT_KEY`.
- `INTERNAL_SERVICE_SECRET` is one value across osn-api and zap-api by design: zap-api registers its ARC key at osn-api with it (`zap/api/src/services/zapGraphBridge.ts:116-121`; `zap/api/src/lib/arc-middleware.ts:48` "The single INTERNAL_SERVICE_SECRET is the trust root across services").
- osn-api fails closed outside local without `OSN_JWT_PRIVATE_KEY`, `OSN_JWT_PUBLIC_KEY`, `OSN_SESSION_IP_PEPPER`, `OSN_TOTP_ENCRYPTION_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `RESEND_API_KEY` (`osn/api/wrangler.toml:432-456`) and `OSN_PAIRWISE_SALT` (`.github/workflows/deploy.yml:686`, `.github/workflows/production-release.yml:664`; `wiki/shared/production-deploy.md:356`). cire-api's organiser sign-in answers 503 without `CIRE_OIDC_CLIENT_SECRET` (`wiki/shared/production-deploy.md:420`).
- osn-api also reads `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS` (`osn/api/src/build-deps.ts:64,351-354`), set only while a TOTP key rotation drains and deleted after (`osn/api/wrangler.toml:441-449`; `.github/workflows/set-osn-api-secret.yml:142`). It is unset on both tiers today, and must survive any deploy while it is set: the inventory holds it as an **optional** secret.
- Forbidden today: `DEV_LOGIN_SECRET` and `RESEND_API_URL` on osn-api production (`production-release.yml:684`), `RESEND_API_URL` on cire-api production (`production-release.yml:258`), and `RESEND_API_URL` on every deployed tier of both (`osn/api/wrangler.toml:457`; `wiki/shared/production-deploy.md:369,423`).
- Several current production values may exist only inside Cloudflare, which never returns a value. `.github/workflows/set-osn-api-secret.yml:68` says a TOTP key "generated in-job BEFORE this change has no copy anywhere"; that workflow writes with `wrangler secret put` (line 250). The spec's "Secret values" decision covers this with a proof before P1 (englishstreetventures/osn#1537).

### GitHub Environments

```
$ gh api repos/englishstreetventures/osn/environments --jq '.environments[] | …'      # 2026-10-16
dev protection=branch_policy
production protection=required_reviewers,branch_policy
$ gh api repos/englishstreetventures/osn/environments/<env>/secrets --jq '.secrets[].name'
dev:         CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN_DEV DEV_LOGIN_SECRET
production:  CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN OSN_TOTP_ENCRYPTION_KEY
repo:        ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN_READONLY RELEASE_TOKEN TESSL_TOKEN
dev variables: CIRE_DEV_OWNER_PROFILE_ID
```

- Both of today's tokens are in **one Cloudflare account**, the current one (`.github/workflows/deploy.yml:22-45`, which also says "A real boundary needs a separate Cloudflare account"). The `dev` Environment's `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN_DEV` drive today's Wrangler dev deploys (`deploy.yml:176-178`, used at `deploy.yml:248` and every dev job after it) until P1 replaces them, and a repository-level `CLOUDFLARE_ACCOUNT_ID` names the same account. The new dev account's id and token therefore cannot reuse either name: they need names of their own, which Decision 9 fixes.
- `set-osn-api-secret.yml:134-142` reads `DEV_LOGIN_SECRET`, `OSN_TOTP_ENCRYPTION_KEY` and `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS` from the Environment secret of the same name — the naming this plan keeps. Run for `tier: dev`, it writes into the old `osn-api-dev` in the current account.

### Storage

```
$ (Cloudflare MCP) d1_databases_list → osn-db-dev, cire-db-dev, zap-db-prod, osn-db-prod, osn-db-staging, osn-db, cire-db
$ (Cloudflare MCP) r2_buckets_list   → cire-assets, cire-assets-dev, cire-sheets, cire-sheets-dev
$ wrangler r2 bucket lifecycle list cire-assets      → Default Multipart Abort Rule, Abort incomplete multipart uploads after 7 days
$ wrangler r2 bucket lifecycle list cire-sheets      → (same)
$ wrangler r2 bucket lifecycle list cire-assets-dev  → There are no lifecycle rules for bucket 'cire-assets-dev'.
$ wrangler r2 bucket lifecycle list cire-sheets-dev  → There are no lifecycle rules for bucket 'cire-sheets-dev'.
```

englishstreetventures/osn#1512 (restore the rule on both old dev buckets) is open. It no longer feeds parity: P1 creates the dev buckets in the new account, declared with production's rule. P0 does not wait on it.

### The release path the spec names

```
$ gh issue view 1449 → CLOSED (by #1524, "Production: ship in daily releases with one approval", merged as 2d428e2bc)
$ ls .github/workflows/production-release.yml scripts/deploy-surfaces.ts scripts/release-plan.ts → present
$ gh issue view 1513 → OPEN  Deploy: smoke-check every Worker deploy and roll back automatically on failure
```

`production-release.yml` runs a `plan` job (`scripts/release-plan.ts`, no Environment), a `build` job, then one `deploy-<surface>` job per surface in the `production` Environment, all gated by one approval. The spec's two approvals (an Alchemy plan job in the `production` Environment, then the deploy) are P3's change to this workflow. **P0 edits none of `deploy.yml`, `production-release.yml`, `scripts/deploy-surfaces.ts`, `wiki/shared/production-deploy.md`, `wiki/shared/dev-environment.md`, `AGENTS.md`.**

### Workspace mechanics

- Root `package.json` `workspaces` already globs `shared/*`, and `fmt`/`fmt:check` already cover `shared`, so `shared/infra` needs no root workspace or format edit.
- Every `shared/*` package is versioned and tests with `bunx --bun vitest` (`shared/redis/package.json`), extends `@shared/typescript-config/node.json` (which sets `types: ["bun-types"]`, so `Bun.YAML` is typed in tests), and keeps `vitest.config.ts` at `{ test: { environment: "node", include: ["tests/**/*.test.ts"] } }`. `node.json` extends `base.json`, which sets `declaration` and `declarationMap` (`shared/typescript-config/base.json:15-16`); #1506's Alchemy workspace instead extended the root `tsconfig.json`, which sets neither. `@shared/infra` is consumed as source and never emits, so its `tsconfig.json` turns both off rather than give every Alchemy wrapper a hand-written return type.
- Any change under `shared/`, to `bun.lock` or to the root `package.json` redeploys every dev surface and ships every production surface in the next release (`scripts/deploy-surfaces.ts:126-128`).
- Root `turbo.json` `test` inputs are `$TURBO_DEFAULT$` minus Markdown; a package whose tests read files outside it adds them with `$TURBO_ROOT$` in its own `turbo.json` (the pattern #1506 used and verified with `turbo run test --dry=json`).
- `.changeset/config.json` versions private packages; `@shared/*` is versioned, so the changeset names `@shared/infra` alone.
- `scripts/` is not a workspace and its CI job does no install: files there import only `bun:test`, Bun and Node built-ins (`scripts/tsconfig.json` "//"). A guard has unit tests plus a CI step running it against the real tree (`.github/workflows/ci.yml`, `script-tests` job).
- `bun audit` runs only in the local pre-push hook (`lefthook.yml:95-98`): `bun audit --audit-level=high --ignore=GHSA-vfj7-8cjw-p6xm --ignore=GHSA-ch52-4w7c-c8xp`.

### Where stacks belong

`wiki/shared/osn-and-musubi.md` "The rule": "If an independent implementation must use the same string to interoperate, it is **OSN**. Otherwise it is **Musubi**", and its table lists "the hosted instance's configuration" under Musubi. The owner chose `musubi/infra` for our instance (osn-api, musubi social, musubi landing) and `pulse/infra` for pulse landing; a reusable `osn/infra` stack template is later work. P0 builds no product stack, so the answer reaches P0 only through the wiki page's layout section.

---

## Decisions this plan fixes for P1–P4

These are the P0 choices later phases build on. Each is tested in the task named.

1. **`@shared/infra` API** (Tasks 2–7): `parseStage`, `tierOf`, `isLongLivedStage`, `physicalName`; `TIER_ACCOUNTS`; `SECRET_INVENTORY`, `tierSecrets`, `requireSecrets`; `apiWorkerProps`/`apiWorker`, `siteWorkerProps`/`siteWorker`, `retainedD1Props`/`retainedD1`, `retainedBucketProps`/`retainedBucket`, `removalFor`, `assertRetained`; `stackOptions`. Builders are pure and take every behaviour-changing setting as a required input, because Alchemy's defaults differ from Wrangler's (workers.dev on, preview URLs on, invocation logs on, lifecycle and CORS cleared when omitted).
2. **Secret inventory format** (Task 3): a typed module, `shared/infra/src/secrets/inventory.ts`. One entry per deployed Worker; per tier the script name (or `null` when the tier has no Worker), the sorted **required** secret names (declared on every deploy; a missing value fails it), the sorted **optional** names (declared only while their GitHub secret holds a value — today only `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS`, for a rotation drain), and the names it must never hold (a forbidden name a live Worker still holds fails the live check). Any other secret a Worker should hold is an inventory change in a reviewed pull request; setting a GitHub secret alone deploys nothing. **The GitHub Environment secret is named exactly like the Worker secret**; a name two Workers hold in one tier is one GitHub secret, so the next Alchemy deploy gives both Workers the same value, and the pair must be listed in `SHARED_SECRET_VALUES`. The dev rows name what the dev Workers hold, today in the current account and from P1 in the new one; the dev values are new for the new account.
3. **State store** (Tasks 7 and 9): every stack's state is `Cloudflare.state()`, reached only through `stackOptions()`; the guard refuses any other state constructor in a stack file. Each account has its own store, chosen by the credentials a run carries, never by stack code. The `Alchemy state store` workflow bootstraps (`action: bootstrap`) or checks (`action: check`, which lists stack names and writes no state, though it uploads a temporary edge-preview Worker to read the store's token) one tier's store with that tier's credentials. Production's store is bootstrapped by the owner after merge; dev's waits for the new account. Nothing prints state contents: the guard allows `alchemy state ls`/`list` only, and forbids every other `state` subcommand, bare `state` (the explorer), `provider cloudflare state logs`, `nuke`, `drift --repair` and `provider cloudflare teardown` in package scripts, workflows and composite actions.
4. **Stack layout per product** (wiki, Task 10): one Alchemy stack per product directory, `<product>/infra/alchemy.run.ts`, a workspace named `@<product>/infra` (`@cire/infra` is version-less like every `@cire/*`), stack name equal to the product directory name: `cire`, `zap`, `musubi` (osn-api, musubi social, musubi landing) and `pulse` (pulse landing, P3). The stack name keys Alchemy state rows and becomes the `ALCHEMY_STACK_NAME` binding on every Worker, so it never changes after P1's first deploy. Every Worker, database and bucket name is passed explicitly — Alchemy's generated `${app}-${stage}-${id}` names are never used for a long-lived resource.
5. **Stage naming** (Task 2): stages are lowercase letters and digits joined by single hyphens, 1–20 characters, never `prod`, `staging` or `local`. `dev` and `production` are the long-lived stages and keep today's names through `physicalName()` (production by adoption; dev by creating the new account's resources under the same names); any other stage derives `<base>-<stage>`, refused when that equals a dev or production name or exceeds 63 characters. Only the stage spelled `production` maps to the production tier; every other stage, investigation stages included, is dev-tier and runs in the dev account.
6. **Removal policy** (Tasks 6–7): storage is always retained; a Worker on a long-lived stage is retained; an investigation stage's Workers are destroyed with it. Stacks call `assertRetained()` on every resource a long-lived stage must keep, so a lost `retain()` fails the plan, not the destroy. The spec states retention for storage only; extending it to long-lived Workers is this plan's choice (a deleted production Worker loses its secrets with it).
7. **`requireSecrets()` fails closed** (Task 4): it throws in the stack body whenever a required secret is missing, for every command, because Alchemy evaluates the body for `plan`, `deploy` and `destroy` alike. A job that runs Alchemy for a stage therefore needs that stage's secrets. The owner's two-approval release (spec, Deploy flow) runs the Alchemy plan job in the `production` Environment, so it has them, and every P1–P3 job runs in its tier's Environment. P4's pull-request previews cannot enter the `dev` Environment (branch policy `main` only), so they may need a plan-only mode; that is the spec's open question 3, and it would add an optional field to `requireSecrets`'s input without breaking P0's callers.
8. **Production observability** (Task 6): `apiWorkerProps()` refuses `redactQueryString: false` and native traces on for a production stage, the rule `scripts/check-trace-redaction.ts` enforces on today's Wrangler configs, so the rule holds when Alchemy deploys from props instead.
9. **Account credentials** (Tasks 3 and 9): `TIER_ACCOUNTS` in `shared/infra/src/accounts.ts` names, per tier, the GitHub Environment and the two Environment secrets an Alchemy job maps to `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Production: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in `production`, today's names, because production stays in the current account. Dev: `CLOUDFLARE_DEV_ACCOUNT_ID` and `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN` in `dev` — new names, because today's dev names keep driving the old dev tier's Wrangler deploys until P1 retires them, and both today's names point at the production account. The account id itself is an owner value no file holds. The names are this plan's choice; englishstreetventures/osn#1538 asks the owner to create them, and renaming them later is a change to `accounts.ts` and the workflows that a test holds together. `accounts.ts` also classifies every other Cloudflare credential a workflow reads — the old dev tier's (`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN_DEV` in `dev`, deleted with it) and the repository's read-only pair — so each Environment check fails when an Environment holds the other tier's credential, and a test fails when a workflow reads a credential nobody classified.

## Owner answers

Given 2026-10-16 in the orchestrating session (https://github.com/englishstreetventures/osn/issues/1533#issuecomment-6206254623):

- **Q1 — stack home.** `musubi/infra` for our identity instance (osn-api, musubi social, musubi landing); pulse landing in `pulse/infra`. A stack template for `osn/infra` later, low priority (englishstreetventures/osn#1539, Backlog).
- **Q2 — zap-api `GROWTHBOOK_CLIENT_KEY`.** Retire it (#1532). The inventory forbids it on zap-api; P3's zap-api step deletes it live.
- **Q3 — secret values.** Before P1's first osn-api and cire-api deploys, prove each stored value matches live without revealing it (JWKS, client-secret hash, one TOTP ciphertext, one pairwise subject, ARC public key) — englishstreetventures/osn#1537, blocking P1.
- **Q4/Q5 — accounts and tokens.** Dev moves to a new Cloudflare account built fresh by Alchemy; production stays in the current account, adopted in place. Each account has its own state store. The production token gains Secrets Store access for the production state store; the production token bootstraps that store, so the access is Secrets Store **Edit** (bootstrap creates the store's entries; `Token.ts`). The dev account's token is created with what P1 needs, Secrets Store Edit included; today's `CLOUDFLARE_API_TOKEN_DEV` gains nothing and is deleted after P1. The account, domain, token and `dev` Environment are englishstreetventures/osn#1538, blocking P1.
- **Q6 — production releases.** Two approvals: a plan job, then the deploy.
- **Raised again by the second stress run (NEEDS INPUT, does not block P0):** with Q2's decision, `secrets:check-live -- --tier production` exits 1 on zap-api's `GROWTHBOOK_CLIENT_KEY` until P3, so new production drift would arrive behind an already-failing exit code. (a) Keep the decision: the gate expects exactly that one DIFF line, and anything else fails it. (b) Delete the live key now with `wrangler secret delete` (no code reads it; it makes a new zap-api version), so the check is green. The plan follows (a) until the owner says otherwise.

## Facts later phases must handle (not P0 work)

- **P1, prerequisites:** the dev account, its dev-only domain (or the choice of `workers.dev`), its token and the filled `dev` Environment (englishstreetventures/osn#1538), and the production secret-value proof (englishstreetventures/osn#1537). Bootstrap the dev state store with the `Alchemy state store` workflow (`tier: dev, action: bootstrap`) before P1's first deploy.
- **P1, stage against account:** nothing in P0 ties a stage's tier to the account a run reaches; `stackOptions()` takes whatever account the credentials name. P1's stacks must refuse a run whose stage tier and account disagree — for example `stackOptions(stage)` comparing `tierOf(stage)` with a non-secret tier marker each job sets beside its credentials, and refusing a local production run outright. Site-only stacks declare no secrets, so `requireSecrets()` cannot catch it for them.
- **P1, dev hosts:** a Worker can hold a custom domain only on a zone in its own account, so every dev host on today's zones (`api.dev.cireweddings.com`, `id.dev.musubi.social`, …) moves to the dev domain or `workers.dev`. Each value that names a dev host changes with it: OIDC client redirect URIs, CORS origins, cookie domains, the WebAuthn RP ID, `OSN_API_URL`, Stripe webhook endpoints (new webhook secrets), the dev `PUBLIC_*` build values. `workers.dev` is on the Public Suffix List, which limits cookies shared across hosts; P1 confirms the identity flows work on whichever the owner picks.
- **P1, dev data:** dev databases are created by Alchemy and built from migrations and seeds; Alchemy is their only migrator from creation, so no ledger conversion happens on dev. Values tied to seed rows (the dev `CIRE_OIDC_CLIENT_SECRET` and its seeded hash, the ARC key registration) are made together with the seeds.
- **P1, zap dev:** zap has no dev Worker or dev database; P1 creates both, with an inventory change (`zap-api` dev row: `zap-api-dev`, `INTERNAL_SERVICE_SECRET` shared with osn-api dev in `SHARED_SECRET_VALUES`).
- **P1, cire dev nightly rebuild:** `.github/workflows/cire-dev-db-rebuild.yml:30,79-82` drops every table of `cire-db-dev` each night (`scripts/cire-db-reset.sh`) and migrates with Wrangler (`cire/db/package.json` `db:migrate:dev`) — a second migrator, against the old account. P1 retires it or rewrites it to rebuild the new account's database through Alchemy (dropping `__alchemy_migrations` with the rest makes the next deploy re-apply every migration).
- **P1, old dev tier:** P1's change removes the Wrangler dev deploy jobs and dev migration scripts; the owner then deletes the old dev Workers, databases, buckets, Pages projects, dev DNS records and `CLOUDFLARE_API_TOKEN_DEV` from the current account. `set-osn-api-secret.yml`'s dev path targets the old `osn-api-dev` and goes with it.
- **P1, bundling:** Alchemy bundles `main` with rolldown, not Wrangler's esbuild, and adds `new_module_registry` unless `legacy_module_registry` is listed (`constants.ts:13-52`). Today's Workers set only `nodejs_compat` (and `nodejs_compat_populate_process_env` on the API Workers). P1's parity test must compare the effective flag set, and decide the module registry deliberately.
- **P1, injected bindings:** every Alchemy-uploaded Worker gains the five `ALCHEMY_*` plain-text bindings; P1's binding-parity test must expect them.
- **P1, `bun install`:** `deploy.yml` jobs run a bare `bun install` (`deploy.yml:158`); the spec's constraint applies to every job P1 adds or edits.
- **P1, paths:** D1 migrations resolve against `process.cwd()` (`D1/Database.ts:683`); stacks run from their own package directory.
- **P1, reverse secret check:** the inventory test checks that every declared name is read by code, not that every secret the code reads is declared. P1's binding-parity test, which enumerates each Worker's vars and bindings from its Wrangler config, should also show every name the Worker reads is a var, a binding, an inventory secret or a deliberately unset optional key.
- **P1+, state upgrades:** `deploy --yes` also upgrades an out-of-date state store (`State.ts:128-136`), which needs Secrets Store edit on that account's token.
- **P3, production state and release:** the owner bootstraps the production state store before P3 (after granting the production token Secrets Store Edit). `production-release.yml` gains an Alchemy plan job in the `production` Environment (approval 1) that the deploy jobs need (approval 2); the plan job has production secrets, so `requireSecrets()` passes there.
- **P3, cire ledger:** Alchemy refuses a Wrangler ledger row with no matching local file (`Convert.ts:173-216`); cire's production ledger holds the archived names (`scripts/cire-db-migrate.ts:5-12`) that are not in `cire/db/migrations`. A `migrations: "…/cire/db/migrations"` declaration refuses on `cire-db` unless cire's stack supplies the archived files.
- **P3, `set-osn-api-secret.yml`:** it writes osn-api secrets directly with `wrangler secret put` (line 250), and generates `OSN_PAIRWISE_SALT` in-job with no copy. Once Alchemy deploys `osn-api-production`, the next deploy overwrites or drops anything that workflow set; the workflow must write the GitHub Environment secret instead, or be retired, in the same change.
- **P3, zap GrowthBook:** zap-api's first Alchemy deploy deletes `GROWTHBOOK_CLIENT_KEY` (#1532); `secrets:check-live --tier production` then passes.
- **P1+, trace-redaction guard:** `scripts/check-trace-redaction.ts` reads Wrangler configs, which stop deploying once Alchemy does; `apiWorkerProps()` carries its production rule from P0 (Decision 8), and the guard can be retired with the configs.
- **Future, investigation stages:** `requireSecrets()` runs for `destroy` too (Decision 7), so tearing down an investigation stage needs the dev Environment's secrets.
- **P4, credentials:** a pull-request run cannot enter the `dev` Environment (branch policy `main` only), so it has no dev token and no dev secrets for `requireSecrets()`; spec open question 3.
- **P3, pulse landing:** its `/api/geo` Pages Function needs a Worker `main` beside the assets, or the owner drops it (spec open question 1); `siteWorker()` is assets-only.
- **P1, deploy records:** one Alchemy job per stack against `deploy-surfaces.ts`'s per-surface jobs and Deployment records (spec open question 2).
- **P4:** Alchemy's `preview` prop is Cloudflare's private-beta Worker Previews (`Worker.ts:551-561`), not version preview URLs; the spec's previews mean version preview URLs (`workersDev.previewsEnabled`), which `apiWorker()` leaves on for non-production stages.

---

## File structure

| Path | Responsibility | Read by |
|---|---|---|
| `shared/infra/package.json` | Workspace, exact pins, scripts | `bun install`, turbo, `tests/package.test.ts`, `scripts/check-alchemy-usage.ts` |
| `shared/infra/tsconfig.json` | Type-check config | `bun run --cwd shared/infra check` |
| `shared/infra/vitest.config.ts` | Test discovery | `bunx --bun vitest` |
| `shared/infra/turbo.json` | Test inputs outside the package | `turbo run test` |
| `shared/infra/src/stage.ts` | Stage rules, tier, physical names | `require.ts`, `worker.ts`, `removal.ts`, product stacks (P1) |
| `shared/infra/src/accounts.ts` | Each tier's credential secret names | `inventory.ts`, `compare.ts`, `tests/accounts.test.ts`, product workflows (P1, P3) |
| `shared/infra/src/secrets/inventory.ts` | The secret inventory | `require.ts`, `compare.ts`, inventory test |
| `shared/infra/src/secrets/require.ts` | `requireSecrets()` | product stacks (P1) |
| `shared/infra/src/secrets/compare.ts` | Pure name diffs for the check scripts | `scripts/check-*-secrets.ts` |
| `shared/infra/src/worker.ts` | `apiWorkerProps`, `siteWorkerProps` | `declare.ts` |
| `shared/infra/src/storage.ts` | `retainedD1Props`, `retainedBucketProps` | `declare.ts` |
| `shared/infra/src/removal.ts` | `removalFor`, `assertRetained` | `declare.ts`, product stacks (P1) |
| `shared/infra/src/declare.ts` | Wrappers that call Alchemy | product stacks (P1) |
| `shared/infra/src/stack.ts` | `stackOptions()` | product stacks (P1); the guard allows state constructors only here |
| `shared/infra/src/index.ts` | Public exports | product stacks (P1), `tests/index.test.ts` |
| `shared/infra/scripts/check-live-secrets.ts` | Inventory vs one tier's live Worker secret names | `bun run --cwd shared/infra secrets:check-live -- --tier <tier>` |
| `shared/infra/scripts/check-github-secrets.ts` | Inventory and account credentials vs GitHub Environment secret names | `bun run --cwd shared/infra secrets:check-github` |
| `shared/infra/tests/**` | Tests | `bun run --cwd shared/infra test:run`, `turbo test` |
| `scripts/check-alchemy-usage.ts` | Repository guard | `bun run check:alchemy-usage`, CI `script-tests` |
| `scripts/tests/check-alchemy-usage.test.ts` | Guard tests | `bun run test:scripts` |
| `.github/workflows/alchemy-state.yml` | Bootstrap or check one tier's state store | GitHub Actions `workflow_dispatch`; the guard; `tests/accounts.test.ts` |
| `.github/workflows/ci.yml` (modify) | Run the guard on the real tree | CI |
| `package.json` (modify) | `overrides`, `check:alchemy-usage` | bun, CI |
| `bun.lock` (modify) | Lockfile | bun |
| `.gitignore` (modify) | `.alchemy/` | git |
| `.changeset/shared-infra-foundation.md` | Changeset | changesets |
| `wiki/shared/infrastructure-as-code.md` | The page for all of the above | readers, P1–P4 |
| `wiki/shared/monorepo-structure.md`, `wiki/compliance/access-control.md`, `wiki/index.md` (modify) | Stale pages | readers |

---

### Task 1: The `@shared/infra` workspace, pinned

**Files:**
- Create: `shared/infra/package.json`, `shared/infra/tsconfig.json`, `shared/infra/vitest.config.ts`, `shared/infra/turbo.json`, `shared/infra/src/index.ts`, `shared/infra/tests/package.test.ts`
- Modify: `package.json` (`overrides`), `bun.lock`, `.gitignore`

**Interfaces:**
- Produces: workspace `@shared/infra` with dependencies `alchemy 2.0.0-beta.83`, `effect 4.0.3`, `@effect/platform-bun 4.0.3`, `@effect/platform-node 4.0.3`; scripts `check`, `test`, `test:run` (later tasks add more).

- [ ] **Step 1: Confirm the soak has cleared.** Run `date -u +%Y-%m-%dT%H:%M:%SZ`. Expected: later than `2026-10-15T23:22:00Z`. If not, stop and wait.

- [ ] **Step 2: Write the package skeleton** (no dependencies yet; `bun add` writes them).

`shared/infra/package.json`:

```json
{
  "name": "@shared/infra",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "author": "English Street Ventures Pty Ltd",
  "license": "UNLICENSED",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/englishstventures/osn.git"
  },
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "check": "tsc --noEmit",
    "test": "bunx --bun vitest",
    "test:run": "bunx --bun vitest run"
  },
  "devDependencies": {
    "@shared/typescript-config": "workspace:*"
  }
}
```

`shared/infra/tsconfig.json` (the shared Node config, with the `DOM` library #1506's Alchemy workspace also added, and declaration output off: `base.json:15-16` turns it on, this package is consumed as source and never emits, and the Alchemy wrappers' inferred types are not meant to be written out):

```json
{
  "extends": "@shared/typescript-config/node.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM"],
    "declaration": false,
    "declarationMap": false
  },
  "include": ["src/**/*", "tests/**/*", "scripts/**/*"],
  "exclude": ["node_modules"]
}
```

`shared/infra/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/**/*.test.ts"] } });
```

`shared/infra/turbo.json` (Task 3's inventory test reads each Worker's source, this task's package test reads the root `bun.lock`, and the account tests read every workflow; without these inputs turbo replays a cached pass after a Worker starts or stops reading a secret, after the lockfile gains a second Effect, or after a workflow reads a credential of the wrong tier):

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "extends": ["//"],
  "tasks": {
    "test": {
      "inputs": [
        "$TURBO_DEFAULT$",
        "!**/*.md",
        "$TURBO_ROOT$/osn/api/src/**",
        "$TURBO_ROOT$/cire/api/src/**",
        "$TURBO_ROOT$/zap/api/src/**",
        "$TURBO_ROOT$/cire/invites/src/**",
        "$TURBO_ROOT$/bun.lock",
        "$TURBO_ROOT$/.github/workflows/**"
      ]
    }
  }
}
```

`shared/infra/src/index.ts` (replaced in Task 7):

```ts
export {};
```

Append to `.gitignore`:

```
# Alchemy's local state and Worker bundles (`.alchemy/` under the directory a CLI run starts in)
.alchemy/
```

- [ ] **Step 3: Write the failing test** `shared/infra/tests/package.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/** The Alchemy release whose source this package's builders were checked against. */
const AUDITED_ALCHEMY = "2.0.0-beta.83";

type Manifest = {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
};

const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8")) as Manifest;

/** The installed package `name` as `fromDir` resolves it: its directory and manifest. */
function installed(name: string, fromDir: string): { readonly dir: string; readonly manifest: Manifest } {
  let dir = dirname(createRequire(join(fromDir, "index.js")).resolve(name));
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const manifest = readManifest(candidate);
      if (manifest.name === name) return { dir, manifest };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json for ${name} above ${fromDir}`);
    dir = parent;
  }
}

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const own = readManifest(join(packageDir, "package.json"));

describe("pinned Alchemy", () => {
  test("declares and installs the audited release", () => {
    expect(own.dependencies?.alchemy).toBe(AUDITED_ALCHEMY);
    expect(installed("alchemy", packageDir).manifest.version).toBe(AUDITED_ALCHEMY);
  });

  test("Alchemy loads the repository's Effect", () => {
    const alchemy = installed("alchemy", packageDir);
    expect(installed("effect", alchemy.dir).manifest.version).toBe(own.dependencies?.effect);
  });

  test("the lockfile resolves exactly one Effect, the one this package pins", () => {
    // `bun.lock` names each resolved copy as `"effect@<version>"`; a second
    // copy appears as another version under a nested key such as
    // `"@effect/sql-d1/effect"`.
    const lock = readFileSync(join(packageDir, "..", "..", "bun.lock"), "utf8");
    const versions = new Set([...lock.matchAll(/"effect@([^"]+)"/g)].map((match) => match[1]));
    expect([...versions]).toEqual([own.dependencies?.effect]);
  });
});
```

- [ ] **Step 4: Add the dependencies.**

```bash
cd /Users/ac/.work/osn.git/alchemy-foundation
bun add --exact --cwd shared/infra alchemy@2.0.0-beta.83 effect@4.0.3 @effect/platform-bun@4.0.3 @effect/platform-node@4.0.3
bun add -d --exact --cwd shared/infra vitest@5.0.3
```

- [ ] **Step 5: Run the test.** `bun run --cwd shared/infra test:run`. Expected now: the two version tests PASS; the lockfile test FAILS listing a second version when `@effect/sql-d1`, `@effect/sql-sqlite-do` or `@effect/platform-node-shared` resolved `4.0.4`+ (their peer `effect ^4.0.4` pulls a second Effect).

- [ ] **Step 6: Pin Alchemy's Effect packages to the repository's Effect, then audit.** Add these entries to the root `package.json` `overrides` (the block has no strict order; keep them together):

```json
"@effect/platform-node-shared": "4.0.3",
"@effect/sql-d1": "4.0.3",
"@effect/sql-sqlite-do": "4.0.3",
```

If the lockfile test still lists a second version, `grep -n '"effect@' bun.lock` names the key that pulls it; pin that `@effect/*` package to `4.0.3` the same way. Re-run the Step 4 `bun add` line for the dependencies (it re-resolves with the overrides).

Then list every existing root override the new tree reaches and whether the forced version satisfies what the dependent declares:

```bash
for name in $(jq -r '.overrides | keys[]' package.json); do bun why "$name" 2>/dev/null | grep -q "alchemy\|@effect/platform" && echo "$name: $(bun why "$name" | head -3 | tr '\n' ' ')"; done
```

Record each hit in `NEW-FEAT.md` and the PR body. Expected: `ws` forced to `8.21.x` under `@effect/platform-node-shared` (declares `^8.22.0`). Do not change a repository-wide override in this branch; a forced version outside the dependent's range goes in the PR body as a known gap with an issue.

Then audit:

```bash
bun audit --audit-level=high --ignore=GHSA-vfj7-8cjw-p6xm --ignore=GHSA-ch52-4w7c-c8xp
```

For each package it reports at high severity that only the new tree reaches (`bun why <name>`), add the lowest fixed release past the soak as an override — expected, from #1506: `"@hono/node-server": "^1.19.15"`, `"hono": "^4.13.7"`, `"lodash": "^4.18.0"` — and re-run the `bun add` line and the audit until it exits 0. Never add an override for a package something outside `shared/infra` resolves without saying so in the PR body.

- [ ] **Step 7: Prove the lockfile.**

```bash
bun install --frozen-lockfile                 # expect: no changes
bun run --cwd shared/infra test:run           # expect: 3 pass
bun run --cwd shared/infra check              # expect: exit 0
bun run check:release-age-excludes            # expect: passes
bun pm untrusted                              # expect: no new untrusted lifecycle scripts beyond workerd's (as #1506)
bash scripts/lockfile-evidence.sh "$(git merge-base origin/main HEAD)" HEAD   # expect: exit 0; section 3 lists only the Alchemy tree
```

Record each command's last line in `NEW-FEAT.md`.

- [ ] **Step 8: Commit.**

```bash
git add shared/infra package.json bun.lock .gitignore
git commit -m "Infra: add @shared/infra pinned to Alchemy 2.0.0-beta.83"
```

---

### Task 2: Stages, tiers and physical names

**Files:**
- Create: `shared/infra/src/stage.ts`
- Test: `shared/infra/tests/stage.test.ts`

**Interfaces:**
- Produces: `type Tier = "dev" | "production"`; `RESERVED_STAGES: readonly string[]`; `MAX_STAGE_LENGTH = 20`; `MAX_RESOURCE_NAME_LENGTH = 63`; `class InvalidStageError` (`_tag: "InvalidStageError"`, fields `stage`, `message`); `parseStage(stage: string): string`; `isLongLivedStage(stage: string): boolean`; `tierOf(stage: string): Tier`; `interface StageNames { base; dev; production }`; `physicalName(names: StageNames, stage: string): string`.

- [ ] **Step 1: Write the failing test** `shared/infra/tests/stage.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { InvalidStageError, isLongLivedStage, parseStage, physicalName, tierOf } from "../src/stage";

// Live names (Cloudflare D1 list, 2026-10-15): the two naming shapes in use today.
const OSN_DB = { base: "osn-db", dev: "osn-db-dev", production: "osn-db-prod" };
const CIRE_DB = { base: "cire-db", dev: "cire-db-dev", production: "cire-db" };

describe("parseStage", () => {
  test.each(["dev", "production", "pr-1512", "alice", "a1-b2"])("accepts %j", (stage) => {
    expect(parseStage(stage)).toBe(stage);
  });

  test.each(["", "Prod", "pr_1", "-pr", "pr-", "pr--1", "1pr", "a".repeat(21), "prod", "staging", "local"])(
    "refuses %j",
    (stage) => {
      expect(() => parseStage(stage)).toThrow(InvalidStageError);
    },
  );
});

describe("tierOf", () => {
  test("only the stage named production is production", () => {
    expect(tierOf("production")).toBe("production");
    expect(tierOf("dev")).toBe("dev");
    expect(tierOf("pr-7")).toBe("dev");
  });

  test("refuses a stage that only resembles production", () => {
    expect(() => tierOf("Production")).toThrow(InvalidStageError);
    expect(() => tierOf("prod")).toThrow(InvalidStageError);
  });
});

describe("isLongLivedStage", () => {
  test("dev and production are the long-lived stages", () => {
    expect(isLongLivedStage("dev")).toBe(true);
    expect(isLongLivedStage("production")).toBe(true);
    expect(isLongLivedStage("pr-7")).toBe(false);
  });
});

describe("physicalName", () => {
  test("dev and production keep today's names", () => {
    expect(physicalName(OSN_DB, "dev")).toBe("osn-db-dev");
    expect(physicalName(OSN_DB, "production")).toBe("osn-db-prod");
    expect(physicalName(CIRE_DB, "production")).toBe("cire-db");
  });

  test("an investigation stage extends the base", () => {
    expect(physicalName(CIRE_DB, "pr-7")).toBe("cire-db-pr-7");
  });

  test("refuses a derived name equal to a dev or production one", () => {
    expect(() => physicalName({ base: "site", dev: "site-qa", production: "site" }, "qa")).toThrow(
      /dev or production name/,
    );
  });

  test("refuses a derived name over 63 characters", () => {
    expect(() =>
      physicalName({ base: "b".repeat(50), dev: "x", production: "y" }, "investigation-12345"),
    ).toThrow(/63/);
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `bun run --cwd shared/infra test:run tests/stage.test.ts` — expected FAIL: cannot resolve `../src/stage`.

- [ ] **Step 3: Implement** `shared/infra/src/stage.ts`:

```ts
import { Data } from "effect";

/** A tier is one Cloudflare account, with its own credentials and state store. */
export type Tier = "dev" | "production";

/**
 * Stage names a stack refuses besides malformed ones. `prod`: the production
 * D1 databases are `osn-db-prod` and `zap-db-prod`, so a stage `prod` derives
 * a live production name. `staging`: `osn-db-staging` exists and
 * `osn/api/wrangler.toml` declares `[env.staging]`. `local`: the `OSN_ENV`
 * posture of `wrangler dev` (`osn/api/wrangler.toml` `[vars]`).
 */
export const RESERVED_STAGES: readonly string[] = ["prod", "staging", "local"];

export const MAX_STAGE_LENGTH = 20;

/** Cloudflare's limit on Worker script and R2 bucket names. */
export const MAX_RESOURCE_NAME_LENGTH = 63;

const STAGE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class InvalidStageError extends Data.TaggedError("InvalidStageError")<{
  readonly stage: string;
  readonly message: string;
}> {}

const invalid = (stage: string, reason: string): InvalidStageError =>
  new InvalidStageError({ stage, message: `Stage '${stage}' is not allowed: ${reason}.` });

/** Returns `stage` when a stack may run at it, and throws InvalidStageError otherwise. */
export function parseStage(stage: string): string {
  if (stage.length === 0 || stage.length > MAX_STAGE_LENGTH) {
    throw invalid(stage, `a stage is 1 to ${MAX_STAGE_LENGTH} characters`);
  }
  if (!STAGE_PATTERN.test(stage)) {
    throw invalid(
      stage,
      "use lowercase letters and digits in groups joined by single hyphens, starting with a letter",
    );
  }
  if (RESERVED_STAGES.includes(stage)) {
    throw invalid(stage, "the name is reserved because it derives or imitates a live resource name");
  }
  return stage;
}

/** `dev` and `production` are long-lived and keep today's names; any other stage is an investigation stage. */
export function isLongLivedStage(stage: string): boolean {
  const valid = parseStage(stage);
  return valid === "dev" || valid === "production";
}

/** Only the stage named exactly `production` reaches production credentials. */
export function tierOf(stage: string): Tier {
  return parseStage(stage) === "production" ? "production" : "dev";
}

/** A resource's name on dev and on production, and the base an investigation stage extends. */
export interface StageNames {
  readonly base: string;
  readonly dev: string;
  readonly production: string;
}

/** The physical name a resource takes at `stage`. */
export function physicalName(names: StageNames, stage: string): string {
  const valid = parseStage(stage);
  if (valid === "dev") return names.dev;
  if (valid === "production") return names.production;
  const derived = `${names.base}-${valid}`;
  if (derived === names.dev || derived === names.production) {
    throw invalid(stage, `it derives '${derived}', a dev or production name`);
  }
  if (derived.length > MAX_RESOURCE_NAME_LENGTH) {
    throw invalid(stage, `it derives '${derived}', longer than ${MAX_RESOURCE_NAME_LENGTH} characters`);
  }
  return derived;
}
```

- [ ] **Step 4: Run it to see it pass.** Same command; expected all PASS.

- [ ] **Step 5: Lint and commit.** `bunx --bun oxlint -c oxlintrc.json shared/infra/src/stage.ts` — expected 0 errors, 0 warnings. Then `git add shared/infra/src/stage.ts shared/infra/tests/stage.test.ts && git commit -m "Infra: stage names, tiers and physical names"`

---

### Task 3: Each tier's account credentials, and the secret inventory

**Files:**
- Create: `shared/infra/src/accounts.ts`, `shared/infra/src/secrets/inventory.ts`
- Test: `shared/infra/tests/accounts.test.ts`, `shared/infra/tests/secrets/inventory.test.ts`

**Interfaces:**
- Consumes: `Tier` (Task 2).
- Produces:
  - `accounts.ts`: `interface TierAccount { environment: Tier; accountIdSecret: string; apiTokenSecret: string }`; `TIER_ACCOUNTS` (`as const satisfies Readonly<Record<Tier, TierAccount>>`); `RETIRING_DEV_CREDENTIALS: readonly string[]`; `REPOSITORY_CREDENTIALS: readonly string[]`; `accountSecrets(tier: Tier): readonly string[]` (the tier's two credential names, sorted); `allowedCredentials(tier: Tier): readonly string[]` (other credential names the tier's Environment may hold); `forbiddenCredentials(tier: Tier): readonly string[]` (the other tier's names this tier must never hold); `knownCredentials(): readonly string[]` (every Cloudflare credential name a workflow may read).
  - `inventory.ts`: `type WorkerKey = "osn-api" | "cire-api" | "zap-api" | "cire-invites"`; `interface TierSecrets { scriptName: string | null; secrets: readonly string[]; optional: readonly string[]; forbidden: readonly string[] }` (`secrets` are required on every deploy; `optional` are declared only while their GitHub secret holds a value); `interface WorkerSecrets { worker: WorkerKey; sourceDir: string; tiers: Readonly<Record<Tier, TierSecrets>> }`; `SECRET_INVENTORY: readonly WorkerSecrets[]`; `SHARED_SECRET_VALUES: readonly { tier: Tier; name: string; workers: readonly WorkerKey[] }[]`; `DEPLOY_ENVIRONMENT: readonly string[]`; `class NoWorkerOnTierError` (`worker`, `tier`, `message`); `tierSecrets(worker: WorkerKey, tier: Tier): TierSecrets & { readonly scriptName: string }`.

- [ ] **Step 1: Write the failing tests.** `shared/infra/tests/accounts.test.ts` (Task 9 adds a second `describe` that holds the state-store workflow to this table):

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  accountSecrets,
  allowedCredentials,
  forbiddenCredentials,
  knownCredentials,
  TIER_ACCOUNTS,
} from "../src/accounts";
import type { Tier } from "../src/stage";

const TIERS: readonly Tier[] = ["dev", "production"];
const WORKFLOWS = fileURLToPath(new URL("../../../.github/workflows/", import.meta.url));
const workflowFiles = readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file));

/** The `secrets.CLOUDFLARE_*` names one workflow file reads, sorted. */
function cloudflareSecrets(file: string): string[] {
  const text = readFileSync(join(WORKFLOWS, file), "utf8");
  return [...new Set([...text.matchAll(/secrets\.(CLOUDFLARE_[A-Z0-9_]+)/g)].map((match) => match[1]))].toSorted();
}

describe("TIER_ACCOUNTS", () => {
  test("each tier's credentials live in the GitHub Environment of the same name", () => {
    for (const tier of TIERS) expect(TIER_ACCOUNTS[tier].environment).toBe(tier);
  });

  test("the two tiers share no credential name, so neither can read the other's account", () => {
    const dev = accountSecrets("dev");
    for (const name of accountSecrets("production")) expect(dev).not.toContain(name);
  });

  test("names are environment-variable shaped and returned sorted", () => {
    for (const tier of TIERS) {
      for (const names of [accountSecrets(tier), allowedCredentials(tier), forbiddenCredentials(tier)]) {
        expect(names).toEqual([...names].toSorted());
        for (const name of names) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  test("each Environment is forbidden the other tier's credentials and none of its own", () => {
    expect(forbiddenCredentials("dev")).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(forbiddenCredentials("production")).toEqual([
      "CLOUDFLARE_API_TOKEN_DEV",
      "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN",
      "CLOUDFLARE_DEV_ACCOUNT_ID",
    ]);
    for (const tier of TIERS) {
      for (const name of [...accountSecrets(tier), ...allowedCredentials(tier)]) {
        expect(forbiddenCredentials(tier)).not.toContain(name);
      }
    }
  });
});

describe("the credentials the workflows read", () => {
  test("every Cloudflare credential any workflow reads is one this module classifies", () => {
    const read = [...new Set(workflowFiles.flatMap(cloudflareSecrets))].toSorted();
    expect(read.filter((name) => !knownCredentials().includes(name))).toEqual([]);
  });

  test("production's Alchemy credentials are the ones the production release deploys with today", () => {
    expect(cloudflareSecrets("production-release.yml")).toEqual([...accountSecrets("production")]);
  });

  test("only the state-store workflow reaches the dev account", () => {
    for (const file of workflowFiles.filter((candidate) => candidate !== "alchemy-state.yml")) {
      for (const name of accountSecrets("dev")) expect(cloudflareSecrets(file), file).not.toContain(name);
    }
  });
});
```

`shared/infra/tests/secrets/inventory.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  DEPLOY_ENVIRONMENT,
  NoWorkerOnTierError,
  SECRET_INVENTORY,
  SHARED_SECRET_VALUES,
  tierSecrets,
  type WorkerKey,
} from "../../src/secrets/inventory";
import type { Tier } from "../../src/stage";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const TIERS: readonly Tier[] = ["dev", "production"];

const sources = new Map<string, string>();
/** Every source file under `dir`, concatenated. */
function sourceText(dir: string): string {
  const cached = sources.get(dir);
  if (cached !== undefined) return cached;
  const text = readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(ts|tsx|astro)$/.test(path))
    .map((path) => readFileSync(join(REPO_ROOT, dir, path), "utf8"))
    .join("\n");
  sources.set(dir, text);
  return text;
}

const reads = (dir: string, name: string): boolean => new RegExp(`\\b${name}\\b`).test(sourceText(dir));

/** osn-api refuses to serve outside local without these (osn/api/wrangler.toml secrets block; wiki/shared/production-deploy.md §3.1). */
const OSN_API_FAIL_CLOSED = [
  "OSN_JWT_PRIVATE_KEY",
  "OSN_JWT_PUBLIC_KEY",
  "OSN_PAIRWISE_SALT",
  "OSN_SESSION_IP_PEPPER",
  "OSN_TOTP_ENCRYPTION_KEY",
  "RESEND_API_KEY",
  "UPSTASH_REDIS_REST_TOKEN",
  "UPSTASH_REDIS_REST_URL",
];

const rows = SECRET_INVENTORY.flatMap((entry) =>
  TIERS.map((tier) => ({ worker: entry.worker, sourceDir: entry.sourceDir, tier, ...entry.tiers[tier] })),
);

describe("secret inventory", () => {
  test("lists each deployed Worker once", () => {
    expect(SECRET_INVENTORY.map((entry) => entry.worker).toSorted()).toEqual([
      "cire-api",
      "cire-invites",
      "osn-api",
      "zap-api",
    ]);
  });

  test("names are well formed, sorted and unique per Worker and tier", () => {
    for (const row of rows) {
      for (const list of [row.secrets, row.optional, row.forbidden]) {
        expect(list, `${row.worker} ${row.tier}`).toEqual([...new Set(list)].toSorted());
        for (const name of list) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  test("a name is required, optional or forbidden, never two of them", () => {
    for (const row of rows) {
      const all = [...row.secrets, ...row.optional, ...row.forbidden];
      expect(new Set(all).size, `${row.worker} ${row.tier}`).toBe(all.length);
    }
  });

  test("osn-api keeps the outgoing TOTP key while a rotation drains, on both tiers", () => {
    for (const tier of TIERS) {
      expect(tierSecrets("osn-api", tier).optional).toEqual(["OSN_TOTP_ENCRYPTION_KEY_PREVIOUS"]);
    }
  });

  test("a tier with no Worker declares nothing, and asking for it is refused", () => {
    for (const row of rows.filter((candidate) => candidate.scriptName === null)) {
      expect([...row.secrets, ...row.optional]).toEqual([]);
      expect(() => tierSecrets(row.worker, row.tier)).toThrow(NoWorkerOnTierError);
    }
  });

  test("every declared secret is read by its Worker's code", () => {
    for (const row of rows) {
      for (const name of [...row.secrets, ...row.optional]) {
        expect(reads(row.sourceDir, name), `${row.worker} ${row.tier} ${name}`).toBe(true);
      }
    }
  });

  test("osn-api declares every secret it fails closed without, on both tiers", () => {
    for (const tier of TIERS) {
      expect(tierSecrets("osn-api", tier).secrets).toEqual(expect.arrayContaining(OSN_API_FAIL_CLOSED));
    }
  });

  test("cire-api declares its OIDC client secret on both tiers", () => {
    for (const tier of TIERS) expect(tierSecrets("cire-api", tier).secrets).toContain("CIRE_OIDC_CLIENT_SECRET");
  });

  test("the forbidden lists hold what the deploy preflights refuse", () => {
    expect(tierSecrets("osn-api", "production").forbidden).toContain("DEV_LOGIN_SECRET");
    for (const worker of ["osn-api", "cire-api"] as const) {
      for (const tier of TIERS) expect(tierSecrets(worker, tier).forbidden).toContain("RESEND_API_URL");
    }
  });

  test("zap-api production forbids the GrowthBook key no zap code reads, while cire-api production keeps its own", () => {
    expect(reads("zap/api/src", "GROWTHBOOK_CLIENT_KEY")).toBe(false);
    expect(tierSecrets("zap-api", "production").forbidden).toContain("GROWTHBOOK_CLIENT_KEY");
    expect(tierSecrets("cire-api", "production").secrets).toContain("GROWTHBOOK_CLIENT_KEY");
  });

  test("no name collides with what Alchemy or the deploy job sets", () => {
    for (const row of rows) {
      for (const name of [...row.secrets, ...row.optional]) {
        expect(name.startsWith("ALCHEMY_"), name).toBe(false);
        expect(name.startsWith("CLOUDFLARE_"), name).toBe(false);
        expect(name.startsWith("GITHUB_"), name).toBe(false);
        expect(DEPLOY_ENVIRONMENT, name).not.toContain(name);
      }
    }
  });

  test("a name feeds two Workers in one tier only when listed as a shared value", () => {
    const users = new Map<string, WorkerKey[]>();
    for (const row of rows) {
      for (const name of [...row.secrets, ...row.optional]) {
        const key = `${row.tier}:${name}`;
        users.set(key, [...(users.get(key) ?? []), row.worker]);
      }
    }
    const shared = [...users.entries()]
      .filter(([, workers]) => workers.length > 1)
      .map(([key, workers]) => `${key}=${workers.toSorted().join("+")}`)
      .toSorted();
    expect(shared).toEqual(
      SHARED_SECRET_VALUES.map((entry) => `${entry.tier}:${entry.name}=${entry.workers.toSorted().join("+")}`).toSorted(),
    );
  });
});
```

- [ ] **Step 2: Run them to see them fail.** `bun run --cwd shared/infra test:run tests/accounts.test.ts tests/secrets/inventory.test.ts` — expected FAIL: cannot resolve the modules.

- [ ] **Step 3: Implement** `shared/infra/src/accounts.ts`:

```ts
import type { Tier } from "./stage";

/**
 * Where one tier's Alchemy jobs find their Cloudflare account. Each tier is
 * its own account with its own state store, chosen only by the credentials a
 * job carries: the job maps `accountIdSecret` to `CLOUDFLARE_ACCOUNT_ID` and
 * `apiTokenSecret` to `CLOUDFLARE_API_TOKEN`, the two variables Alchemy reads.
 * No file holds an account id.
 */
export interface TierAccount {
  /** The GitHub Environment holding both secrets. */
  readonly environment: Tier;
  readonly accountIdSecret: string;
  readonly apiTokenSecret: string;
}

export const TIER_ACCOUNTS = {
  // A separate account from production. Its credentials take names of their
  // own, because the dev Environment's CLOUDFLARE_ACCOUNT_ID and
  // CLOUDFLARE_API_TOKEN_DEV reach the production account.
  dev: {
    environment: "dev",
    accountIdSecret: "CLOUDFLARE_DEV_ACCOUNT_ID",
    apiTokenSecret: "CLOUDFLARE_DEV_ACCOUNT_API_TOKEN",
  },
  // The account production has always run in, under the names the
  // production release jobs read.
  production: {
    environment: "production",
    accountIdSecret: "CLOUDFLARE_ACCOUNT_ID",
    apiTokenSecret: "CLOUDFLARE_API_TOKEN",
  },
} as const satisfies Readonly<Record<Tier, TierAccount>>;

/**
 * Credentials the `dev` Environment holds for the old dev tier's Wrangler
 * deploys. Both reach the production account; they are deleted with the old
 * dev tier.
 */
export const RETIRING_DEV_CREDENTIALS: readonly string[] = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN_DEV"];

/** Repository-level credentials, outside both Environments: read-only access to the production account. */
export const REPOSITORY_CREDENTIALS: readonly string[] = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN_READONLY"];

const otherTier = (tier: Tier): Tier => (tier === "dev" ? "production" : "dev");

/** The two GitHub Environment secrets that give `tier`'s jobs its account, sorted. */
export function accountSecrets(tier: Tier): readonly string[] {
  const account = TIER_ACCOUNTS[tier];
  return [account.accountIdSecret, account.apiTokenSecret].toSorted();
}

/** Credential names `tier`'s Environment may hold besides its own account's, sorted. */
export function allowedCredentials(tier: Tier): readonly string[] {
  return tier === "dev" ? RETIRING_DEV_CREDENTIALS.toSorted() : [];
}

/** Credential names `tier`'s Environment must never hold: the other tier's, where this tier does not use the name too. */
export function forbiddenCredentials(tier: Tier): readonly string[] {
  const own = new Set([...accountSecrets(tier), ...allowedCredentials(tier)]);
  const other = otherTier(tier);
  return [...new Set([...accountSecrets(other), ...allowedCredentials(other)])]
    .filter((name) => !own.has(name))
    .toSorted();
}

/** Every Cloudflare credential name a workflow may read, sorted. */
export function knownCredentials(): readonly string[] {
  return [
    ...new Set([
      ...accountSecrets("dev"),
      ...accountSecrets("production"),
      ...RETIRING_DEV_CREDENTIALS,
      ...REPOSITORY_CREDENTIALS,
    ]),
  ].toSorted();
}
```

`shared/infra/src/secrets/inventory.ts`:

```ts
import { Data } from "effect";
import { knownCredentials } from "../accounts";
import type { Tier } from "../stage";

/**
 * Every secret each deployed Worker holds, per tier. Alchemy uploads a Worker
 * with exactly the secrets its stack declares and drops the rest, so a name
 * missing here is a secret deleted by the first Alchemy deploy, and a secret
 * a Worker should start holding is a change to this file.
 *
 * The required and present optional names equal `wrangler secret list --name
 * <scriptName>` on each live Worker; `bun run --cwd shared/infra
 * secrets:check-live -- --tier <tier>` compares them and reports any
 * forbidden name a Worker still holds. Each value lives in the GitHub
 * Environment secret of the same name, in the `dev` or `production`
 * Environment.
 */
export type WorkerKey = "osn-api" | "cire-api" | "zap-api" | "cire-invites";

export interface TierSecrets {
  /** The deployed script name, or null when the tier has no Worker. */
  readonly scriptName: string | null;
  /** Sorted names declared on every deploy; a missing value fails it. */
  readonly secrets: readonly string[];
  /** Sorted names declared only while their GitHub secret holds a value. */
  readonly optional: readonly string[];
  /** Names that must never be set on this Worker on this tier. */
  readonly forbidden: readonly string[];
}

export interface WorkerSecrets {
  readonly worker: WorkerKey;
  /** The source directory whose code reads these secrets. */
  readonly sourceDir: string;
  readonly tiers: Readonly<Record<Tier, TierSecrets>>;
}

export const SECRET_INVENTORY: readonly WorkerSecrets[] = [
  {
    worker: "osn-api",
    sourceDir: "osn/api/src",
    tiers: {
      dev: {
        scriptName: "osn-api-dev",
        secrets: [
          "DEV_LOGIN_SECRET",
          "INTERNAL_SERVICE_SECRET",
          "OSN_JWT_PRIVATE_KEY",
          "OSN_JWT_PUBLIC_KEY",
          "OSN_PAIRWISE_SALT",
          "OSN_SESSION_IP_PEPPER",
          "OSN_TOTP_ENCRYPTION_KEY",
          "RESEND_API_KEY",
          "UPSTASH_REDIS_REST_TOKEN",
          "UPSTASH_REDIS_REST_URL",
        ],
        // Set only while a TOTP key rotation drains (osn/api/wrangler.toml secrets block).
        optional: ["OSN_TOTP_ENCRYPTION_KEY_PREVIOUS"],
        forbidden: ["RESEND_API_URL"],
      },
      production: {
        scriptName: "osn-api-production",
        secrets: [
          "INTERNAL_SERVICE_SECRET",
          "OSN_JWT_PRIVATE_KEY",
          "OSN_JWT_PUBLIC_KEY",
          "OSN_PAIRWISE_SALT",
          "OSN_SESSION_IP_PEPPER",
          "OSN_TOTP_ENCRYPTION_KEY",
          "RESEND_API_KEY",
          "TURNSTILE_SECRET_KEY",
          "UPSTASH_REDIS_REST_TOKEN",
          "UPSTASH_REDIS_REST_URL",
        ],
        optional: ["OSN_TOTP_ENCRYPTION_KEY_PREVIOUS"],
        forbidden: ["DEV_LOGIN_SECRET", "RESEND_API_URL"],
      },
    },
  },
  {
    worker: "cire-api",
    sourceDir: "cire/api/src",
    tiers: {
      dev: {
        scriptName: "cire-api-dev",
        secrets: [
          "CIRE_API_ARC_KEY_ID",
          "CIRE_API_ARC_PRIVATE_KEY",
          "CIRE_OIDC_CLIENT_SECRET",
          "OSN_API_URL",
          "STRIPE_PLATFORM_WEBHOOK_SECRET",
          "STRIPE_SECRET_KEY",
          "STRIPE_WEBHOOK_SECRET",
        ],
        optional: [],
        forbidden: ["RESEND_API_URL"],
      },
      production: {
        scriptName: "cire-api-production",
        secrets: [
          "CIRE_API_ARC_KEY_ID",
          "CIRE_API_ARC_PRIVATE_KEY",
          "CIRE_OIDC_CLIENT_SECRET",
          "GROWTHBOOK_CLIENT_KEY",
          "OSN_API_URL",
        ],
        optional: [],
        forbidden: ["RESEND_API_URL"],
      },
    },
  },
  {
    worker: "zap-api",
    sourceDir: "zap/api/src",
    tiers: {
      dev: { scriptName: null, secrets: [], optional: [], forbidden: [] },
      production: {
        scriptName: "zap-api-production",
        secrets: ["INTERNAL_SERVICE_SECRET"],
        optional: [],
        // No zap code reads a GrowthBook key; zap-api's first Alchemy deploy
        // deletes the live one (englishstreetventures/osn#1532).
        forbidden: ["GROWTHBOOK_CLIENT_KEY"],
      },
    },
  },
  {
    worker: "cire-invites",
    sourceDir: "cire/invites/src",
    tiers: {
      dev: { scriptName: "cire-invites-dev", secrets: [], optional: [], forbidden: [] },
      production: { scriptName: "cire-invites", secrets: [], optional: [], forbidden: [] },
    },
  },
];

/**
 * A name two Workers hold on one tier is one GitHub secret, so the next
 * Alchemy deploy gives both Workers its one value. Each such pair is listed
 * here on purpose.
 */
export const SHARED_SECRET_VALUES: readonly {
  readonly tier: Tier;
  readonly name: string;
  readonly workers: readonly WorkerKey[];
}[] = [
  // zap-api registers its ARC key at osn-api with this value, so both must hold the same one.
  { tier: "production", name: "INTERNAL_SERVICE_SECRET", workers: ["osn-api", "zap-api"] },
];

/**
 * Names a deploy job already sets in its environment or reads as a
 * credential; no Worker secret may share one.
 */
export const DEPLOY_ENVIRONMENT: readonly string[] = ["CI", "DO_NOT_TRACK", ...knownCredentials()].toSorted();

export class NoWorkerOnTierError extends Data.TaggedError("NoWorkerOnTierError")<{
  readonly worker: WorkerKey;
  readonly tier: Tier;
  readonly message: string;
}> {}

/** The inventory row for one Worker on one tier; throws when that tier has no Worker. */
export function tierSecrets(worker: WorkerKey, tier: Tier): TierSecrets & { readonly scriptName: string } {
  const entry = SECRET_INVENTORY.find((candidate) => candidate.worker === worker);
  const row = entry?.tiers[tier];
  if (row === undefined || row.scriptName === null) {
    throw new NoWorkerOnTierError({
      worker,
      tier,
      message: `${worker} has no ${tier} Worker in the secret inventory; add one before declaring it.`,
    });
  }
  return { ...row, scriptName: row.scriptName };
}
```

- [ ] **Step 4: Run them to see them pass.** Same command; expected all PASS. Then break the inventory once to see the source check bite: rename `RESEND_API_KEY` to `RESEND_API_KY` in the osn-api dev list, run, expect FAIL on `osn-api dev RESEND_API_KY` and on the fail-closed test; restore. Break the account table once: set `TIER_ACCOUNTS.dev.apiTokenSecret` to `"CLOUDFLARE_API_TOKEN_DEV"`, run, expect FAIL on "only the state-store workflow reaches the dev account" (`deploy.yml` reads that name); restore.

- [ ] **Step 5: Lint and commit.** `bunx --bun oxlint -c oxlintrc.json shared/infra/src/accounts.ts shared/infra/src/secrets/inventory.ts` — expected 0 errors, 0 warnings. Then `git add shared/infra/src/accounts.ts shared/infra/src/secrets/inventory.ts shared/infra/tests/accounts.test.ts shared/infra/tests/secrets/inventory.test.ts && git commit -m "Infra: each tier's account credentials and the secret inventory"`

---

### Task 4: `requireSecrets()`

**Files:**
- Create: `shared/infra/src/secrets/require.ts`
- Test: `shared/infra/tests/secrets/require.test.ts`

**Interfaces:**
- Consumes: `tierOf` (Task 2), `tierSecrets`, `WorkerKey` (Task 3).
- Produces: `class MissingSecretsError` (`worker`, `tier`, `missing: readonly string[]`, `malformed: readonly string[]`, `message`); `requireSecrets(input: { readonly worker: WorkerKey; readonly stage: string; readonly env: Readonly<Record<string, string | undefined>> }): Readonly<Record<string, Redacted.Redacted<string>>>`. P1 stacks call it in the stack body with `env: process.env`; Alchemy evaluates the body before any upload, so a throw stops the run first (#1506's "production refused before any resource call"). It throws for `plan` and `destroy` too (Decision 7); the production plan job runs in the `production` Environment, so it has the secrets.

- [ ] **Step 1: Write the failing test** `shared/infra/tests/secrets/require.test.ts`:

```ts
import { Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { NoWorkerOnTierError, tierSecrets, type WorkerKey } from "../../src/secrets/inventory";
import { MissingSecretsError, requireSecrets } from "../../src/secrets/require";
import { InvalidStageError, type Tier } from "../../src/stage";

const envFor = (worker: WorkerKey, tier: Tier): Record<string, string> =>
  Object.fromEntries(tierSecrets(worker, tier).secrets.map((name) => [name, `value-of-${name}`]));

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("requireSecrets", () => {
  test("returns every inventory secret for the tier, redacted", () => {
    const out = requireSecrets({ worker: "osn-api", stage: "dev", env: envFor("osn-api", "dev") });
    expect(Object.keys(out).toSorted()).toEqual([...tierSecrets("osn-api", "dev").secrets]);
    for (const value of Object.values(out)) expect(Redacted.isRedacted(value)).toBe(true);
    expect(Redacted.value(out.OSN_PAIRWISE_SALT)).toBe("value-of-OSN_PAIRWISE_SALT");
  });

  test("an investigation stage takes the dev tier's secrets", () => {
    const out = requireSecrets({ worker: "osn-api", stage: "pr-7", env: envFor("osn-api", "dev") });
    expect(Object.keys(out).toSorted()).toEqual([...tierSecrets("osn-api", "dev").secrets]);
  });

  test("production never receives a secret its tier does not declare", () => {
    const env = { ...envFor("osn-api", "production"), DEV_LOGIN_SECRET: "present-in-env" };
    const out = requireSecrets({ worker: "osn-api", stage: "production", env });
    expect(out).not.toHaveProperty("DEV_LOGIN_SECRET");
  });

  test("names every missing or empty secret in one error", () => {
    const env: Record<string, string | undefined> = { ...envFor("cire-api", "dev") };
    delete env.CIRE_OIDC_CLIENT_SECRET;
    delete env.OSN_API_URL;
    env.STRIPE_SECRET_KEY = "";
    env.STRIPE_WEBHOOK_SECRET = "   ";
    const error = thrown(() => requireSecrets({ worker: "cire-api", stage: "dev", env }));
    expect(error).toBeInstanceOf(MissingSecretsError);
    expect((error as MissingSecretsError).missing).toEqual([
      "CIRE_OIDC_CLIENT_SECRET",
      "OSN_API_URL",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ]);
  });

  test("refuses a value with surrounding whitespace, naming it but never printing it", () => {
    const env = { ...envFor("osn-api", "production"), OSN_PAIRWISE_SALT: "s3cr3t-salt-value\n" };
    const error = thrown(() => requireSecrets({ worker: "osn-api", stage: "production", env }));
    expect((error as MissingSecretsError).malformed).toEqual(["OSN_PAIRWISE_SALT"]);
    expect((error as Error).message).toContain("OSN_PAIRWISE_SALT");
    expect((error as Error).message).not.toContain("s3cr3t-salt-value");
  });

  test("no value reaches the error message", () => {
    const env: Record<string, string | undefined> = { ...envFor("osn-api", "dev") };
    delete env.RESEND_API_KEY;
    const message = (thrown(() => requireSecrets({ worker: "osn-api", stage: "dev", env })) as Error).message;
    for (const value of Object.values(env)) if (value !== undefined) expect(message).not.toContain(value);
  });

  test("one GitHub secret feeds both Workers that share it", () => {
    const env = { ...envFor("osn-api", "production"), ...envFor("zap-api", "production") };
    const osn = requireSecrets({ worker: "osn-api", stage: "production", env });
    const zap = requireSecrets({ worker: "zap-api", stage: "production", env });
    expect(Redacted.value(osn.INTERNAL_SERVICE_SECRET)).toBe(Redacted.value(zap.INTERNAL_SERVICE_SECRET));
  });

  test("refuses a tier with no Worker, and a malformed stage", () => {
    expect(() => requireSecrets({ worker: "zap-api", stage: "dev", env: {} })).toThrow(NoWorkerOnTierError);
    expect(() => requireSecrets({ worker: "osn-api", stage: "prod", env: {} })).toThrow(InvalidStageError);
  });

  test("declares an optional secret only while its GitHub secret holds a value", () => {
    const env = envFor("osn-api", "production");
    expect(requireSecrets({ worker: "osn-api", stage: "production", env })).not.toHaveProperty(
      "OSN_TOTP_ENCRYPTION_KEY_PREVIOUS",
    );
    const draining = { ...env, OSN_TOTP_ENCRYPTION_KEY_PREVIOUS: "outgoing-key" };
    const out = requireSecrets({ worker: "osn-api", stage: "production", env: draining });
    expect(Redacted.value(out.OSN_TOTP_ENCRYPTION_KEY_PREVIOUS)).toBe("outgoing-key");
  });

  test("refuses a padded optional value like a required one", () => {
    const env = { ...envFor("osn-api", "dev"), OSN_TOTP_ENCRYPTION_KEY_PREVIOUS: " outgoing-key" };
    const error = thrown(() => requireSecrets({ worker: "osn-api", stage: "dev", env }));
    expect((error as MissingSecretsError).malformed).toEqual(["OSN_TOTP_ENCRYPTION_KEY_PREVIOUS"]);
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `bun run --cwd shared/infra test:run tests/secrets/require.test.ts` — expected FAIL: cannot resolve `../../src/secrets/require`.

- [ ] **Step 3: Implement** `shared/infra/src/secrets/require.ts`:

```ts
import { Data, Redacted } from "effect";
import { tierOf, type Tier } from "../stage";
import { tierSecrets, type WorkerKey } from "./inventory";

export class MissingSecretsError extends Data.TaggedError("MissingSecretsError")<{
  readonly worker: WorkerKey;
  readonly tier: Tier;
  /** GitHub Environment secret names that are unset or blank. Never values. */
  readonly missing: readonly string[];
  /** Names whose value starts or ends with whitespace. Never values. */
  readonly malformed: readonly string[];
  readonly message: string;
}> {}

/**
 * Reads every secret the inventory declares for `worker` at `stage` from
 * `env` (the GitHub Environment secrets a deploy job passes through), and
 * throws before anything is uploaded when a required one is unset or blank,
 * or any value carries leading or trailing whitespace. An optional secret is
 * declared only when its value is present. A value is never trimmed: a pasted
 * trailing newline would otherwise reach the Worker as a different key.
 */
export function requireSecrets(input: {
  readonly worker: WorkerKey;
  readonly stage: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Readonly<Record<string, Redacted.Redacted<string>>> {
  const tier = tierOf(input.stage);
  const row = tierSecrets(input.worker, tier);
  const missing: string[] = [];
  const malformed: string[] = [];
  const present: (readonly [string, Redacted.Redacted<string>])[] = [];
  const read = (name: string, required: boolean): void => {
    const value = input.env[name];
    if (value === undefined || value.trim() === "") {
      if (required) missing.push(name);
    } else if (value !== value.trim()) {
      malformed.push(name);
    } else {
      present.push([name, Redacted.make(value)]);
    }
  };
  for (const name of row.secrets) read(name, true);
  for (const name of row.optional) read(name, false);
  if (missing.length > 0 || malformed.length > 0) {
    const parts = [
      missing.length > 0 ? `unset or blank: ${missing.join(", ")}` : "",
      malformed.length > 0 ? `leading or trailing whitespace: ${malformed.join(", ")}` : "",
    ].filter((part) => part !== "");
    throw new MissingSecretsError({
      worker: input.worker,
      tier,
      missing,
      malformed,
      message: `${input.worker} cannot deploy at stage '${input.stage}' (${tier} tier). GitHub Environment secrets ${parts.join("; ")}.`,
    });
  }
  return Object.fromEntries(present);
}
```

- [ ] **Step 4: Run it to see it pass.** Same command; expected all PASS.

- [ ] **Step 5: Lint and commit.** `bunx --bun oxlint -c oxlintrc.json shared/infra/src/secrets/require.ts` — expected 0 errors, 0 warnings. Then `git add shared/infra/src/secrets/require.ts shared/infra/tests/secrets/require.test.ts && git commit -m "Infra: requireSecrets refuses missing, blank and padded values"`

---

### Task 5: Read-only checks against live Workers and GitHub Environments

**Files:**
- Create: `shared/infra/src/secrets/compare.ts`, `shared/infra/scripts/check-live-secrets.ts`, `shared/infra/scripts/check-github-secrets.ts`
- Modify: `shared/infra/package.json` (scripts)
- Test: `shared/infra/tests/secrets/compare.test.ts`

**Interfaces:**
- Consumes: `SECRET_INVENTORY`, `WorkerKey` (Task 3); `accountSecrets`, `allowedCredentials`, `forbiddenCredentials` (Task 3); `Tier` (Task 2).
- Produces: `interface NameDiff { where: string; missing: readonly string[]; unexpected: readonly string[]; forbidden: readonly string[] }`; `diffNames(where: string, required: readonly string[], actual: readonly string[], allowed?: readonly string[], forbidden?: readonly string[]): NameDiff` (`forbidden` lists the held names the caller forbids; `unexpected` excludes `allowed` and `forbidden`); `parseWranglerSecretList(stdout: string): string[]`; `interface LiveExpectation { worker; tier; scriptName: string; required: readonly string[]; optional: readonly string[]; forbidden: readonly string[] }`; `liveExpectations(tier: Tier): LiveExpectation[]`; `liveDiff(expected: LiveExpectation, actual: readonly string[]): NameDiff`; `githubExpectations(tier: Tier): string[]`; `githubDiff(tier: Tier, actual: readonly string[]): NameDiff`; `formatDiffs(diffs: readonly NameDiff[]): string`; `parseTierArgument(argv: readonly string[]): Tier`; `accountIdFrom(env: Readonly<Record<string, string | undefined>>): string`. Package scripts `secrets:check-live`, `secrets:check-github`, each run with `-- --tier <dev|production>`.

One tier per run, because each tier is its own Cloudflare account and one credential reaches one account. `--tier` picks which Workers to expect; `CLOUDFLARE_ACCOUNT_ID`, which the live check refuses to run without, picks the account Wrangler reads, so a login that sees both accounts never falls back to a prompt or to the wrong one. Until P1 the dev Workers are the old dev tier in the production account, so both tiers' checks run against the production account's id.

- [ ] **Step 1: Write the failing test** `shared/infra/tests/secrets/compare.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  accountIdFrom,
  diffNames,
  formatDiffs,
  githubDiff,
  githubExpectations,
  liveDiff,
  liveExpectations,
  parseTierArgument,
  parseWranglerSecretList,
} from "../../src/secrets/compare";

describe("parseWranglerSecretList", () => {
  test("reads the names from `wrangler secret list --format json`", () => {
    const stdout = `[
  { "name": "INTERNAL_SERVICE_SECRET", "type": "secret_text" },
  { "name": "GROWTHBOOK_CLIENT_KEY", "type": "secret_text" }
]`;
    expect(parseWranglerSecretList(stdout)).toEqual(["GROWTHBOOK_CLIENT_KEY", "INTERNAL_SERVICE_SECRET"]);
    expect(parseWranglerSecretList("[]")).toEqual([]);
  });

  test("refuses output it cannot read rather than reporting no secrets", () => {
    expect(() => parseWranglerSecretList("⛅️ wrangler 4.149.0")).toThrow();
    expect(() => parseWranglerSecretList(`{"name":"X"}`)).toThrow(/array/);
    expect(() => parseWranglerSecretList(`[{"type":"secret_text"}]`)).toThrow(/name/);
  });
});

describe("diffNames", () => {
  test("reports missing and unexpected names, sorted", () => {
    expect(diffNames("w", ["A", "C", "B"], ["B", "D"])).toEqual({
      where: "w",
      missing: ["A", "C"],
      unexpected: ["D"],
      forbidden: [],
    });
  });

  test("an allowed optional name is neither missing when absent nor unexpected when present", () => {
    expect(diffNames("w", ["A"], ["A", "P"], ["P"])).toEqual({ where: "w", missing: [], unexpected: [], forbidden: [] });
    expect(diffNames("w", ["A"], ["A"], ["P"])).toEqual({ where: "w", missing: [], unexpected: [], forbidden: [] });
  });

  test("a held forbidden name is reported as forbidden, not as unexpected", () => {
    expect(diffNames("w", ["A"], ["A", "F"], [], ["F", "G"])).toEqual({
      where: "w",
      missing: [],
      unexpected: [],
      forbidden: ["F"],
    });
  });
});

describe("liveExpectations", () => {
  test("covers one tier's deployed Workers and skips a Worker the tier lacks", () => {
    expect(liveExpectations("dev").map((expectation) => expectation.scriptName).toSorted()).toEqual([
      "cire-api-dev",
      "cire-invites-dev",
      "osn-api-dev",
    ]);
    expect(liveExpectations("production").map((expectation) => expectation.scriptName).toSorted()).toEqual([
      "cire-api-production",
      "cire-invites",
      "osn-api-production",
      "zap-api-production",
    ]);
  });

  test("zap-api production as it is live today fails on the GrowthBook key it must not hold", () => {
    const zap = liveExpectations("production").find((expectation) => expectation.worker === "zap-api");
    if (zap === undefined) throw new Error("zap-api has no production expectation");
    expect(liveDiff(zap, ["GROWTHBOOK_CLIENT_KEY", "INTERNAL_SERVICE_SECRET"])).toEqual({
      where: "zap-api production (zap-api-production)",
      missing: [],
      unexpected: [],
      forbidden: ["GROWTHBOOK_CLIENT_KEY"],
    });
  });
});

describe("GitHub Environments", () => {
  test("expects each shared name once, and the tier's own account credentials", () => {
    expect(githubExpectations("dev")).toHaveLength(19);
    expect(githubExpectations("production")).toHaveLength(17);
    expect(githubExpectations("production").filter((name) => name === "INTERNAL_SERVICE_SECRET")).toHaveLength(1);
    expect(githubExpectations("dev")).toEqual(
      expect.arrayContaining(["CLOUDFLARE_DEV_ACCOUNT_API_TOKEN", "CLOUDFLARE_DEV_ACCOUNT_ID"]),
    );
    expect(githubExpectations("production")).toEqual(expect.arrayContaining(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]));
  });

  test("today's Environments miss every Worker secret but the two already set, and dev misses its account", () => {
    const dev = githubDiff("dev", ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN_DEV", "DEV_LOGIN_SECRET"]);
    expect(dev.missing).toHaveLength(18);
    expect(dev.missing).toEqual(expect.arrayContaining(["CLOUDFLARE_DEV_ACCOUNT_API_TOKEN", "CLOUDFLARE_DEV_ACCOUNT_ID"]));
    expect(dev.unexpected).toEqual([]);
    expect(dev.forbidden).toEqual([]);
    const production = githubDiff("production", ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "OSN_TOTP_ENCRYPTION_KEY"]);
    expect(production.missing).toHaveLength(14);
    expect(production.unexpected).toEqual([]);
    expect(production.forbidden).toEqual([]);
  });

  test("an Environment holding the other tier's credential fails", () => {
    expect(githubDiff("dev", ["CLOUDFLARE_API_TOKEN"]).forbidden).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(githubDiff("production", ["CLOUDFLARE_DEV_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN_DEV"]).forbidden).toEqual([
      "CLOUDFLARE_API_TOKEN_DEV",
      "CLOUDFLARE_DEV_ACCOUNT_ID",
    ]);
  });

  test("reports a name that is neither a Worker secret nor one of the tier's credentials", () => {
    expect(githubDiff("dev", ["SOMETHING_ELSE"]).unexpected).toEqual(["SOMETHING_ELSE"]);
    expect(githubDiff("production", ["CLOUDFLARE_API_TOKEN_READONLY"]).unexpected).toEqual(["CLOUDFLARE_API_TOKEN_READONLY"]);
  });

  test("accepts an optional secret held during a rotation", () => {
    expect(githubDiff("production", ["OSN_TOTP_ENCRYPTION_KEY_PREVIOUS"]).unexpected).toEqual([]);
  });
});

describe("formatDiffs", () => {
  test("prints names only", () => {
    expect(
      formatDiffs([
        diffNames("osn-api dev (osn-api-dev)", ["A"], ["A"]),
        diffNames("x", ["B"], ["C", "F"], [], ["F"]),
      ]),
    ).toBe("ok    osn-api dev (osn-api-dev)\nDIFF  x — missing: B — not in the inventory: C — forbidden but set: F\n");
  });
});

describe("parseTierArgument", () => {
  test("reads --tier dev or --tier production", () => {
    expect(parseTierArgument(["--tier", "dev"])).toBe("dev");
    expect(parseTierArgument(["--tier", "production"])).toBe("production");
  });

  test.each([[[]], [["--tier"]], [["--tier", "prod"]], [["dev"]]])("refuses %j", (argv) => {
    expect(() => parseTierArgument(argv)).toThrow(/--tier/);
  });
});

describe("accountIdFrom", () => {
  test("returns the account the run names", () => {
    expect(accountIdFrom({ CLOUDFLARE_ACCOUNT_ID: "an-account-id" })).toBe("an-account-id");
  });

  test.each([[{}], [{ CLOUDFLARE_ACCOUNT_ID: "" }], [{ CLOUDFLARE_ACCOUNT_ID: "  " }]])("refuses %j", (env) => {
    expect(() => accountIdFrom(env)).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `bun run --cwd shared/infra test:run tests/secrets/compare.test.ts` — expected FAIL: cannot resolve the module.

- [ ] **Step 3: Implement** `shared/infra/src/secrets/compare.ts`:

```ts
import { accountSecrets, allowedCredentials, forbiddenCredentials } from "../accounts";
import type { Tier } from "../stage";
import { SECRET_INVENTORY, type WorkerKey } from "./inventory";

export interface NameDiff {
  readonly where: string;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  /** Held names the inventory says must never be set there. */
  readonly forbidden: readonly string[];
}

/**
 * `required` names absent from `actual`; `actual` names in `forbidden`; and
 * `actual` names that are neither required, `allowed` nor forbidden.
 */
export function diffNames(
  where: string,
  required: readonly string[],
  actual: readonly string[],
  allowed: readonly string[] = [],
  forbidden: readonly string[] = [],
): NameDiff {
  const known = new Set([...required, ...allowed, ...forbidden]);
  const banned = new Set(forbidden);
  const have = new Set(actual);
  return {
    where,
    missing: required.filter((name) => !have.has(name)).toSorted(),
    unexpected: actual.filter((name) => !known.has(name)).toSorted(),
    forbidden: actual.filter((name) => banned.has(name)).toSorted(),
  };
}

/** The secret names in `wrangler secret list --format json` output; throws on anything else. */
export function parseWranglerSecretList(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("wrangler secret list did not print a JSON array");
  return parsed
    .map((entry: unknown) => {
      if (typeof entry !== "object" || entry === null || !("name" in entry) || typeof entry.name !== "string") {
        throw new Error("wrangler secret list printed an entry with no name");
      }
      return entry.name;
    })
    .toSorted();
}

export interface LiveExpectation {
  readonly worker: WorkerKey;
  readonly tier: Tier;
  readonly scriptName: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly forbidden: readonly string[];
}

/** One tier's deployed Workers and the names each must, may and must not hold. */
export function liveExpectations(tier: Tier): LiveExpectation[] {
  return SECRET_INVENTORY.flatMap((entry) => {
    const row = entry.tiers[tier];
    return row.scriptName === null
      ? []
      : [
          {
            worker: entry.worker,
            tier,
            scriptName: row.scriptName,
            required: row.secrets,
            optional: row.optional,
            forbidden: row.forbidden,
          },
        ];
  });
}

export function liveDiff(expected: LiveExpectation, actual: readonly string[]): NameDiff {
  return diffNames(
    `${expected.worker} ${expected.tier} (${expected.scriptName})`,
    expected.required,
    actual,
    expected.optional,
    expected.forbidden,
  );
}

/** Each required Worker secret name the tier's GitHub Environment must hold, once, and the tier's account credentials. */
export function githubExpectations(tier: Tier): string[] {
  return [
    ...new Set([...SECRET_INVENTORY.flatMap((entry) => entry.tiers[tier].secrets), ...accountSecrets(tier)]),
  ].toSorted();
}

/**
 * Missing required names and the other tier's credentials fail; optional
 * secrets and the credentials the tier may still hold are not unexpected.
 */
export function githubDiff(tier: Tier, actual: readonly string[]): NameDiff {
  const optional = SECRET_INVENTORY.flatMap((entry) => entry.tiers[tier].optional);
  return diffNames(
    `GitHub Environment ${tier}`,
    githubExpectations(tier),
    actual,
    [...optional, ...allowedCredentials(tier)],
    forbiddenCredentials(tier),
  );
}

export function formatDiffs(diffs: readonly NameDiff[]): string {
  return diffs
    .map((diff) => {
      if (diff.missing.length === 0 && diff.unexpected.length === 0 && diff.forbidden.length === 0) {
        return `ok    ${diff.where}\n`;
      }
      const missing = diff.missing.length > 0 ? ` — missing: ${diff.missing.join(", ")}` : "";
      const unexpected = diff.unexpected.length > 0 ? ` — not in the inventory: ${diff.unexpected.join(", ")}` : "";
      const forbidden = diff.forbidden.length > 0 ? ` — forbidden but set: ${diff.forbidden.join(", ")}` : "";
      return `DIFF  ${diff.where}${missing}${unexpected}${forbidden}\n`;
    })
    .join("");
}

/** The tier a check script runs for: `--tier dev` or `--tier production`, nothing else. */
export function parseTierArgument(argv: readonly string[]): Tier {
  const at = argv.indexOf("--tier");
  const value = at === -1 ? undefined : argv[at + 1];
  if (value === "dev" || value === "production") return value;
  throw new Error("pass --tier dev or --tier production: each tier is a separate Cloudflare account");
}

/** The account a live check reads, which the caller must name: one login can see several accounts. */
export function accountIdFrom(env: Readonly<Record<string, string | undefined>>): string {
  const id = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  if (id === "") {
    throw new Error(
      "set CLOUDFLARE_ACCOUNT_ID to the account that serves this tier's Workers; a login that sees several accounts must not pick one",
    );
  }
  return id;
}
```

- [ ] **Step 4: Run it to see it pass.** Same command; expected all PASS.

- [ ] **Step 5: Write the scripts.** `shared/infra/scripts/check-live-secrets.ts`:

```ts
#!/usr/bin/env bun
/**
 * Compares the secret inventory with the secret names each live Worker of one
 * tier holds: `CLOUDFLARE_ACCOUNT_ID=<id> bun run secrets:check-live -- --tier
 * <dev|production>`. Reads names only: `wrangler secret list` never returns a
 * value. CLOUDFLARE_ACCOUNT_ID names the account that serves the tier's
 * Workers and is required; credentials come from a `wrangler login` or
 * CLOUDFLARE_API_TOKEN. Exits 0 when every Worker matches, 1 on any
 * difference (a forbidden name a Worker holds included), 2 when the
 * arguments, the account or wrangler fail.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  accountIdFrom,
  formatDiffs,
  liveDiff,
  liveExpectations,
  parseTierArgument,
  parseWranglerSecretList,
  type NameDiff,
} from "../src/secrets/compare";
import type { Tier } from "../src/stage";

/** The repository's own Wrangler, the version the root package.json pins. */
const WRANGLER = fileURLToPath(new URL("../../../node_modules/.bin/wrangler", import.meta.url));

let tier: Tier;
try {
  tier = parseTierArgument(process.argv.slice(2));
  accountIdFrom(process.env);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const diffs: NameDiff[] = [];
for (const expected of liveExpectations(tier)) {
  const run = spawnSync(WRANGLER, ["secret", "list", "--name", expected.scriptName, "--format", "json"], {
    encoding: "utf8",
  });
  if (run.status !== 0) {
    process.stderr.write(`wrangler secret list --name ${expected.scriptName} exited ${run.status}\n${run.stderr}`);
    process.exit(2);
  }
  diffs.push(liveDiff(expected, parseWranglerSecretList(run.stdout)));
}
process.stdout.write(formatDiffs(diffs));
process.exit(
  diffs.every((diff) => diff.missing.length === 0 && diff.unexpected.length === 0 && diff.forbidden.length === 0)
    ? 0
    : 1,
);
```

`shared/infra/scripts/check-github-secrets.ts`:

```ts
#!/usr/bin/env bun
/**
 * Compares the secret inventory and the tier's account credentials with the
 * secret names in one tier's GitHub Environment:
 * `bun run secrets:check-github -- --tier <dev|production>`. Reads names
 * only. Needs a `gh` login that can list Environment secrets. Exits 0 when
 * nothing required is missing and the Environment holds none of the other
 * tier's credentials, 1 otherwise, 2 when the arguments or `gh` fail. A name
 * that is neither a Worker secret nor one of the tier's credentials is
 * printed but does not fail the check.
 */
import { spawnSync } from "node:child_process";
import { formatDiffs, githubDiff, parseTierArgument } from "../src/secrets/compare";
import type { Tier } from "../src/stage";

function gh(args: readonly string[]): string {
  const run = spawnSync("gh", args, { encoding: "utf8" });
  if (run.status !== 0) {
    process.stderr.write(`gh ${args.join(" ")} exited ${run.status}\n${run.stderr}`);
    process.exit(2);
  }
  return run.stdout;
}

let tier: Tier;
try {
  tier = parseTierArgument(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
const diff = githubDiff(
  tier,
  gh(["api", "--paginate", `repos/${repo}/environments/${tier}/secrets`, "--jq", ".secrets[].name"])
    .split("\n")
    .filter((name) => name !== ""),
);
process.stdout.write(formatDiffs([diff]));
process.exit(diff.missing.length === 0 && diff.forbidden.length === 0 ? 0 : 1);
```

Add to `shared/infra/package.json` `scripts`:

```json
"secrets:check-live": "bun run scripts/check-live-secrets.ts",
"secrets:check-github": "bun run scripts/check-github-secrets.ts"
```

- [ ] **Step 6: Run both against the real systems** (read-only: `wrangler secret list` and `gh api … /secrets` list names). Use this machine's Cloudflare login. Until P1 both tiers' Workers live in the production account: take its id from `bunx wrangler whoami` and pass it on the command line only, never into a file or a commit message (`$PROD_ACCOUNT` below stands for it).

```bash
env CLOUDFLARE_ACCOUNT_ID=$PROD_ACCOUNT bun run --cwd shared/infra secrets:check-live -- --tier dev
    # expect exit 0, three `ok` lines
env CLOUDFLARE_ACCOUNT_ID=$PROD_ACCOUNT bun run --cwd shared/infra secrets:check-live -- --tier production
    # expect exit 1 and exactly one DIFF line, the rest `ok`:
    # `DIFF  zap-api production (zap-api-production) — forbidden but set: GROWTHBOOK_CLIENT_KEY`
bun run --cwd shared/infra secrets:check-live -- --tier dev                 # expect exit 2: no CLOUDFLARE_ACCOUNT_ID
bun run --cwd shared/infra secrets:check-live                               # expect exit 2: no --tier
bun run --cwd shared/infra secrets:check-github -- --tier dev               # expect exit 1: missing 18 (until englishstreetventures/osn#1538)
bun run --cwd shared/infra secrets:check-github -- --tier production        # expect exit 1: missing 14 (until the owner fills production)
```

If no Cloudflare login is available, record `secrets:check-live` as NOT RUN with the reason; never borrow a token from a GitHub Environment to run it. Then break the live check once: remove `TURNSTILE_SECRET_KEY` from osn-api production in the inventory, run the production live check as above, expect exit 1 and `DIFF  osn-api production (osn-api-production) — not in the inventory: TURNSTILE_SECRET_KEY`; restore. Record every real output in `NEW-FEAT.md`.

- [ ] **Step 7: Lint and commit.** `bunx --bun oxlint -c oxlintrc.json shared/infra/src/secrets/compare.ts shared/infra/scripts` — expected 0 errors, 0 warnings. Then `git add shared/infra && git commit -m "Infra: read-only secret checks against live Workers and GitHub Environments"`

---

### Task 6: Worker builders

**Files:**
- Create: `shared/infra/src/worker.ts`, `shared/infra/src/removal.ts`
- Test: `shared/infra/tests/worker.test.ts`, `shared/infra/tests/removal.test.ts`

**Interfaces:**
- Consumes: `tierOf`, `isLongLivedStage` (Task 2).
- Produces:
  - `interface ApiWorkerObservability { headSamplingRate: number; redactQueryString: boolean; traces: { enabled: boolean; headSamplingRate?: number }; invocationLogs?: boolean }`
  - `interface ApiWorkerInput { name: string; stage: string; main: string; compatibility: { date: string; flags: readonly string[] }; domain: string | null; crons: readonly string[]; workersDev: boolean; vars: Readonly<Record<string, string>>; bindings: Cloudflare.WorkerBindingProps; secrets: Readonly<Record<string, Redacted.Redacted<string>>>; observability: ApiWorkerObservability }`
  - `interface SiteWorkerInput { name: string; stage: string; directory: string; domain: string | null; workersDev: boolean; htmlHandling: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none"; notFoundHandling: "none" | "404-page" | "single-page-application" }`
  - `class BindingNameClashError` (`names`, `message`); `class ProductionObservabilityError` (`worker`, `message`)
  - `apiWorkerProps(input: ApiWorkerInput): Cloudflare.WorkerProps` (throws `ProductionObservabilityError` for a production stage with `redactQueryString: false` or native traces on); `siteWorkerProps(input: SiteWorkerInput): Cloudflare.WorkerProps`
  - `type Removal = "retain" | "destroy"`; `removalFor(kind: "storage" | "worker", stage: string): Removal`; `class UnretainedResourceError` (`logicalIds`, `message`); `assertRetained(resources: readonly { LogicalId: string; RemovalPolicy: string }[]): void`

- [ ] **Step 1: Write the failing tests.** `shared/infra/tests/worker.test.ts` (fixture values from `cire/api/wrangler.toml`: compatibility lines 3 and 18, `workers_dev` line 27, dev cron line 379, dev domain line 382, dev observability lines 453-463, production observability lines 611-620):

```ts
import { Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
  apiWorkerProps,
  BindingNameClashError,
  ProductionObservabilityError,
  siteWorkerProps,
  type ApiWorkerInput,
} from "../src/worker";

const cireApiDev: ApiWorkerInput = {
  name: "cire-api-dev",
  stage: "dev",
  main: "../../cire/api/src/index.ts",
  compatibility: { date: "2025-03-01", flags: ["nodejs_compat", "nodejs_compat_populate_process_env"] },
  domain: "api.dev.cireweddings.com",
  crons: ["0 4 * * *"],
  workersDev: false,
  vars: { OSN_ENV: "dev" },
  bindings: {},
  secrets: { CIRE_OIDC_CLIENT_SECRET: Redacted.make("not-a-real-secret") },
  observability: { headSamplingRate: 1, redactQueryString: false, traces: { enabled: true, headSamplingRate: 1 } },
};

const cireApiProduction: ApiWorkerInput = {
  ...cireApiDev,
  name: "cire-api-production",
  stage: "production",
  domain: "api.cireweddings.com",
  observability: { headSamplingRate: 1, redactQueryString: true, traces: { enabled: false } },
};

describe("apiWorkerProps", () => {
  test("turns version preview URLs off on production only", () => {
    expect(apiWorkerProps(cireApiDev).workersDev).toEqual({ enabled: false, previewsEnabled: true });
    expect(apiWorkerProps({ ...cireApiDev, stage: "pr-7" }).workersDev).toEqual({ enabled: false, previewsEnabled: true });
    expect(apiWorkerProps(cireApiProduction).workersDev).toEqual({ enabled: false, previewsEnabled: false });
    expect(apiWorkerProps({ ...cireApiDev, workersDev: true }).workersDev).toEqual({ enabled: true, previewsEnabled: true });
  });

  test("keeps query strings redacted and native traces off on production", () => {
    expect(apiWorkerProps(cireApiProduction).observability).toEqual({
      enabled: true,
      headSamplingRate: 1,
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: false },
      traces: { enabled: false },
    });
    expect(() =>
      apiWorkerProps({ ...cireApiProduction, observability: { ...cireApiProduction.observability, redactQueryString: false } }),
    ).toThrow(ProductionObservabilityError);
    expect(() =>
      apiWorkerProps({ ...cireApiProduction, observability: { ...cireApiProduction.observability, traces: { enabled: true } } }),
    ).toThrow(/traces/);
  });

  test("keeps invocation logs off unless the caller turns them on", () => {
    expect(apiWorkerProps(cireApiDev).observability).toEqual({
      enabled: true,
      headSamplingRate: 1,
      redactQueryString: false,
      logs: { enabled: true, invocationLogs: false },
      traces: { enabled: true, headSamplingRate: 1 },
    });
    const on = apiWorkerProps({ ...cireApiDev, observability: { ...cireApiDev.observability, invocationLogs: true } });
    expect(on.observability?.logs).toEqual({ enabled: true, invocationLogs: true });
  });

  test("passes every var, binding and secret through env, secrets still redacted", () => {
    const env = apiWorkerProps(cireApiDev).env as Record<string, unknown>;
    expect(Object.keys(env).toSorted()).toEqual(["CIRE_OIDC_CLIENT_SECRET", "OSN_ENV"]);
    expect(Redacted.isRedacted(env.CIRE_OIDC_CLIENT_SECRET)).toBe(true);
  });

  test("refuses one name in two binding groups", () => {
    expect(() => apiWorkerProps({ ...cireApiDev, vars: { CIRE_OIDC_CLIENT_SECRET: "plain" } })).toThrow(
      BindingNameClashError,
    );
  });

  test("refuses a name Alchemy binds itself", () => {
    expect(() => apiWorkerProps({ ...cireApiDev, vars: { ALCHEMY_STAGE: "dev" } })).toThrow(/ALCHEMY_STAGE/);
  });

  test("states the custom domain, or null to detach every one", () => {
    expect(apiWorkerProps(cireApiDev).domain).toBe("api.dev.cireweddings.com");
    expect(apiWorkerProps({ ...cireApiDev, domain: null }).domain).toBeNull();
  });

  test("copies compatibility flags and crons rather than sharing the caller's arrays", () => {
    const props = apiWorkerProps(cireApiDev);
    expect(props.compatibility).toEqual({ date: "2025-03-01", flags: ["nodejs_compat", "nodejs_compat_populate_process_env"] });
    expect(props.compatibility?.flags).not.toBe(cireApiDev.compatibility.flags);
    expect(props.crons).toEqual(["0 4 * * *"]);
    expect(props.crons).not.toBe(cireApiDev.crons);
  });

  test("leaves zone routes unmanaged", () => {
    expect(apiWorkerProps(cireApiDev)).not.toHaveProperty("routes");
  });
});

describe("siteWorkerProps", () => {
  const site = {
    name: "cire-landing",
    stage: "production",
    directory: "../../cire/landing/dist",
    domain: "cireweddings.com",
    workersDev: false,
    htmlHandling: "auto-trailing-slash",
    notFoundHandling: "404-page",
  } as const;

  test("deploys assets only, with every routing choice stated", () => {
    const props = siteWorkerProps(site);
    expect(props).not.toHaveProperty("main");
    expect(props).not.toHaveProperty("env");
    expect(props.assets).toEqual({
      directory: "../../cire/landing/dist",
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "404-page",
    });
    expect(props.workersDev).toEqual({ enabled: false, previewsEnabled: false });
    expect(siteWorkerProps({ ...site, stage: "dev" }).workersDev).toEqual({ enabled: false, previewsEnabled: true });
  });

  test("keeps query strings out of logs and native traces off on every stage", () => {
    // musubi social serves the OIDC authorize screen, whose URL carries OIDC parameters.
    for (const stage of ["dev", "production", "pr-7"]) {
      expect(siteWorkerProps({ ...site, stage }).observability).toEqual({
        enabled: true,
        redactQueryString: true,
        logs: { enabled: true, invocationLogs: false },
        traces: { enabled: false },
      });
    }
  });
});
```

`shared/infra/tests/removal.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { assertRetained, removalFor, UnretainedResourceError } from "../src/removal";

describe("removalFor", () => {
  test("storage is always retained", () => {
    for (const stage of ["dev", "production", "pr-7"]) expect(removalFor("storage", stage)).toBe("retain");
  });

  test("Workers are retained on long-lived stages and destroyed with an investigation stage", () => {
    expect(removalFor("worker", "dev")).toBe("retain");
    expect(removalFor("worker", "production")).toBe("retain");
    expect(removalFor("worker", "pr-7")).toBe("destroy");
  });
});

describe("assertRetained", () => {
  test("passes when every resource is retained", () => {
    expect(() => assertRetained([{ LogicalId: "CireDb", RemovalPolicy: "retain" }])).not.toThrow();
  });

  test("names every resource that would be deleted", () => {
    let caught: unknown;
    try {
      assertRetained([
        { LogicalId: "CireDb", RemovalPolicy: "destroy" },
        { LogicalId: "CireSheets", RemovalPolicy: "retain" },
        { LogicalId: "CireApi", RemovalPolicy: "destroy" },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnretainedResourceError);
    expect((caught as UnretainedResourceError).logicalIds).toEqual(["CireDb", "CireApi"]);
    expect((caught as Error).message).toContain("CireDb, CireApi");
  });
});
```

- [ ] **Step 2: Run them to see them fail.** `bun run --cwd shared/infra test:run tests/worker.test.ts tests/removal.test.ts` — expected FAIL: modules not found.

- [ ] **Step 3: Implement** `shared/infra/src/worker.ts`:

```ts
import type * as Cloudflare from "alchemy/Cloudflare";
import { Data, type Redacted } from "effect";
import { tierOf } from "./stage";

export interface ApiWorkerObservability {
  readonly headSamplingRate: number;
  readonly redactQueryString: boolean;
  readonly traces: { readonly enabled: boolean; readonly headSamplingRate?: number };
  /** Off unless set: cire-api and cire-invites carry wedding slugs and names in request paths. */
  readonly invocationLogs?: boolean;
}

/** Every setting where Alchemy's default differs from today's Wrangler config is required. */
export interface ApiWorkerInput {
  /** The deployed script name; adoption keys on it. */
  readonly name: string;
  readonly stage: string;
  /** The entry module, relative to the stack's working directory. */
  readonly main: string;
  readonly compatibility: { readonly date: string; readonly flags: readonly string[] };
  /** The custom-domain hostname, or null to hold none. */
  readonly domain: string | null;
  readonly crons: readonly string[];
  /** Serve the stable workers.dev URL. Version preview URLs follow the tier instead. */
  readonly workersDev: boolean;
  readonly vars: Readonly<Record<string, string>>;
  readonly bindings: Cloudflare.WorkerBindingProps;
  readonly secrets: Readonly<Record<string, Redacted.Redacted<string>>>;
  readonly observability: ApiWorkerObservability;
}

export interface SiteWorkerInput {
  readonly name: string;
  readonly stage: string;
  /** The built site; Alchemy applies its `_headers` and `_redirects`. */
  readonly directory: string;
  readonly domain: string | null;
  readonly workersDev: boolean;
  readonly htmlHandling: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
  readonly notFoundHandling: "none" | "404-page" | "single-page-application";
}

export class BindingNameClashError extends Data.TaggedError("BindingNameClashError")<{
  readonly names: readonly string[];
  readonly message: string;
}> {}

export class ProductionObservabilityError extends Data.TaggedError("ProductionObservabilityError")<{
  readonly worker: string;
  readonly message: string;
}> {}

/** Alchemy binds `ALCHEMY_*` plain-text values first and skips any later env key with the same name. */
const ALCHEMY_RESERVED_PREFIX = "ALCHEMY_";

/** Names that appear in more than one group, or that Alchemy reserves. */
function clashingNames(groups: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const clashes = new Set<string>();
  for (const names of groups) {
    for (const name of names) {
      if (seen.has(name) || name.startsWith(ALCHEMY_RESERVED_PREFIX)) clashes.add(name);
      seen.add(name);
    }
  }
  return [...clashes].toSorted();
}

const previewsEnabled = (stage: string): boolean => tierOf(stage) !== "production";

/**
 * Production request paths carry ids and slugs, so production keeps query
 * strings redacted and native traces off — the rule
 * `scripts/check-trace-redaction.ts` holds today's Wrangler configs to.
 */
function checkProductionObservability(input: ApiWorkerInput): void {
  if (tierOf(input.stage) !== "production") return;
  const problems = [
    input.observability.redactQueryString ? "" : "redactQueryString must be true",
    input.observability.traces.enabled ? "native traces must be off" : "",
  ].filter((problem) => problem !== "");
  if (problems.length > 0) {
    throw new ProductionObservabilityError({
      worker: input.name,
      message: `${input.name} on production: ${problems.join("; ")}.`,
    });
  }
}

export function apiWorkerProps(input: ApiWorkerInput): Cloudflare.WorkerProps {
  const clashes = clashingNames([Object.keys(input.vars), Object.keys(input.bindings), Object.keys(input.secrets)]);
  if (clashes.length > 0) {
    throw new BindingNameClashError({
      names: clashes,
      message: `Binding names used twice or reserved by Alchemy: ${clashes.join(", ")}.`,
    });
  }
  checkProductionObservability(input);
  const { observability } = input;
  return {
    name: input.name,
    main: input.main,
    compatibility: { date: input.compatibility.date, flags: [...input.compatibility.flags] },
    domain: input.domain,
    crons: [...input.crons],
    workersDev: { enabled: input.workersDev, previewsEnabled: previewsEnabled(input.stage) },
    observability: {
      enabled: true,
      headSamplingRate: observability.headSamplingRate,
      redactQueryString: observability.redactQueryString,
      logs: { enabled: true, invocationLogs: observability.invocationLogs ?? false },
      traces:
        observability.traces.headSamplingRate === undefined
          ? { enabled: observability.traces.enabled }
          : { enabled: observability.traces.enabled, headSamplingRate: observability.traces.headSamplingRate },
    },
    env: { ...input.vars, ...input.bindings, ...input.secrets },
  };
}

export function siteWorkerProps(input: SiteWorkerInput): Cloudflare.WorkerProps {
  return {
    name: input.name,
    assets: {
      directory: input.directory,
      htmlHandling: input.htmlHandling,
      notFoundHandling: input.notFoundHandling,
    },
    domain: input.domain,
    workersDev: { enabled: input.workersDev, previewsEnabled: previewsEnabled(input.stage) },
    // A site's URLs can carry parameters a user should not see logged (the
    // OIDC authorize screen's), and serving static files needs no traces.
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: false },
      traces: { enabled: false },
    },
  };
}
```

`shared/infra/src/removal.ts`:

```ts
import { Data } from "effect";
import { isLongLivedStage } from "./stage";

export type Removal = "retain" | "destroy";

/**
 * Storage is always retained. A Worker on a long-lived stage (dev, production) is retained, since
 * deleting it deletes its secrets too; an investigation stage's Workers are
 * destroyed with the stage.
 */
export function removalFor(kind: "storage" | "worker", stage: string): Removal {
  return kind === "storage" || isLongLivedStage(stage) ? "retain" : "destroy";
}

export class UnretainedResourceError extends Data.TaggedError("UnretainedResourceError")<{
  readonly logicalIds: readonly string[];
  readonly message: string;
}> {}

/**
 * Throws unless every resource given will be retained on destroy and on
 * replacement. A stack calls it at the end of its body with every resource
 * the stage must keep, so a lost `retain()` fails the plan instead of a destroy.
 */
export function assertRetained(
  resources: readonly { readonly LogicalId: string; readonly RemovalPolicy: string }[],
): void {
  const logicalIds = resources.filter((resource) => resource.RemovalPolicy !== "retain").map((resource) => resource.LogicalId);
  if (logicalIds.length > 0) {
    throw new UnretainedResourceError({
      logicalIds,
      message: `These resources would be deleted on destroy or replacement: ${logicalIds.join(", ")}.`,
    });
  }
}
```

- [ ] **Step 4: Run them to see them pass.** Same command; expected all PASS. `bun run --cwd shared/infra check` — expected exit 0: this is where a prop name or type that Alchemy beta.83 does not accept fails.

- [ ] **Step 5: Lint and commit.** `bunx --bun oxlint -c oxlintrc.json shared/infra/src/worker.ts shared/infra/src/removal.ts` — expected 0 errors, 0 warnings. Then `git add shared/infra/src/worker.ts shared/infra/src/removal.ts shared/infra/tests/worker.test.ts shared/infra/tests/removal.test.ts && git commit -m "Infra: API and site Worker props, and removal rules"`

---

### Task 7: Storage builders, Alchemy wrappers and the package entry

**Files:**
- Create: `shared/infra/src/storage.ts`, `shared/infra/src/declare.ts`, `shared/infra/src/stack.ts`
- Modify: `shared/infra/src/index.ts`
- Test: `shared/infra/tests/storage.test.ts`, `shared/infra/tests/index.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - `interface RetainedD1Input { name: string; stage: string; readReplication: "auto" | "disabled"; jurisdiction: NonNullable<Cloudflare.D1.DatabaseProps["jurisdiction"]>; locationHint: NonNullable<Cloudflare.D1.DatabaseProps["primaryLocationHint"]> | null; migrations: string | null }`
  - `interface RetainedBucketInput { name: string; stage: string; storageClass: NonNullable<Cloudflare.R2.BucketProps["storageClass"]>; jurisdiction: NonNullable<Cloudflare.R2.BucketProps["jurisdiction"]>; locationHint: NonNullable<Cloudflare.R2.BucketProps["locationHint"]> | null; publicAccess: boolean; lifecycleRules: NonNullable<Cloudflare.R2.BucketProps["lifecycleRules"]>; cors: NonNullable<Cloudflare.R2.BucketProps["cors"]>; domains: NonNullable<Cloudflare.R2.BucketProps["domains"]> }`
  - `class AdoptedLocationHintError` (`name`, `message`)
  - `retainedD1Props(input): Cloudflare.D1.DatabaseProps`; `retainedBucketProps(input): Cloudflare.R2.BucketProps` — each throws `AdoptedLocationHintError` when a production input carries a location hint: production storage is adopted, and a declared hint that differs from live replaces it. Dev and investigation stages create their storage, so a hint places it (the repository creates every D1 database with `--location oc`, `wiki/shared/production-deploy.md:1410-1414`).
  - `apiWorker(id: string, input: ApiWorkerInput)`, `siteWorker(id: string, input: SiteWorkerInput)`, `retainedD1(id: string, input: RetainedD1Input)`, `retainedBucket(id: string, input: RetainedBucketInput)` — each returns the Alchemy resource Effect with its removal policy applied.
  - `stackOptions(): { providers: …; state: … }` — the second argument's `providers` and `state` for `Alchemy.Stack(name, { ...stackOptions() }, body)`.
  - `src/index.ts` re-exports `accounts.ts` (Task 3) and every module above except `secrets/compare.ts`.

- [ ] **Step 1: Write the failing tests.** `shared/infra/tests/storage.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { AdoptedLocationHintError, retainedBucketProps, retainedD1Props } from "../src/storage";

describe("retainedD1Props", () => {
  const cireDb = {
    name: "cire-db",
    stage: "production",
    readReplication: "disabled",
    jurisdiction: "default",
    locationHint: null,
  } as const;

  test("declares only what adoption converges on production, and no creation-only setting", () => {
    expect(retainedD1Props({ ...cireDb, migrations: null })).toEqual({
      name: "cire-db",
      readReplication: { mode: "disabled" },
      jurisdiction: "default",
    });
  });

  test("refuses a location hint on production, where the database is adopted", () => {
    expect(() => retainedD1Props({ ...cireDb, locationHint: "oc", migrations: null })).toThrow(AdoptedLocationHintError);
  });

  test("places a database a dev stage creates", () => {
    expect(
      retainedD1Props({ ...cireDb, name: "cire-db-dev", stage: "dev", locationHint: "oc", migrations: "../../cire/db/migrations" }),
    ).toEqual({
      name: "cire-db-dev",
      readReplication: { mode: "disabled" },
      jurisdiction: "default",
      primaryLocationHint: "oc",
      migrations: "../../cire/db/migrations",
    });
  });

  test("adds migrations only once Alchemy is the database's migrator", () => {
    expect(retainedD1Props({ ...cireDb, migrations: "../../cire/db/migrations" })).toEqual({
      name: "cire-db",
      readReplication: { mode: "disabled" },
      jurisdiction: "default",
      migrations: "../../cire/db/migrations",
    });
  });
});

describe("retainedBucketProps", () => {
  // The rule `wrangler r2 bucket lifecycle list cire-assets` printed on 2026-10-15; 7 days in seconds.
  const multipartAbort = {
    id: "Default Multipart Abort Rule",
    enabled: true,
    prefix: "",
    abortMultipartUploadsTransition: { condition: { type: "Age" as const, maxAge: 604800 } },
  };

  test("states every setting Alchemy would otherwise clear, and never empties the bucket", () => {
    expect(
      retainedBucketProps({
        name: "cire-assets",
        stage: "production",
        storageClass: "Standard",
        jurisdiction: "default",
        locationHint: null,
        publicAccess: false,
        lifecycleRules: [multipartAbort],
        cors: [],
        domains: [],
      }),
    ).toEqual({
      name: "cire-assets",
      storageClass: "Standard",
      jurisdiction: "default",
      publicAccess: false,
      lifecycleRules: [multipartAbort],
      cors: [],
      domains: [],
      forceDestroy: false,
    });
  });

  const cireSheets = {
    name: "cire-sheets",
    stage: "production",
    storageClass: "Standard",
    jurisdiction: "default",
    locationHint: null,
    publicAccess: false,
    lifecycleRules: [multipartAbort],
    cors: [],
    domains: [],
  } as const;

  test("leaves object locks unmanaged and sets no location hint on production", () => {
    const props = retainedBucketProps(cireSheets);
    expect(props).not.toHaveProperty("locks");
    expect(props).not.toHaveProperty("locationHint");
    expect(() => retainedBucketProps({ ...cireSheets, locationHint: "oc" })).toThrow(AdoptedLocationHintError);
  });

  test("places a bucket a dev stage creates", () => {
    expect(retainedBucketProps({ ...cireSheets, name: "cire-sheets-dev", stage: "dev", locationHint: "oc" })).toMatchObject({
      name: "cire-sheets-dev",
      locationHint: "oc",
      lifecycleRules: [multipartAbort],
    });
  });
});
```

`shared/infra/tests/index.test.ts`:

```ts
import { describe, expect, test } from "vitest";

describe("@shared/infra entry", () => {
  test("loads with the pinned Alchemy and exposes the building blocks", async () => {
    const infra = await import("../src/index");
    for (const name of [
      "apiWorker",
      "siteWorker",
      "retainedD1",
      "retainedBucket",
      "requireSecrets",
      "stackOptions",
      "accountSecrets",
      "assertRetained",
      "physicalName",
      "tierOf",
    ] as const) {
      expect(typeof infra[name], name).toBe("function");
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail.** `bun run --cwd shared/infra test:run tests/storage.test.ts tests/index.test.ts` — expected FAIL: `../src/storage` not found; the entry exports nothing.

- [ ] **Step 3: Implement.** `shared/infra/src/storage.ts`:

```ts
import type * as Cloudflare from "alchemy/Cloudflare";
import { Data } from "effect";
import { tierOf } from "./stage";

export class AdoptedLocationHintError extends Data.TaggedError("AdoptedLocationHintError")<{
  readonly name: string;
  readonly message: string;
}> {}

/** Production storage is adopted, so it never declares where it lives: a hint that differs from live replaces it. */
function refuseAdoptedHint(name: string, stage: string, locationHint: string | null): void {
  if (locationHint !== null && tierOf(stage) === "production") {
    throw new AdoptedLocationHintError({
      name,
      message: `${name} is adopted on production and must not declare a location hint.`,
    });
  }
}

/**
 * A long-lived D1 database: on production adopted and declared exactly as
 * live, on dev created with production's settings. `clone` and
 * `importFiles` act only at creation and are never declared.
 */
export interface RetainedD1Input {
  readonly name: string;
  readonly stage: string;
  readonly readReplication: "auto" | "disabled";
  readonly jurisdiction: NonNullable<Cloudflare.D1.DatabaseProps["jurisdiction"]>;
  /** Where a database this stage creates is placed; null on production, whose databases are adopted. */
  readonly locationHint: NonNullable<Cloudflare.D1.DatabaseProps["primaryLocationHint"]> | null;
  /** The migrations directory once Alchemy migrates this database; null while Wrangler still does. */
  readonly migrations: string | null;
}

export function retainedD1Props(input: RetainedD1Input): Cloudflare.D1.DatabaseProps {
  refuseAdoptedHint(input.name, input.stage, input.locationHint);
  const declared: Cloudflare.D1.DatabaseProps = {
    name: input.name,
    readReplication: { mode: input.readReplication },
    jurisdiction: input.jurisdiction,
  };
  const placed = input.locationHint === null ? declared : { ...declared, primaryLocationHint: input.locationHint };
  return input.migrations === null ? placed : { ...placed, migrations: input.migrations };
}

/**
 * A long-lived R2 bucket: on production adopted and declared exactly as
 * live, on dev created with production's settings. Alchemy clears lifecycle
 * rules, CORS and custom domains a declaration omits, so each is required;
 * object locks stay unmanaged.
 */
export interface RetainedBucketInput {
  readonly name: string;
  readonly stage: string;
  readonly storageClass: NonNullable<Cloudflare.R2.BucketProps["storageClass"]>;
  readonly jurisdiction: NonNullable<Cloudflare.R2.BucketProps["jurisdiction"]>;
  /** Where a bucket this stage creates is placed; null on production, whose buckets are adopted. */
  readonly locationHint: NonNullable<Cloudflare.R2.BucketProps["locationHint"]> | null;
  readonly publicAccess: boolean;
  readonly lifecycleRules: NonNullable<Cloudflare.R2.BucketProps["lifecycleRules"]>;
  readonly cors: NonNullable<Cloudflare.R2.BucketProps["cors"]>;
  readonly domains: NonNullable<Cloudflare.R2.BucketProps["domains"]>;
}

export function retainedBucketProps(input: RetainedBucketInput): Cloudflare.R2.BucketProps {
  refuseAdoptedHint(input.name, input.stage, input.locationHint);
  const declared: Cloudflare.R2.BucketProps = {
    name: input.name,
    storageClass: input.storageClass,
    jurisdiction: input.jurisdiction,
    publicAccess: input.publicAccess,
    lifecycleRules: [...input.lifecycleRules],
    cors: [...input.cors],
    domains: [...input.domains],
    forceDestroy: false,
  };
  return input.locationHint === null ? declared : { ...declared, locationHint: input.locationHint };
}
```

`shared/infra/src/declare.ts`:

```ts
import { RemovalPolicy } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { removalFor } from "./removal";
import { retainedBucketProps, retainedD1Props, type RetainedBucketInput, type RetainedD1Input } from "./storage";
import { apiWorkerProps, siteWorkerProps, type ApiWorkerInput, type SiteWorkerInput } from "./worker";

export const apiWorker = (id: string, input: ApiWorkerInput) =>
  Cloudflare.Worker(id, apiWorkerProps(input)).pipe(
    RemovalPolicy.retain(removalFor("worker", input.stage) === "retain"),
  );

export const siteWorker = (id: string, input: SiteWorkerInput) =>
  Cloudflare.Worker(id, siteWorkerProps(input)).pipe(
    RemovalPolicy.retain(removalFor("worker", input.stage) === "retain"),
  );

export const retainedD1 = (id: string, input: RetainedD1Input) =>
  Cloudflare.D1.Database(id, retainedD1Props(input)).pipe(RemovalPolicy.retain());

export const retainedBucket = (id: string, input: RetainedBucketInput) =>
  Cloudflare.R2.Bucket(id, retainedBucketProps(input)).pipe(RemovalPolicy.retain());
```

`shared/infra/src/stack.ts`:

```ts
import * as Cloudflare from "alchemy/Cloudflare";

/**
 * The providers and state store every product stack passes to `Alchemy.Stack`.
 * State lives in the account's Alchemy state store; `scripts/check-alchemy-usage.ts`
 * refuses any other state constructor in a stack file.
 */
export const stackOptions = () => ({ providers: Cloudflare.providers(), state: Cloudflare.state() });
```

`shared/infra/src/index.ts`:

```ts
export * from "./accounts";
export * from "./declare";
export * from "./removal";
export * from "./secrets/inventory";
export * from "./secrets/require";
export * from "./stack";
export * from "./stage";
export * from "./storage";
export * from "./worker";
```

- [ ] **Step 4: Run every package gate.**

```bash
bun run --cwd shared/infra test:run   # expect all PASS
bun run --cwd shared/infra check      # expect exit 0
```

The tests spell the Oceania location hint `oc`, Wrangler's spelling. If `check` shows Alchemy's D1 or R2 type spells it otherwise, use Alchemy's spelling in the tests and say so in the report; never widen the input type to `string`.

If `tests/index.test.ts` fails because importing `alchemy/Cloudflare` under Vitest reaches a missing optional peer or a runtime-only module, record the module chain in `NEW-FEAT.md` and stop: do not add a dependency or mock Alchemy to make it pass, because a product stack loads the same entry under the Alchemy CLI.

- [ ] **Step 5: Lint and commit.** `bunx --bun oxlint -c oxlintrc.json shared/infra/src` — expected 0 errors, 0 warnings. Then `git add shared/infra && git commit -m "Infra: retained storage props, Alchemy wrappers and the package entry"`

---

### Task 8: The repository guard for Alchemy use

**Files:**
- Create: `scripts/check-alchemy-usage.ts`, `scripts/tests/check-alchemy-usage.test.ts`
- Modify: `package.json` (script `check:alchemy-usage`), `.github/workflows/ci.yml` (`script-tests` job)

**Interfaces:**
- Produces: `type Finding = { where: string; problem: string }`; `checkPackageScripts(where: string, manifestText: string): Finding[]`; `checkWorkflow(where: string, yamlText: string): Finding[]`; `checkCompositeAction(where: string, yamlText: string): Finding[]`; `checkStackSource(where: string, text: string): Finding[]`; `STATE_STORE_FILE = "shared/infra/src/stack.ts"`. CLI: exit 0 clean, 1 with findings.

- [ ] **Step 1: Write the failing test** `scripts/tests/check-alchemy-usage.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { checkCompositeAction, checkPackageScripts, checkStackSource, checkWorkflow } from "../check-alchemy-usage";

const manifest = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });

describe("checkPackageScripts", () => {
  test.each([
    "DO_NOT_TRACK=1 bun alchemy state ls --backend cloudflare",
    "DO_NOT_TRACK=1 bun alchemy provider cloudflare bootstrap --worker-name alchemy-state-store",
  ])("passes %j", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toEqual([]);
  });

  test.each([
    "bun alchemy deploy --stage dev",
    "bunx alchemy@2.0.0-beta.83 deploy",
    "./node_modules/.bin/alchemy deploy",
    "alchemy --stage dev deploy",
    "alchemy ./alchemy.run.ts --stage dev",
  ])("flags %j, which runs Alchemy with telemetry on", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toHaveLength(1);
  });

  test("ignores scripts that do not run Alchemy", () => {
    expect(
      checkPackageScripts("p", manifest({ test: "bunx --bun vitest", name: "echo alchemy-state", file: "cat alchemy.run.ts" })),
    ).toEqual([]);
  });

  test.each([
    "DO_NOT_TRACK=1 bun alchemy state",
    "DO_NOT_TRACK=1 bun alchemy state read cire/dev",
    "DO_NOT_TRACK=1 bun alchemy state cat cire",
    "DO_NOT_TRACK=1 bun alchemy provider cloudflare state logs",
    "DO_NOT_TRACK=1 bun alchemy drift --stage dev --repair",
    "DO_NOT_TRACK=1 bun alchemy unsafe nuke",
    "DO_NOT_TRACK=1 bun alchemy provider cloudflare teardown --yes",
  ])("refuses %j", (script) => {
    expect(checkPackageScripts("p", manifest({ x: script }))).toHaveLength(1);
  });
});

describe("checkCompositeAction", () => {
  const action = (stepEnv: string, run: string) => `
name: a
runs:
  using: composite
  steps:
    - shell: bash
${stepEnv}
      run: ${run}
`;

  test("needs DO_NOT_TRACK on the step or the line", () => {
    expect(checkCompositeAction("a", action('      env:\n        DO_NOT_TRACK: "1"', "bunx alchemy deploy"))).toEqual([]);
    expect(checkCompositeAction("a", action("", "DO_NOT_TRACK=1 bunx alchemy deploy"))).toEqual([]);
    expect(checkCompositeAction("a", action("", "bunx alchemy deploy"))).toHaveLength(1);
  });
});

describe("checkWorkflow", () => {
  const workflow = (env: string, stepEnv: string, run: string) => `
name: t
on: workflow_dispatch
${env}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: s
${stepEnv}
        run: ${run}
`;

  test("accepts DO_NOT_TRACK at workflow, step or inline level", () => {
    expect(checkWorkflow("w", workflow('env:\n  DO_NOT_TRACK: "1"', "", "bunx alchemy deploy --stage dev"))).toEqual([]);
    expect(checkWorkflow("w", workflow("", '        env:\n          DO_NOT_TRACK: "1"', "bunx alchemy deploy"))).toEqual([]);
    expect(checkWorkflow("w", workflow("", "", "DO_NOT_TRACK=1 bunx alchemy deploy"))).toEqual([]);
  });

  test("flags an Alchemy run with telemetry on", () => {
    expect(checkWorkflow("w", workflow("", "", "bunx alchemy deploy --stage dev"))).toHaveLength(1);
  });

  test("refuses a run that prints state", () => {
    expect(checkWorkflow("w", workflow('env:\n  DO_NOT_TRACK: "1"', "", "bunx alchemy state read cire"))).toHaveLength(1);
  });
});

describe("checkStackSource", () => {
  test.each([
    "const s = Alchemy.localState();",
    "const s = inMemoryState();",
    "const s = Cloudflare.state();",
    "const s = Cloudflare.state;",
    "const s = postgresState({ url });",
    'import { state } from "alchemy/Cloudflare";',
  ])("refuses %j in a stack file", (code) => {
    expect(checkStackSource("cire/infra/alchemy.run.ts", code)).toHaveLength(1);
  });

  test("passes a stack that takes stackOptions()", () => {
    expect(checkStackSource("cire/infra/alchemy.run.ts", "Alchemy.Stack('cire', stackOptions(), body)")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail.** `bun test ./scripts/tests/check-alchemy-usage.test.ts` — expected FAIL: module not found.

- [ ] **Step 3: Implement** `scripts/check-alchemy-usage.ts`:

```ts
#!/usr/bin/env bun
/**
 * Guard: every Alchemy CLI run sends no telemetry, no committed command prints
 * or deletes Alchemy state or the state store, and no stack chooses its own
 * state store.
 *
 *  - package.json scripts: an Alchemy command starts with `DO_NOT_TRACK=1 `.
 *  - workflows: a step that runs Alchemy has `DO_NOT_TRACK: "1"` in the
 *    workflow, job or step `env`, or the inline prefix on each Alchemy line.
 *    Composite actions: on the step or the line.
 *  - all three: `alchemy state ls`/`list` is the only `state` command allowed
 *    (bare `state` opens an explorer that reads records; `provider cloudflare
 *    state logs` reads the store's logs), and never `nuke`, `drift … --repair`
 *    or `teardown`.
 *  - stack files (`*\/infra/**\/*.ts`, `*alchemy.run.ts`, tests excluded): no
 *    state constructor and no `state` import from `alchemy/Cloudflare`;
 *    `shared/infra/src/stack.ts` alone calls `Cloudflare.state()`.
 *
 * Unit tests: scripts/tests/check-alchemy-usage.test.ts. CI runs this file
 * against the committed tree in the `script-tests` job of .github/workflows/ci.yml.
 * Imports only Bun and Node built-ins.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Finding = { readonly where: string; readonly problem: string };

export const STATE_STORE_FILE = "shared/infra/src/stack.ts";

/**
 * `alchemy` run as a command: the word on its own or at the end of a path,
 * with or without `@<version>`, then whitespace and anything (a subcommand, a
 * flag or an entry file). `alchemy-state` and `alchemy.run.ts` do not match.
 */
const ALCHEMY_COMMAND = /(?:^|[\s;&|(`'"\/])alchemy(?:@\S+)?\s+\S/m;

/** The start of an Alchemy invocation inside a command line. */
const INVOCATION = String.raw`\balchemy(?:@\S+)?\s+`;

const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: new RegExp(String.raw`${INVOCATION}(?:[^\n]*?\s)?state\b(?!\s+(?:ls|list)\b)`),
    why: "only `alchemy state ls` may run; every other state command prints, reads or deletes Alchemy state",
  },
  { pattern: new RegExp(String.raw`${INVOCATION}[^\n]*\bnuke\b`), why: "deletes every resource in the account" },
  { pattern: new RegExp(String.raw`${INVOCATION}[^\n]*\bdrift\b[^\n]*--repair\b`), why: "`drift --repair` is never run" },
  { pattern: new RegExp(String.raw`${INVOCATION}[^\n]*\bteardown\b`), why: "deletes the state store" },
];

const STATE_CONSTRUCTOR =
  /\b(?:localState|inMemoryState|postgresState)\s*\(|\bCloudflare\.state\b|\bimport\s*\{[^}]*\bstate\b[^}]*\}\s*from\s*["']alchemy\/Cloudflare["']/;

function forbidden(where: string, command: string): Finding[] {
  return FORBIDDEN.filter(({ pattern }) => pattern.test(command)).map(({ why }) => ({ where, problem: why }));
}

interface Manifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

export function checkPackageScripts(where: string, manifestText: string): Finding[] {
  const manifest = JSON.parse(manifestText) as Manifest;
  const findings: Finding[] = [];
  for (const [name, value] of Object.entries(manifest.scripts ?? {})) {
    if (!ALCHEMY_COMMAND.test(value)) continue;
    const at = `${where} scripts.${name}`;
    if (!value.startsWith("DO_NOT_TRACK=1 ")) {
      findings.push({ where: at, problem: "an Alchemy command must start with DO_NOT_TRACK=1" });
    }
    findings.push(...forbidden(at, value));
  }
  return findings;
}

/** A workflow or step `env:` block; GitHub Actions values are scalars. */
type EnvBlock = Readonly<Record<string, string | number | boolean>>;

interface Step {
  readonly env?: EnvBlock;
  readonly run?: string;
}

interface Workflow {
  readonly env?: EnvBlock;
  readonly jobs?: Readonly<Record<string, { readonly env?: EnvBlock; readonly steps?: readonly Step[] }>>;
}

interface CompositeAction {
  readonly runs?: { readonly steps?: readonly Step[] };
}

const telemetryOff = (env: EnvBlock | undefined): boolean => env !== undefined && String(env.DO_NOT_TRACK) === "1";

function checkSteps(where: string, steps: readonly Step[], inheritedOff: boolean): Finding[] {
  const findings: Finding[] = [];
  for (const [index, step] of steps.entries()) {
    if (typeof step.run !== "string" || !ALCHEMY_COMMAND.test(step.run)) continue;
    const at = `${where}.steps[${index}]`;
    const inline = step.run
      .split("\n")
      .filter((line) => ALCHEMY_COMMAND.test(line))
      .every((line) => /(?:^|\s)DO_NOT_TRACK=1\s/.test(line));
    if (!(inheritedOff || telemetryOff(step.env) || inline)) {
      findings.push({ where: at, problem: 'an Alchemy step needs DO_NOT_TRACK: "1" in its env' });
    }
    findings.push(...forbidden(at, step.run));
  }
  return findings;
}

export function checkWorkflow(where: string, yamlText: string): Finding[] {
  const workflow = (Bun.YAML.parse(yamlText) ?? {}) as Workflow;
  return Object.entries(workflow.jobs ?? {}).flatMap(([jobId, job]) =>
    checkSteps(`${where} jobs.${jobId}`, job.steps ?? [], telemetryOff(workflow.env) || telemetryOff(job.env)),
  );
}

export function checkCompositeAction(where: string, yamlText: string): Finding[] {
  const action = (Bun.YAML.parse(yamlText) ?? {}) as CompositeAction;
  return checkSteps(`${where} runs`, action.runs?.steps ?? [], false);
}

export function checkStackSource(where: string, text: string): Finding[] {
  return STATE_CONSTRUCTOR.test(text)
    ? [{ where, problem: `a stack takes its state from stackOptions() (${STATE_STORE_FILE})` }]
    : [];
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const tracked = (...patterns: string[]): string[] =>
    spawnSync("git", ["ls-files", "--", ...patterns], { cwd: root, encoding: "utf8" })
      .stdout.split("\n")
      .filter((path) => path !== "");
  const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
  const findings = [
    ...tracked("package.json", "*/package.json").flatMap((path) => checkPackageScripts(path, read(path))),
    ...tracked(".github/workflows/*.yml", ".github/workflows/*.yaml").flatMap((path) => checkWorkflow(path, read(path))),
    ...tracked(".github/actions/*/action.yml", ".github/actions/*/action.yaml").flatMap((path) =>
      checkCompositeAction(path, read(path)),
    ),
    ...tracked("*/infra/*.ts", "*alchemy.run.ts")
      .filter((path) => path !== STATE_STORE_FILE && !/(?:^|\/)tests\//.test(path))
      .flatMap((path) => checkStackSource(path, read(path))),
  ];
  for (const finding of findings) process.stderr.write(`${finding.where}: ${finding.problem}\n`);
  process.stdout.write(
    findings.length === 0 ? "check-alchemy-usage: every Alchemy use passes.\n" : `check-alchemy-usage: ${findings.length} finding(s).\n`,
  );
  process.exit(findings.length === 0 ? 0 : 1);
}
```

Add to the root `package.json` `scripts`, after `check:jest-dom-markers`:

```json
"check:alchemy-usage": "bun run scripts/check-alchemy-usage.ts",
```

Add to `.github/workflows/ci.yml`, in the `script-tests` job directly after the step `Check release-age excludes are marked and bounded`:

```yaml
      # The guard's own tests run in "Test the scripts"; this runs it against
      # the committed package scripts, workflows and stack files.
      - name: Check Alchemy usage
        run: bun run check:alchemy-usage
```

- [ ] **Step 4: Run it.**

```bash
bun test ./scripts/tests/check-alchemy-usage.test.ts     # expect all PASS
bun run check:alchemy-usage                              # expect exit 0 (Task 9 adds the first Alchemy commands)
bunx --bun tsc -p scripts/tsconfig.json                  # expect exit 0
```

Break it once against the real tree: temporarily add `"x": "bun alchemy plan"` to `shared/infra/package.json`, run `bun run check:alchemy-usage`, expect exit 1 naming `shared/infra/package.json scripts.x`; remove it.

- [ ] **Step 5: Lint and commit.** `bunx --bun oxlint -c oxlintrc.json scripts/check-alchemy-usage.ts` — expected 0 errors, 0 warnings. Then `git add scripts/check-alchemy-usage.ts scripts/tests/check-alchemy-usage.test.ts package.json .github/workflows/ci.yml && git commit -m "Guard: Alchemy runs with telemetry off and never prints state"`

---

### Task 9: Bootstrap and check a tier's state store, on purpose

**Files:**
- Create: `.github/workflows/alchemy-state.yml`
- Modify: `shared/infra/package.json` (scripts `state:bootstrap`, `state:check`), `shared/infra/tests/accounts.test.ts` (a second `describe`)

**Interfaces:**
- Consumes: `@shared/infra`'s pinned Alchemy CLI (Task 1); `TIER_ACCOUNTS` (Task 3); the guard (Task 8).
- Produces: workflow `Alchemy state store` (`workflow_dispatch`, inputs `tier: dev|production`, `action: check|bootstrap`), one run step per tier, each mapping only its own tier's credential secrets to `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

- [ ] **Step 1: Add the package scripts** to `shared/infra/package.json`:

```json
"state:bootstrap": "DO_NOT_TRACK=1 bun alchemy provider cloudflare bootstrap",
"state:check": "DO_NOT_TRACK=1 bun alchemy state ls --backend cloudflare"
```

- [ ] **Step 2: Write the failing test.** Append to `shared/infra/tests/accounts.test.ts` (merge the imports into the file's existing import lines):

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKFLOW = fileURLToPath(new URL("../../../.github/workflows/alchemy-state.yml", import.meta.url));

interface WorkflowStep {
  readonly if?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly run?: string;
}

interface StateWorkflow {
  readonly env?: Readonly<Record<string, string | boolean>>;
  readonly on: { readonly workflow_dispatch: { readonly inputs: { readonly tier: { readonly options: readonly string[] } } } };
  readonly jobs: {
    readonly state: {
      readonly environment: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly steps: readonly WorkflowStep[];
    };
  };
}

/** The `${{ secrets.NAME }}` names a workflow fragment reads, sorted. Plain environment variable names do not count. */
const secretsRead = (fragment: unknown): string[] =>
  [
    ...new Set(
      [...JSON.stringify(fragment ?? {}).matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]),
    ),
  ].toSorted();

describe("the Alchemy state store workflow", () => {
  const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as StateWorkflow;
  const { steps } = workflow.jobs.state;

  test("offers exactly the two tiers and runs in the chosen tier's Environment", () => {
    expect([...workflow.on.workflow_dispatch.inputs.tier.options].toSorted()).toEqual(["dev", "production"]);
    expect(workflow.jobs.state.environment).toBe("${{ inputs.tier }}");
  });

  test("keeps Alchemy telemetry off for the whole workflow", () => {
    expect(workflow.env?.DO_NOT_TRACK).toBe("1");
  });

  test("each tier's step reads exactly that tier's credential secrets, as the variables Alchemy reads", () => {
    for (const tier of TIERS) {
      const step = steps.find((candidate) => candidate.if === `inputs.tier == '${tier}'`);
      expect(step, tier).toBeDefined();
      expect(secretsRead(step), tier).toEqual([...accountSecrets(tier)]);
      expect(step?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(`\${{ secrets.${TIER_ACCOUNTS[tier].accountIdSecret} }}`);
      expect(step?.env?.CLOUDFLARE_API_TOKEN).toBe(`\${{ secrets.${TIER_ACCOUNTS[tier].apiTokenSecret} }}`);
    }
  });

  test("no secret is read anywhere else in the workflow", () => {
    const tierSteps = new Set(TIERS.map((tier) => `inputs.tier == '${tier}'`));
    expect(secretsRead(workflow.env)).toEqual([]);
    expect(secretsRead(workflow.jobs.state.env)).toEqual([]);
    for (const [index, step] of steps.entries()) {
      if (step.if !== undefined && tierSteps.has(step.if)) continue;
      expect(secretsRead(step), `steps[${index}]`).toEqual([]);
    }
  });
});
```

Run `bun run --cwd shared/infra test:run tests/accounts.test.ts` — expected FAIL: the workflow file does not exist.

- [ ] **Step 3: Write** `.github/workflows/alchemy-state.yml`:

```yaml
name: Alchemy state store

# Bootstraps or checks one tier's Alchemy state store: the Worker
# `alchemy-state-store` on that tier's account's workers.dev, with its bearer
# token and encryption key in that account's Secrets Store. Dev and
# production are separate Cloudflare accounts, so each has its own store, and
# a run reaches only the store of the account its credentials name.
# TIER_ACCOUNTS in shared/infra/src/accounts.ts names each tier's credential
# secrets; shared/infra/tests/accounts.test.ts holds the two run steps to it.
#
#   action: bootstrap  deploys the store when absent; when it is serving,
#                      refreshes credentials and upgrades it only if its version
#                      differs from the pinned Alchemy's. The tier's token
#                      needs Secrets Store edit.
#   action: check      lists the store's top level (stack names) and writes no
#                      state; proves this tier's token reaches it. Like every
#                      CI run against the store, it uploads a temporary
#                      edge-preview Worker to read the store's bearer token.
#
# `alchemy state ls` is the only state command allowed here: state holds
# resolved resource props, and run logs on this repository are public.
# scripts/check-alchemy-usage.ts refuses every other.
on:
  workflow_dispatch:
    inputs:
      tier:
        description: Which tier's account and state store
        required: true
        type: choice
        options:
          - dev
          - production
      action:
        description: check (lists stack names, writes no state) or bootstrap
        required: true
        default: check
        type: choice
        options:
          - check
          - bootstrap

permissions:
  contents: read

concurrency:
  group: alchemy-state-store-${{ inputs.tier }}
  cancel-in-progress: false

env:
  DO_NOT_TRACK: "1"
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

jobs:
  state:
    name: ${{ inputs.action }} the ${{ inputs.tier }} state store
    runs-on: ubuntu-latest
    environment: ${{ inputs.tier }}
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version
      - name: Install dependencies
        run: bun install --frozen-lockfile
      # The dev account's credentials have names of their own: the dev
      # Environment's CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN_DEV
      # reach the production account.
      - name: Run against the dev account
        if: inputs.tier == 'dev'
        working-directory: shared/infra
        env:
          ACTION: ${{ inputs.action }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_DEV_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_DEV_ACCOUNT_API_TOKEN }}
        run: |
          set -euo pipefail
          if [ -z "$CLOUDFLARE_ACCOUNT_ID" ] || [ -z "$CLOUDFLARE_API_TOKEN" ]; then
            echo "::error::The dev Environment holds no CLOUDFLARE_DEV_ACCOUNT_ID or CLOUDFLARE_DEV_ACCOUNT_API_TOKEN, so there is no dev account to reach."
            exit 1
          fi
          if [ "$ACTION" = bootstrap ]; then
            bun run state:bootstrap
          else
            bun run state:check
          fi
      - name: Run against the production account
        if: inputs.tier == 'production'
        working-directory: shared/infra
        env:
          ACTION: ${{ inputs.action }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: |
          set -euo pipefail
          if [ -z "$CLOUDFLARE_ACCOUNT_ID" ] || [ -z "$CLOUDFLARE_API_TOKEN" ]; then
            echo "::error::The production Environment holds no CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN."
            exit 1
          fi
          if [ "$ACTION" = bootstrap ]; then
            bun run state:bootstrap
          else
            bun run state:check
          fi
```

- [ ] **Step 4: Check it.** The guard reads only files git tracks (`git ls-files`), so stage the new files first, or the guard never sees the workflow:

```bash
git add .github/workflows/alchemy-state.yml shared/infra/package.json shared/infra/tests/accounts.test.ts
bun run --cwd shared/infra test:run    # expect all PASS, the workflow describe included
bun run check:alchemy-usage            # expect exit 0; it parses every tracked workflow with Bun.YAML, so a YAML error fails it
```

Break each check once, restoring after each:
- Delete the workflow-level `DO_NOT_TRACK` and change the dev step's `bun run state:check` to `bun alchemy state ls --backend cloudflare`; run `bun run check:alchemy-usage`; expect exit 1 naming `.github/workflows/alchemy-state.yml jobs.state.steps[3]`.
- Change the dev step's token to `${{ secrets.CLOUDFLARE_API_TOKEN_DEV }}`; run the package tests; expect FAIL on "each tier's step reads exactly that tier's credential secrets".
- Add `GH: ${{ secrets.CLOUDFLARE_API_TOKEN }}` to the install step's `env`; run the package tests; expect FAIL on "no secret is read anywhere else in the workflow".

The workflow cannot run until it is on `main` (`workflow_dispatch` lists only workflows on the default branch). Nobody runs it from this branch: its runs are owner actions after merge (production) and after the dev account exists (dev).

- [ ] **Step 5: Lint and commit.** `bunx --bun oxlint -c oxlintrc.json shared/infra/tests/accounts.test.ts` — expected 0 errors. Then `git add .github/workflows/alchemy-state.yml shared/infra/package.json shared/infra/tests/accounts.test.ts && git commit -m "Infra: bootstrap and check each tier's Alchemy state store from a dispatch workflow"`

---

### Task 10: Wiki and changeset

**Files:**
- Create: `wiki/shared/infrastructure-as-code.md`, `.changeset/shared-infra-foundation.md`
- Modify: `wiki/shared/monorepo-structure.md`, `wiki/compliance/access-control.md`, `wiki/index.md`

- [ ] **Step 1: Invoke the `write-wiki` skill** before editing any page.

- [ ] **Step 2: Write `wiki/shared/infrastructure-as-code.md`** with the frontmatter fields every `wiki/shared/` page carries (`title`, `aliases`, `tags`, `related`, `last-reviewed`). Sections and the facts each must state:
  1. **What it is** — Alchemy (pinned `2.0.0-beta.83`) will deploy every Cloudflare resource from one stack per product; `@shared/infra` holds the building blocks. Today nothing deploys through it; Wrangler still deploys everything. The rollout's design is `docs/superpowers/specs/2026-10-16-alchemy-rollout-design.md` (epic englishstreetventures/osn#1490).
  2. **Accounts** — dev and production are separate Cloudflare accounts: production stays in the current account and is adopted in place; dev is built fresh in a new account (englishstreetventures/osn#1538), on a dev-only domain or `workers.dev`. `TIER_ACCOUNTS` (`shared/infra/src/accounts.ts`) names each tier's credential secrets — production `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, dev `CLOUDFLARE_DEV_ACCOUNT_ID` and `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN` — and why dev's are new names (today's dev names reach the production account). No file holds an account id.
  3. **The building blocks** — each export from Task 7's entry, one line each, with the Alchemy default it overrides (workers.dev and preview URLs on, invocation logs on, lifecycle rules, CORS and bucket domains cleared when omitted, `ALCHEMY_*` bindings injected).
  4. **Stages** — the rules from Task 2, including why `prod`, `staging` and `local` are refused, that `dev` and `production` are the long-lived stages that keep today's names, and that only `production` is the production tier: every other stage runs on the dev tier, in the dev account.
  5. **Secrets** — the inventory's location and format (required, optional and forbidden names per Worker and tier), that a Worker starts holding a new secret only through an inventory change, the same-name rule for GitHub Environment secrets and what `SHARED_SECRET_VALUES` means (one GitHub secret, so one value for every Worker that names it), that zap-api production's `GROWTHBOOK_CLIENT_KEY` is forbidden and stays live until zap-api's first Alchemy deploy deletes it (englishstreetventures/osn#1532), the two check scripts (each takes `--tier`, because one credential reaches one account) and what each needs, and how to set a value without a trailing newline: `printf '%s' "$VALUE" | gh secret set NAME --env <dev|production> --repo englishstreetventures/osn`. State that `requireSecrets()` refuses padded values rather than trimming them, and that it runs for `plan` and `destroy` as well as `deploy`. State that production values are today's (proved against live before use, englishstreetventures/osn#1537) and dev values are new for the new account. State that until a Worker deploys through Alchemy, `wrangler secret put` and `.github/workflows/set-osn-api-secret.yml` still set its live secrets, so a production value changed that way must be changed in the GitHub Environment too.
  6. **State store** — one per Cloudflare account, so dev and production state never mix; the Worker and Secrets Store names; the workflow, its `tier` and `action` inputs, and that each tier's step reads only that tier's credentials (a test holds it to `TIER_ACCOUNTS`); that `check` uploads a temporary edge-preview Worker, so each token needs Workers Scripts edit as well as Secrets Store access, and `bootstrap` needs Secrets Store edit; that state holds a copy of every deployed secret value, so a token that can read the store reads every secret on its account; that production's store is bootstrapped by the owner after the production token gains Secrets Store Edit, and dev's after englishstreetventures/osn#1538; that CI never writes state-store credentials to disk, that `--yes` on a deploy upgrades an out-of-date store, and that no committed command prints state.
  7. **Production observability** — `apiWorkerProps()` refuses unredacted query strings and native traces on production, the rule `scripts/check-trace-redaction.ts` holds the Wrangler configs to while they still deploy.
  8. **Merging infra changes** — a change under `shared/`, to `bun.lock` or to the root `package.json` redeploys every dev surface through `deploy.yml` and makes the next production release ship every surface (`scripts/deploy-surfaces.ts` `SHARED_CONTENT`).
  9. **Telemetry** — `DO_NOT_TRACK=1` on every Alchemy command; the guard and where CI runs it.
  10. **Stack layout and releases** — Decision 4 of this plan: `cire/infra`, `zap/infra`, `musubi/infra` (osn-api, musubi social, musubi landing) and `pulse/infra` (pulse landing), stack name equal to the directory, never renamed after the first deploy; the reusable `osn/infra` template is later work (englishstreetventures/osn#1539). Production releases through Alchemy will take two approvals, the plan job and then the deploy.
- [ ] **Step 3: Update `wiki/shared/monorepo-structure.md`**: add `"@shared/infra"` to the frontmatter package list (alphabetical, after `@shared/feature-flags`) and a tree line under `shared/` after `feature-flags/`: `infra/               # @shared/infra — pinned Alchemy, the Worker and storage builders, the secret inventory`.
- [ ] **Step 4: Update `wiki/compliance/access-control.md`** — after the Stripe secrets table, a section **Deploy credentials and secret copies** with rows: (1) GitHub Environment secrets `dev` and `production` — hold a copy of every Worker secret value in the inventory (by name), readable by any job that runs in that Environment; `production` jobs wait for its required reviewer; provisioned by the owner with `gh secret set`; revoked by `gh secret delete` and rotating the value at its source. (2) Cloudflare CI tokens — the production token (`CLOUDFLARE_API_TOKEN`, production account) gains Secrets Store Edit for the production state store; the dev account's token (`CLOUDFLARE_DEV_ACCOUNT_API_TOKEN`, englishstreetventures/osn#1538) reaches only the dev account; `CLOUDFLARE_API_TOKEN_DEV` gains nothing and is revoked when the old dev tier is deleted; each held only by its Environment. (3) The Alchemy state store's bearer token and encryption key — one pair per account, in that account's Secrets Store, created by the bootstrap run, removed only by `alchemy provider cloudflare teardown` (which no committed command runs). (4) Copies of every deployed Worker secret inside Alchemy state — Alchemy writes each `Redacted` prop's value into state (`State/StateEncoding.ts:62-82` in the pinned release); readable by anyone who can read that account's store bearer token, which is any token on the account with Workers Scripts edit and Secrets Store read; removed only with the resource's state. Correct the Stripe section's "unset today on every tier": `cire-api-dev` holds `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PLATFORM_WEBHOOK_SECRET` (the inventory; `wrangler secret list --name cire-api-dev`, 2026-10-15); production holds none.
- [ ] **Step 5: Add the page to `wiki/index.md`** next to the other `wiki/shared/` deploy pages.
- [ ] **Step 6: Write `.changeset/shared-infra-foundation.md`**:

```md
---
"@shared/infra": minor
---

Add `@shared/infra`: Alchemy pinned at 2.0.0-beta.83 with one Effect copy, builders for API Workers, static-assets Workers and retained D1 databases and R2 buckets, stage and naming rules, the credential names for each tier's Cloudflare account, the secret inventory for every deployed Worker and tier with `requireSecrets()`, read-only checks of the inventory against live Workers and GitHub Environments, and scripts to bootstrap and check a tier's Alchemy state store. Nothing deploys through it yet.
```

- [ ] **Step 7: Check.**

```bash
git diff --name-only "$(git merge-base origin/main HEAD)"...HEAD | bash scripts/changeset-required.sh   # expect: required
bash scripts/validate-changesets.sh                                                                     # expect: all references valid
```

- [ ] **Step 8: Commit.** `git add wiki .changeset && git commit -m "Docs: infrastructure as code page, access control and monorepo structure"`

---

### Task 11: Gates, then hand over the owner actions

- [ ] **Step 1: Run every gate and record each result line in `NEW-FEAT.md`.**

```bash
bun install --frozen-lockfile
grep -c '"effect@' bun.lock                                                    # expect 1
bun audit --audit-level=high --ignore=GHSA-vfj7-8cjw-p6xm --ignore=GHSA-ch52-4w7c-c8xp
bun run scripts/check-audit-ignores.ts
bun run check:release-age-excludes
bun run check:alchemy-usage
bun run check
bun run --cwd shared/infra test:run
bunx turbo run test --filter=@shared/infra --dry=json | grep -c 'osn/api/src'   # expect ≥1: Worker sources are hashed inputs
bun run test
bun run test:scripts
bunx --bun tsc -p scripts/tsconfig.json
bun run lint && bash scripts/guard-lint-warnings.sh
bun run fmt:check
env CLOUDFLARE_ACCOUNT_ID=$PROD_ACCOUNT bun run --cwd shared/infra secrets:check-live -- --tier dev         # expect exit 0 (old dev tier, production account)
env CLOUDFLARE_ACCOUNT_ID=$PROD_ACCOUNT bun run --cwd shared/infra secrets:check-live -- --tier production  # expect exit 1 with exactly one DIFF line, zap-api's GrowthBook key, until P3
bun run --cwd shared/infra secrets:check-github -- --tier production  # exit 1 is expected until A3
bun run --cwd shared/infra secrets:check-github -- --tier dev         # exit 1 is expected until englishstreetventures/osn#1538
git diff --name-only "$(git merge-base origin/main HEAD)"...HEAD | bash scripts/changeset-required.sh
bash scripts/validate-changesets.sh
bash scripts/lockfile-evidence.sh "$(git merge-base origin/main HEAD)" HEAD
```

No Alchemy command that writes to Cloudflare runs here: no `deploy`, no `bootstrap`, no `state:check` (it uploads an edge-preview Worker and needs a store that does not exist yet). Record each as NOT RUN with that reason.

- [ ] **Step 2: Hand the owner actions over** in the pull request body (the `write-pr` skill), each with its proof:
  - **A1** — Grant the production token (`CLOUDFLARE_API_TOKEN`) Secrets Store **Edit** on the production account. Proof: A2.
  - **A2** — After merge and A1, before P3: run **Alchemy state store** with `tier: production, action: bootstrap` (approve the Environment), then `tier: production, action: check`. Proof: two green runs; the bootstrap log reads "Deploying Cloudflare State Store 'alchemy-state-store'" (or "already exists; adopting"), and the check lists the store without error.
  - **A3** — Fill the `production` Environment's Worker secrets from the inventory with `printf '%s' "$VALUE" | gh secret set NAME --env production --repo englishstreetventures/osn`; a value the owner does not hold, or that may differ from live, goes through englishstreetventures/osn#1537 first, never a guess. Proof: `bun run --cwd shared/infra secrets:check-github -- --tier production` exits 0.
  - **Dev account** — englishstreetventures/osn#1538: the account, its domain, its token, the `dev` Environment and the dev state store. Proof is in that issue.
  - **Secret values** — englishstreetventures/osn#1537, before P1.
  - **On merge** — `deploy.yml` redeploys every dev surface through Wrangler, as for any `shared/` change, and again for the changesets "version packages" commit; the next production release ships every surface and waits for its approval as usual.

The pull request carries `Part of #1533`; the issue closes when A1–A3 have their proof.

---

## Wiki pages this work makes stale

| Page | Change | Task |
|---|---|---|
| `wiki/shared/monorepo-structure.md` | Lists every `@shared/*` package; gains `@shared/infra` | 10 |
| `wiki/compliance/access-control.md` | New copies of every Worker secret (GitHub Environments), new token permission, the dev account's token, one state store per account; corrects the Stripe tier claim | 10 |
| `wiki/index.md` | Links the new page | 10 |
| `wiki/shared/production-deploy.md` | **Not stale in P0**: production still deploys through Wrangler from `production-release.yml`; the two-approval Alchemy release is P3's change to that page | — |
| `wiki/shared/dev-environment.md` | **Not stale in P0**: dev still deploys through Wrangler in the current account; the move to the new account is P1's change to that page | — |

## Changeset

`.changeset/shared-infra-foundation.md`, `@shared/infra: minor` (Task 10). It names no `@cire/*` package. Root `package.json`, `bun.lock`, `.github/` and `scripts/` changes ride with it.

## Observability plan

P0 adds no runtime service, route or service function, so no span, metric or log call. The plan's observability choices are the defaults `apiWorker()` and `siteWorker()` set for P1 (`observability.enabled: true`, invocation logs off unless the caller turns them on, `redactQueryString` and trace settings required inputs, and on production query strings redacted and native traces off, enforced). Scripts write to stdout and stderr through `process.stdout.write`/`process.stderr.write`, print names only, and never a value.

## Tests deleted

None. P0 moves, merges and deletes no tested code.

## Definition of done

Code (the pull request): every Task 11 Step 1 gate passes, except three whose failure is expected and names only what the owner or a later phase supplies: `secrets:check-github` on each tier (names not yet set) and `secrets:check-live --tier production` (exactly one DIFF line, zap-api's `GROWTHBOOK_CLIENT_KEY`, until P3). Owner (the issue): A1–A3 proved as Task 11 Step 2 says. englishstreetventures/osn#1537 and englishstreetventures/osn#1538 block P1, not this pull request.

---

## Stress-plan findings and how each closed

### Second run — the revision for the owner's answers

One `attacker` run, read-only, on the revision (working tree over `89ec6d4ea`): 21 findings (1 high, 10 medium, 10 low). 17 fixed in the plan, the spec or the issues; 0 rejected; 4 escalated to the owner, none blocking P0. The attacker confirmed the Global Constraints copy, every expected count, every rewritten line citation, the guard's test strings, the Environments' branch policies and that no public text names a private finding. Not re-attacked: the fixes change inputs and tests inside existing tasks and add no task.

| # | Finding | Closed by |
|---|---|---|
| 1 | High — Task 9's "no other tier's secret" test matched `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`, which are also the variables every step sets, so it could never pass. | **Fixed.** The test reads only `${{ secrets.NAME }}` references: each tier's step reads exactly its tier's two names, and no other step, job `env` or workflow `env` reads any secret. |
| 2 | Medium — Task 9's guard checks ran before the workflow was staged; the guard reads only tracked files. | **Fixed.** Step 4 stages the files first and says why. |
| 3 | Medium — `TIER_ACCOUNTS: Readonly<Record<…>> = {…}` fails `anti-slop/no-known-value-widening`. | **Fixed.** `as const satisfies Readonly<Record<Tier, TierAccount>>`, the pattern at `scripts/deploy-surfaces.ts:121`. |
| 4 | Medium — pulse landing runs a Pages Function (`/api/geo`); the two landing sites have no production domain. | **Fixed** in the spec's Pages decision, P3 step 1 and a P1 check of musubi social's single-page fallback; **escalated** for the endpoint's fate (spec open question 1). |
| 5 | Medium — `--tier` did not choose the account `secrets:check-live` reads. | **Fixed.** The live check refuses to run without `CLOUDFLARE_ACCOUNT_ID` (`accountIdFrom`, tested); Step 6 and Task 11 pass the production account's id on the command line only. |
| 6 | Medium — nothing ties a stage's tier to the account a run reaches; Review Focus 6 overclaimed. | **Fixed.** Review Focus 6 states what P0 covers; the stage-against-account check is a P1 requirement in Facts later phases must handle, where the first stack and deploy job exist to carry it. |
| 7 | Medium — the storage builders could not place dev storage where production's is. | **Fixed.** `stage` and `locationHint` inputs on both builders; a hint on production throws `AdoptedLocationHintError`; tests for both. |
| 8 | Medium — Decision 7's "no plan-only mode is needed" contradicts P4's pull-request previews. | **Fixed** in Decision 7 and a P4 fact; **escalated** as spec open question 3. |
| 9 | Medium — one Alchemy job per stack ignores the per-surface jobs and Deployment records `deploy-surfaces.ts` and `release-plan.ts` depend on. | **Escalated** as spec open question 2 (P1), with a recommendation. |
| 10 | Medium — with dev created fresh, no gate rehearses adoption. | **Fixed** in the spec: zap-api is the first adoption, and osn-api waits for its clean run and no-change second deploy. |
| 11 | Medium — rollback refuses a version whose secret values differ; credentials belong only on the Alchemy step. | **Fixed.** Two spec Constraints and the gate 3 exception. |
| 12 | Low — the account tests compared constants with constants; the read-only token was unclassified. | **Fixed.** `WRANGLER_DEPLOY_CREDENTIALS` removed; the tests read every workflow's `secrets.CLOUDFLARE_*` names; `REPOSITORY_CREDENTIALS` classifies the read-only pair. |
| 13 | Low — the GitHub check accepted any credential in either Environment. | **Fixed.** `allowedCredentials`/`forbiddenCredentials` per tier; `secrets:check-github` fails on the other tier's credential; the spec's P1 cleanup deletes the `dev` Environment's `CLOUDFLARE_ACCOUNT_ID`. |
| 14 | Low — englishstreetventures/osn#1538 could not finish before P1 and missed account setup. | **Fixed** in the issue: Done when split into before-P1 and during-P1, the workers.dev subdomain and R2 and Images enablement added. |
| 15 | Low — englishstreetventures/osn#1532's body was stale. | **Fixed** in the issue body. |
| 16 | Low — the production live check stays red until P3. | **Escalated** (Owner answers, "Raised again"); meanwhile Task 5 and Task 11 expect exactly one DIFF line, so any other drift fails. |
| 17 | Low — englishstreetventures/osn#1537 missed `INTERNAL_SERVICE_SECRET` and `OSN_SESSION_IP_PEPPER`. | **Fixed** in the issue, and in the spec's P3 step 2 (rotate `INTERNAL_SERVICE_SECRET` on both Workers in one release unless proved). |
| 18 | Low — the access-control rows omitted that Alchemy state holds every secret value. | **Fixed.** Row (4) in Task 10 Step 4 and the wiki's state-store section. |
| 19 | Low — four contradictions in the spec. | **Fixed.** Layout (Wrangler configs until production databases move), P0 (production fill only), P1 (free-tier alert watches the new account), P3 step 1 wording. |
| 20 | Low — `siteWorkerProps` left query-string redaction and traces at Alchemy's defaults. | **Fixed.** Redacted and off on every stage, tested. |
| 21 | Low — a production plan in a public run summary can show account-level values. | **Fixed.** A spec Constraint and the Deploy flow: the summary carries change counts and resource names only. |

### First run

One `attacker` run, read-only, on `a4f9cfbb1` with this plan uncommitted: 15 findings (3 high, 6 medium, 6 low). 14 fixed in the plan, 0 rejected, 1 escalated to the owner (Q6, since answered: two approvals). The attacker also confirmed, against the source and live systems: every Alchemy export and type the code imports, every cited Alchemy behaviour, the inventory against `wrangler secret list` for all seven Workers, the code-read check, the test arithmetic and the relative paths. Line citations in this table are as of that run.

| # | Finding | Closed by |
|---|---|---|
| 1 | High — source code would fail `anti-slop/*` lint errors (`Record<string, unknown>`, a conditional empty spread, an accumulator returned as a `Record`). | **Fixed.** `apiWorkerProps` checks clashes over key lists and spreads the groups; `retainedD1Props` builds in two statements; `requireSecrets` returns `Object.fromEntries`; the guard uses named `Manifest`, `EnvBlock`, `Step` types. A repository-rules bullet names the rules, and every task that adds source lints its files before committing. |
| 2 | High — `@effect/platform-node-shared@4.0.4` pulls a second Effect; the overrides and test missed it. | **Fixed.** Override added; the package test now asserts `bun.lock` holds exactly one `effect@` version, and Step 6 says how to find any other key that pulls one. |
| 3 | High — the inventory could not hold `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS`, so a deploy mid-rotation would strand every TOTP enrolment; `set-osn-api-secret.yml`'s future unstated; no reverse check. | **Fixed.** An `optional` class per tier (declared only while its GitHub secret holds a value), with tests in Tasks 3–5; later-phase facts require rewriting or retiring `set-osn-api-secret.yml` and a reverse check in P1's binding-parity test, which enumerates the vars and bindings P0 has no list of. |
| 4 | Medium — "P0 deploys nothing" is false: a `shared/` change redeploys every surface. | **Fixed.** Repository rules, Facts, the wiki page and the PR's owner actions say so. |
| 5 | Medium — the spec's pre-approval production plan job has no token able to read state and no secrets, and strict `requireSecrets` blocks plan and destroy. | **Escalated as Q6; answered** (two approvals: the plan job runs in the `production` Environment). Decision 7 records that `requireSecrets` fails closed for every command; investigation-stage destroy noted under later phases. |
| 6 | Medium — `apiWorkerProps` allowed unredacted query strings and native traces on production, which `scripts/check-trace-redaction.ts` forbids. | **Fixed.** `ProductionObservabilityError` with tests (Task 6), Decision 8, wiki section, later-phases note on retiring the guard. |
| 7 | Medium — the tsconfig was not #1506's; `base.json` turns on declaration output. | **Fixed.** `declaration` and `declarationMap` off; the claim corrected. |
| 8 | Medium — Q4 said more than a public file may (`AGENTS.md`, Issues). | **Fixed.** Q4 stated the constraint and the decision only; its answer is in Owner answers. |
| 9 | Medium — `cire-dev-db-rebuild.yml` is a nightly second migrator the later-phases list omitted. | **Fixed.** In the spec's Constraints and the P1 facts. |
| 10 | Low — existing root overrides (`ws`) constrain the new tree; the block is not alphabetical. | **Fixed.** Step 6 lists each override the new tree reaches and records any forced version outside its range; the ordering claim removed. |
| 11 | Low — guard bypasses (`alchemy@ver`, `.bin/alchemy`, flags first, entry path; bare `state`, `state logs`; composite actions; destructured import). | **Fixed.** Wider command pattern, `state ls`/`list` as the only allowed state command, composite actions scanned, `Cloudflare.state` and a `state` import refused; a test for each form. |
| 12 | Low — `check` is not read-only: it uploads a temporary edge-preview Worker. | **Fixed.** Workflow comment and input, Decision 3, the Facts row and the wiki say so. |
| 13 | Low — the issue-number placeholder was never filled and the GrowthBook deferral pointed at an issue that closes first. | **Fixed.** The inventory comment links #1532, which stays open until P3's zap-api deploy. |
| 14 | Low — `SHARED_SECRET_VALUES` asserted an equality nothing can check. | **Fixed.** The comment and Decision 2 say the same-name rule makes the values equal on the next deploy. |
| 15 | Low — Review Focus 4 overstated the inventory test. | **Fixed.** Reworded to what each test covers. |
