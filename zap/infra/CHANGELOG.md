# @zap/infra

## 0.2.0

### Minor Changes

- b5ff9b9: The production API Workers deploy through the Alchemy stacks. The musubi stack declares osn-api and its database on production, and the new zap production stack declares zap-api and its database; each adopts the existing Worker, database and Durable Object class by name, and a release migrates the database with Wrangler before the deploy.

  - `@shared/infra`: `apiWorker()` adopts a production Worker under its own name only; production secrets stay on the Worker (`source: "worker"` in the inventory), and the patched provider keeps every live secret an upload does not name. A new live read (`readProductionLive()`, `runReadLiveCli()`) gives the plan guard each adopted resource's live settings and secret names, and checks after a deploy that no secret went. The plan guard refuses creating a database or bucket, creating an API Worker that does not exist live, unbinding a Durable Object, and a release whose Worker lacks a required secret.
  - `@musubi/infra`, `@zap/infra`: `read:live` reads what the stack's adopted resources hold live; zap gains `plan:production`, `deploy:production` and `plan:guard`.
  - `@osn/api`, `@zap/api`: no hand-deploy script; production deploys only through the release workflow.

### Patch Changes

- Updated dependencies [b5ff9b9]
  - @shared/infra@0.9.0

## 0.1.24

### Patch Changes

- Updated dependencies [630cf31]
  - @shared/infra@0.8.0

## 0.1.23

### Patch Changes

- Updated dependencies [0821963]
  - @shared/infra@0.7.6

## 0.1.22

### Patch Changes

- Updated dependencies [6c2f518]
  - @shared/infra@0.7.5

## 0.1.21

### Patch Changes

- Updated dependencies [6c209aa]
  - @shared/infra@0.7.4

## 0.1.20

### Patch Changes

- Updated dependencies [ab6810e]
  - @shared/infra@0.7.3

## 0.1.19

### Patch Changes

- Updated dependencies [df9b5d9]
  - @shared/infra@0.7.2

## 0.1.18

### Patch Changes

- c687234: Every workspace that uses Effect runs `effect` 4.1.2, with `@effect/platform-bun`,
  `@effect/platform-node`, `@effect/sql-d1`, `@effect/opentelemetry` and
  `@effect/vitest` at 4.1.2 and the root overrides for
  `@effect/platform-node-shared` and `@effect/sql-d1` with them. The stacks run
  `alchemy` and `@alchemy.run/cloudflare` 2.0.0-beta.85, which loads on Effect
  4.1 unpatched; the provider's patch, carried to beta.85, keeps the D1 import
  the stacks ran on beta.84 and the content types Wrangler uploads assets with.
  beta.85 deploys state store version 8, which beta.84 cannot use, so a tier's
  store cannot go back once it is upgraded.

  The production plan guard reads beta.85's console lines
  (`[hh:mm:ss.mmm] INFO: …`), and `messageOf()` reads no logfmt record.
  `@shared/infra`'s tests hold the AWS SDK the provider installs,
  `@distilled.cloud/aws`, to listing and aborting an R2 bucket's multipart
  uploads, and run both under Bun. `RETIRED_STAGING_HOSTS` is gone from
  `@shared/infra`, and `domainRefusals()` takes `(changes, unflip)`: a site's
  Worker gives up only its current spare host without an `unflip` naming the
  site.

- Updated dependencies [c687234]
  - @shared/infra@0.7.1

## 0.1.17

### Patch Changes

- Updated dependencies [d3b719a]
- Updated dependencies [aeab4d4]
  - @shared/infra@0.7.0

## 0.1.16

### Patch Changes

- Updated dependencies [a28e017]
  - @shared/infra@0.6.9

## 0.1.15

### Patch Changes

- f860728: Stop exporting symbols used only inside their own file, drop re-exports nothing imports, and delete declarations nothing reads. No behaviour changes.

## 0.1.14

### Patch Changes

- Updated dependencies [e87ed59]
  - @shared/infra@0.6.8

## 0.1.13

### Patch Changes

- Updated dependencies [6dbdb99]
  - @shared/infra@0.6.7

## 0.1.12

### Patch Changes

- Updated dependencies [7af11c1]
  - @shared/infra@0.6.6

## 0.1.11

### Patch Changes

- Updated dependencies [9661da5]
  - @shared/infra@0.6.5

## 0.1.10

### Patch Changes

- 0eb887f: Alchemy moves to `2.0.0-beta.84`, with its Cloudflare provider and state backend from `@alchemy.run/cloudflare` at the same release, so `state:check` loads on Effect 4.0.7 again. Each stack imports the provider from `@alchemy.run/cloudflare`; the D1 import and asset upload patch moves onto it. `state:bootstrap` runs `alchemy state bootstrap --backend cloudflare`. Every Alchemy script, the state scripts and each stack's `plan:*` and `deploy:*`, sets `CI=true`, so a run by hand takes Cloudflare credentials from the environment alone and a plan never deploys a missing state store. `@shared/infra`'s tests check that the CLI imports exactly one provider package and that the lockfile holds none of the barred Alchemy packages, and the state CLI test runs as its own task, `test:alchemy`.
- Updated dependencies [0eb887f]
  - @shared/infra@0.6.4

## 0.1.9

### Patch Changes

- ef3d36d: Dependency bumps within the caution window: `effect`, `@effect/platform-bun`,
  `@effect/platform-node`, `@effect/sql-d1` and `@effect/opentelemetry` 4.0.7
  (with the matching root overrides for `@effect/platform-node-shared`,
  `@effect/sql-d1` and `@effect/sql-sqlite-do`), `jose` 6.2.14, `astro` 7.4.4,
  `@astrojs/solid-js` 7.1.0, `@opentelemetry/*` 0.223.0 and 2.12.0,
  `@growthbook/growthbook` 1.8.0, `@solidjs/start` 2.0.6, `cropperjs` 2.3.1,
  `lucide-solid` 1.59.0, `motion` 13.5.1, `vitest` and the `@vitest/*` packages
  5.0.5 (which clears the moderate dev-server file-read advisory). The root
  overrides for `@opentelemetry/core` (`^2.12.0`) and `seroval` (`~1.6.11`, which
  clears two moderate serialisation advisories) rise with them. `wrangler` stays on 4.149.0, which
  `@cloudflare/vite-plugin` pins exactly. `solid-js` stays on 1.9.15 (see the cire
  changeset for why).
- Updated dependencies [ef3d36d]
  - @shared/infra@0.6.3

## 0.1.8

### Patch Changes

- Updated dependencies [58761b7]
  - @shared/infra@0.6.2

## 0.1.7

### Patch Changes

- Updated dependencies [403cd83]
  - @shared/infra@0.6.1

## 0.1.6

### Patch Changes

- e8d8167: The musubi stack runs on production, declaring its sites alone: musubi landing on `www.musubi.social`, and musubi social staged on `next.musubi.social` while Pages keeps `musubi.social`. `@shared/infra` gains the production sites switch (`PRODUCTION_SITE_MODES`, `PRODUCTION_HOSTS`, `PRODUCTION_STAGING_HOSTS`, `hostsFor()`), the plan guard (`parsePlan()`, `planTextFaults()`, `guardPlan()`, `runPlanGuardCli()`, which requires `--domains`, the custom domains each site Worker holds now, writes each site's added and removed hosts to its record, and refuses a Worker giving up a host other than its spare one unless `--unflip` names the site: `domainChanges()`, `domainRefusals()`), `assertProductionScope()`, and the `production-hosts` command; `plan-summary` also warns, without failing, at each fault the guard would refuse in a plan's text. `assertDevDeployTarget()` is renamed `assertDeployTarget()` and accepts the production tier; `apiWorkerProps()`, `retainedD1Props()` and `retainedBucketProps()` refuse a production resource not in `PRODUCTION_ADOPTIONS`, which is empty. The pulse and zap stacks still refuse production. `CLOUDFLARE_PAGES_DNS_TOKEN` joins the production Environment's required credentials.
- Updated dependencies [e8d8167]
  - @shared/infra@0.6.0

## 0.1.5

### Patch Changes

- Updated dependencies [b1e4140]
  - @shared/infra@0.5.0

## 0.1.4

### Patch Changes

- Updated dependencies [7e414f3]
- Updated dependencies [0a77bba]
  - @shared/infra@0.4.0

## 0.1.3

### Patch Changes

- 355b956: Type-check with Bun's built-in checker. Each package's `check` script is now `typecheck` and runs `bun check` in place of `tsc --noEmit`, with the test tsconfigs checked the same way. Packages that still need `astro check` keep it. No source changes.
- Updated dependencies [355b956]
  - @shared/infra@0.3.2

## 0.1.2

### Patch Changes

- Updated dependencies [1222f6c]
  - @shared/infra@0.3.1

## 0.1.1

### Patch Changes

- Updated dependencies [e2eea11]
  - @shared/infra@0.3.0

## 0.1.0

### Minor Changes

- 961a09e: The dev tier is built in its own Cloudflare account by three new Alchemy stacks here and the cire stack, deployed from `deploy.yml`.

  - `@shared/infra`: every dev host derived from one `DEV_DOMAIN`, a guard that refuses a stack run against the wrong account or with a `.env` file Bun would load, a migrations flattener, prebuilt Workers with assets and sites with an entry module, seed imports, the stack-to-Worker map, `plainVars` for the names a tier holds as plain vars while another holds them as secrets, the `dev-hosts` and `plan-summary` commands, a check that refuses a prebuilt site not built for the stage's hosts, and on dev a `requireSecrets` refusal of a live Stripe key or a short dev sign-in secret. `secrets:check-github` also requires the secrets only workflows read (`WORKFLOW_SECRETS`: on dev `ASTRO_KEY` and the Access service token) and, on dev, the read-only account token. `token:check` takes `--tier`, and on dev also refuses a token that can act on another account's zone, a production zone, or no `DEV_DOMAIN` zone.
  - `@musubi/infra` (osn-api, its database and seed, musubi social, musubi landing), `@zap/infra` (zap-api and its first dev database) and `@pulse/infra` (pulse landing): the stacks, with version preview URLs off on every Worker.
  - `@pulse/landing`: `/api/geo` moves into one handler shared by the Pages Function and a new Worker entry, which serves it on dev beside the assets.
  - `@osn/api`, `@osn/db`, `@zap/api`, `@zap/db`: the old dev tier's Wrangler deploy and migration paths are gone (`[env.dev]` in `osn/api/wrangler.toml`, `db:migrate:dev`, zap-api's `deploy:dev`). Production configs are unchanged.

### Patch Changes

- Updated dependencies [961a09e]
  - @shared/infra@0.2.0
