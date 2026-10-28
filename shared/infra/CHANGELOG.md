# @shared/infra

## 0.6.0

### Minor Changes

- e8d8167: The musubi stack runs on production, declaring its sites alone: musubi landing on `www.musubi.social`, and musubi social staged on `next.musubi.social` while Pages keeps `musubi.social`. `@shared/infra` gains the production sites switch (`PRODUCTION_SITE_MODES`, `PRODUCTION_HOSTS`, `PRODUCTION_STAGING_HOSTS`, `hostsFor()`), the plan guard (`parsePlan()`, `planTextFaults()`, `guardPlan()`, `runPlanGuardCli()`, which requires `--domains`, the custom domains each site Worker holds now, writes each site's added and removed hosts to its record, and refuses a Worker giving up a host other than its spare one unless `--unflip` names the site: `domainChanges()`, `domainRefusals()`), `assertProductionScope()`, and the `production-hosts` command; `plan-summary` also warns, without failing, at each fault the guard would refuse in a plan's text. `assertDevDeployTarget()` is renamed `assertDeployTarget()` and accepts the production tier; `apiWorkerProps()`, `retainedD1Props()` and `retainedBucketProps()` refuse a production resource not in `PRODUCTION_ADOPTIONS`, which is empty. The pulse and zap stacks still refuse production. `CLOUDFLARE_PAGES_DNS_TOKEN` joins the production Environment's required credentials.

## 0.5.0

### Minor Changes

- b1e4140: A prebuilt Worker uploads with Alchemy's default module rules plus `**/*.map`, and `planPrebuiltStage()` / `writePrebuiltStage()` stage a prebuilt build for that upload: every module byte for byte, and each module's source map as Wrangler's `upload_source_maps` sends it, with a refusal before anything is written for a missing or inlined map. On production, `apiWorkerProps()` now lets the guest site's Worker (`GUEST_WORKER`, cire-invites) trace, and refuses invocation logs on cire-api and cire-invites (`WEDDING_PATH_WORKERS`), whose request paths name weddings.

## 0.4.0

### Minor Changes

- 0a77bba: Signing out everywhere else, and revoking cire's connection, now also end the account's cire organiser sessions. After the OSN side succeeds, osn-api asks cire-api's `POST /internal/revoke-organiser-sessions` to end the sessions of every profile on the account, in the background, so the response never waits for cire. Only an account that has signed in to cire (it holds a consent row for cire's client) is sent; revoking any other app's connection leaves cire alone. A refused, redirected or failed call is an error log and an `osn.auth.cire_session.revocations` count; nothing retries it. Signing out everywhere else also deletes the account's OIDC authorization codes in flight.

  osn-api reads three new settings: `CIRE_INTERNAL_REVOKE_URL` (cire-api's origin, HTTPS or HTTP to a loopback host), `CIRE_OIDC_CLIENT_ID` (`cid_cire`) and the optional secret `CIRE_INTERNAL_REVOKE_SECRET`, at least 32 characters, which cire-api must hold too. With any of them unset or unusable, each such request logs a warning and sends nothing. The secret inventory holds the secret as optional on osn-api and cire-api on both tiers, as one shared value, at least 32 characters on dev and production. The musubi dev stack sets the URL and client id, and `bun run dev` gives osn-api the local cire-api's URL.

### Patch Changes

- 7e414f3: Patch alchemy's D1 import so a failed seed import reports Cloudflare's error instead of `D1 import poll missing bookmark`.

  `patches/alchemy@2.0.0-beta.83.patch` changes `Cloudflare/D1/ImportDatabase` in both `src/` (what Bun loads in a deploy) and `lib/`. Every reply — init when it has no upload URL, ingest, and each poll — is now read as wrangler reads it: a failure dies with Cloudflare's error, or with the reply when it carries none; completion ends the import, with or without a result; a reply still in progress is polled again with its bookmark one second later. An envelope with no result, or one that is not JSON, dies with its content. When Cloudflare already holds a file with the same content, init returns no upload URL and the import it starts is polled, where alchemy as shipped fails. No message carries the presigned upload URL: a failed upload reports only R2's error code and message, or the kind of error when it cannot connect.

  `shared/infra/tests/d1-import.test.ts` runs both copies against a scripted Cloudflare API and fails if the patch stops applying.

## 0.3.2

### Patch Changes

- 355b956: Type-check with Bun's built-in checker. Each package's `check` script is now `typecheck` and runs `bun check` in place of `tsc --noEmit`, with the test tsconfigs checked the same way. Packages that still need `astro check` keep it. No source changes.

## 0.3.1

### Patch Changes

- 1222f6c: The workflow tests check, through `turbo run build --dry=json`, that turbo hashes `OSN_DEPLOY_TIER` into the build of the guest site, the organiser portal and the vendor portal. The `test:repo` task also reruns when a cire package's own `turbo.json` changes.

## 0.3.0

### Minor Changes

- e2eea11: `secrets:check-github -- --tier dev` now exits 1 when the `dev` Environment holds `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN_DEV`, the two names that point at the production account. `RETIRED_DEV_CREDENTIALS` replaces `RETIRING_DEV_CREDENTIALS`, `forbiddenCredentials()` forbids those names on every tier whose own account does not use them, and `allowedCredentials()` is gone. `knownCredentials()` leaves out `CLOUDFLARE_API_TOKEN_DEV`, so a workflow that reads it fails the package's tests.

## 0.2.0

### Minor Changes

- 961a09e: The dev tier is built in its own Cloudflare account by three new Alchemy stacks here and the cire stack, deployed from `deploy.yml`.

  - `@shared/infra`: every dev host derived from one `DEV_DOMAIN`, a guard that refuses a stack run against the wrong account or with a `.env` file Bun would load, a migrations flattener, prebuilt Workers with assets and sites with an entry module, seed imports, the stack-to-Worker map, `plainVars` for the names a tier holds as plain vars while another holds them as secrets, the `dev-hosts` and `plan-summary` commands, a check that refuses a prebuilt site not built for the stage's hosts, and on dev a `requireSecrets` refusal of a live Stripe key or a short dev sign-in secret. `secrets:check-github` also requires the secrets only workflows read (`WORKFLOW_SECRETS`: on dev `ASTRO_KEY` and the Access service token) and, on dev, the read-only account token. `token:check` takes `--tier`, and on dev also refuses a token that can act on another account's zone, a production zone, or no `DEV_DOMAIN` zone.
  - `@musubi/infra` (osn-api, its database and seed, musubi social, musubi landing), `@zap/infra` (zap-api and its first dev database) and `@pulse/infra` (pulse landing): the stacks, with version preview URLs off on every Worker.
  - `@pulse/landing`: `/api/geo` moves into one handler shared by the Pages Function and a new Worker entry, which serves it on dev beside the assets.
  - `@osn/api`, `@osn/db`, `@zap/api`, `@zap/db`: the old dev tier's Wrangler deploy and migration paths are gone (`[env.dev]` in `osn/api/wrangler.toml`, `db:migrate:dev`, zap-api's `deploy:dev`). Production configs are unchanged.

## 0.1.1

### Patch Changes

- 569c73b: Dependency maintenance. The `effect` family moves from 4.0.3 to 4.0.5, a
  patch release. Audit fixes take `fast-uri` to 3.1.8, `http-cache-semantics` to
  4.3.0 and `smol-toml` to 1.9.0, and `valibot` is overridden to ^1.4.2 so the
  `@prisma/dev` tree stops pinning 1.2.0. No runtime API changes are expected
  from these bumps; the repo's typecheck and test suites pass, apart from three
  `cire/host` component tests that also fail on the base branch.

## 0.1.0

### Minor Changes

- f7a4c9f: Add `@shared/infra`: Alchemy pinned at 2.0.0-beta.83 with one Effect copy, builders for API Workers, static-assets Workers and retained D1 databases and R2 buckets, stage and naming rules, the credential names for each tier's Cloudflare account, the secret inventory for every deployed Worker and tier with `requireSecrets()`, read-only checks of the inventory against live Workers and GitHub Environments, a check that a tier's token reaches only its own account, and scripts to bootstrap and check a tier's Alchemy state store. Nothing deploys through it yet.
