# @pulse/infra

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
