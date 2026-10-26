# @musubi/infra

## 0.1.5

### Patch Changes

- 0a77bba: Signing out everywhere else, and revoking cire's connection, now also end the account's cire organiser sessions. After the OSN side succeeds, osn-api asks cire-api's `POST /internal/revoke-organiser-sessions` to end the sessions of every profile on the account, in the background, so the response never waits for cire. Only an account that has signed in to cire (it holds a consent row for cire's client) is sent; revoking any other app's connection leaves cire alone. A refused, redirected or failed call is an error log and an `osn.auth.cire_session.revocations` count; nothing retries it. Signing out everywhere else also deletes the account's OIDC authorization codes in flight.

  osn-api reads three new settings: `CIRE_INTERNAL_REVOKE_URL` (cire-api's origin, HTTPS or HTTP to a loopback host), `CIRE_OIDC_CLIENT_ID` (`cid_cire`) and the optional secret `CIRE_INTERNAL_REVOKE_SECRET`, at least 32 characters, which cire-api must hold too. With any of them unset or unusable, each such request logs a warning and sends nothing. The secret inventory holds the secret as optional on osn-api and cire-api on both tiers, as one shared value, at least 32 characters on dev and production. The musubi dev stack sets the URL and client id, and `bun run dev` gives osn-api the local cire-api's URL.

- Updated dependencies [7e414f3]
- Updated dependencies [0a77bba]
  - @shared/infra@0.4.0

## 0.1.4

### Patch Changes

- 355b956: Type-check with Bun's built-in checker. Each package's `check` script is now `typecheck` and runs `bun check` in place of `tsc --noEmit`, with the test tsconfigs checked the same way. Packages that still need `astro check` keep it. No source changes.
- Updated dependencies [355b956]
  - @shared/infra@0.3.2

## 0.1.3

### Patch Changes

- Updated dependencies [1222f6c]
  - @shared/infra@0.3.1

## 0.1.2

### Patch Changes

- Updated dependencies [e2eea11]
  - @shared/infra@0.3.0

## 0.1.1

### Patch Changes

- cfe1171: The consent page's context read allows 60 requests a minute per IP on every stage.

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
