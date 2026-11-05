# @musubi/infra

## 0.2.7

### Patch Changes

- Updated dependencies [6dbdb99]
  - @shared/infra@0.6.7

## 0.2.6

### Patch Changes

- Updated dependencies [7af11c1]
  - @shared/infra@0.6.6

## 0.2.5

### Patch Changes

- Updated dependencies [9661da5]
  - @shared/infra@0.6.5

## 0.2.4

### Patch Changes

- 0eb887f: Alchemy moves to `2.0.0-beta.84`, with its Cloudflare provider and state backend from `@alchemy.run/cloudflare` at the same release, so `state:check` loads on Effect 4.0.7 again. Each stack imports the provider from `@alchemy.run/cloudflare`; the D1 import and asset upload patch moves onto it. `state:bootstrap` runs `alchemy state bootstrap --backend cloudflare`. Every Alchemy script, the state scripts and each stack's `plan:*` and `deploy:*`, sets `CI=true`, so a run by hand takes Cloudflare credentials from the environment alone and a plan never deploys a missing state store. `@shared/infra`'s tests check that the CLI imports exactly one provider package and that the lockfile holds none of the barred Alchemy packages, and the state CLI test runs as its own task, `test:alchemy`.
- Updated dependencies [0eb887f]
  - @shared/infra@0.6.4

## 0.2.3

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

## 0.2.2

### Patch Changes

- Updated dependencies [58761b7]
  - @shared/infra@0.6.2

## 0.2.1

### Patch Changes

- 403cd83: osn-api keeps its short-lived shared state on a Cloudflare Durable Object instead of Upstash Redis, and the `@shared/redis` package is deleted.

  - `@shared/coordination` (new): `CoordinationStore`, a SQLite-backed Durable Object class with one object per key — `increment`, `count`, `read`, `write`, `remove` (given `{ value }`, only while that is the live value; given `{ hits }`, only that many hits off the count), `claim`, `guess` (read the value and count one guess on the same record), `take` (read the value and remove it) and `swap` (replace the value only while it is the expected one, `null` for none), each atomic on its object, with expiry checked on read and an alarm that empties the object — and a typed client with a fail-closed fixed-window limiter. The client gets every object with `locationHint: "oc"`, so objects are created in Cloudflare's Oceania region. Only `read` and `count` are retried, once. A failed call reports its kind (`overloaded`, `reset`, `retryable`, `invalid_input` or `other`) to `onError`, never its message.
  - `@osn/api`: the hour- and day-window limiters, the per-account caps, the per-account export limiter, the per-IP deletion and restore limiters, the ceremony stores, the step-up token guard and the three lockout counters run on the `COORDINATION` binding. Every one fails closed; a failed ceremony call answers 503, and the log line for a failed store call carries its kind. The graph, organisation and recommendation limiters run on two new native bindings, `RL_USER_20_60` and `RL_USER_60_60`, and the account export's per-IP guard and `GET /account/deletion-status` on `RL_AUTH_IP_30_60`. Every route factory gets the bundle's stores. A code ceremony reads its entry and counts the guess in one call, keeping the count on the entry; passkey sign-in, passkey registration and step-up by passkey read and remove their challenge in one call. A discoverable passkey sign-in's challenge carries a MAC and an expiry, so `begin` stores nothing; `challengeId` is now `options.challenge`, and a used challenge's nonce stays claimed for a minute past the challenge's life. Registration `begin` makes one `swap` on every branch, so of two begins for one address at once only one sends a code, and it sends that code after it answers, so no branch waits on the mail. Cross-device approval stores no token: it reserves a session row for device B, which counts against the session cap, and records the account and profile; the poll takes the approved entry and, in one D1 batch with the profile read, turns that row into device B's session only while the row, the account and the profile still stand, so a revocation between approval and poll holds; the poll evicts nothing. Approve and reject each replace the pending entry in one `swap`, so one decision lands. At the session cap, only the approval that lands evicts the least recently used session, after its `swap`, so a lost race or a failed store call signs no device out; every other insert of a session row evicts at the cap first. The approval that lands writes its security event beside that eviction, each run to its end, and sends its notice either way; it reads the request and the approver's default profile side by side. A poll or approval that finds the request rejected or past its expiry deletes the entry after it answers. Independent store calls on the recovery and TOTP routes run side by side, and a refused recovery code records its failure while the read that classifies the refusal runs. A TOTP check counts the attempt before it compares the code, so attempts sent at once compare at most the threshold's worth of codes in a window, and a right code takes back its own count after the answer. A recovery-code or emailed-code lockout lookup answers the failures it counted with its verdict; a success skips the reset when none were counted, and otherwise takes back those failures, a recovery code after the answer and an emailed code beside its claim. A failure or attempt counted after the success's own read stands. A used step-up token's id stays claimed for the token's life, the verifier's 30-second clock tolerance and a minute, so a token verifies once. A right code's claim and a wrong code's delete at the cap remove only the entry that code's guess read, so a code begun meanwhile keeps its entry and the old code wins nothing. Email change complete claims its entry beside its D1 preflight, before it commits, so of two right codes, each with its own step-up token, one commits; a commit that fails after the claim has spent the code. Registration complete deletes its spent entry after the answer. A registration whose code could not be sent settles the entry its `begin` wrote in one call naming it: removed when nothing was sent, held a minute when the code may still arrive. Passkey sign-in `begin`, registration `begin` and recovery-code sign-in make the same store calls on every branch, and a lockout's audit row is written after the answer. An identifier or registration address over 255 characters is refused with 400. Rotated-session records move to D1, written in the same batch as the session that replaces them; the 6-hourly sweep deletes expired ones in chunks of 500 with a 75 ms pause between two chunks, at most `OSN_ROTATED_SESSION_SWEEP_MAX_CHUNKS` chunks a run (10 when unset; staging and production set 100), and logs a warning when a run ends on a full chunk. `GET /health/coordination` writes, reads and removes a key through the store for a caller holding the `INTERNAL_SERVICE_SECRET` bearer (401 without it, 501 where it is unset), and the post-deploy smoke check asks it with that secret. The Worker's module is now `src/entry.ts`, which exports the handler and the `CoordinationStore` class. A deployed Worker without `COORDINATION`, or outside `local` without the `RL_USER_*` bindings, answers 503 on every route; a malformed `OSN_REFRESH_TOKEN_TTL` fails the boot. The Worker reads none of `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `REDIS_URL` or `REDIS_REQUIRED`, and does not depend on `@shared/redis`. The `osn.coordination.store.operations` counter is new, and so are `osn.retention.rows_deleted` and `osn.retention.cycle.duration`, one of each per sweep pass under `table`; `osn.auth.ceremony_store.entries` and `osn.auth.session.rotated_store.*` are removed.
  - `@osn/db`: a `rotated_sessions` table (migration `20261026102423_rotated_sessions`), indexed on `expires_at` and on `(account_id, family_id)`.
  - `@pulse/api`: every rate limiter is in memory, built from one budget table (`PULSE_WRITE_LIMITS`, `PULSE_IP_LIMITS` in `src/lib/rate-limit.ts`). It reads neither `REDIS_URL` nor `REDIS_REQUIRED`, and does not depend on `@shared/redis`.
  - `@shared/observability`: the `RotatedStoreAction`, `RotatedStoreResult` and `RotatedStoreBackend` metric attribute types are removed.
  - `@musubi/infra`: osn-api's dev Worker binds `COORDINATION` and the two per-user rate limits, and is bundled from `osn/api/src/entry.ts`. Dev leaves `OSN_ROTATED_SESSION_SWEEP_MAX_CHUNKS` unset, as the parity and reads checks record.
  - `@shared/infra`: osn-api's secret inventory lists no Upstash secrets, and the workflow check lets osn-api's dev smoke check read `INTERNAL_SERVICE_SECRET`.
  - `@musubi/social`, `@pulse/web`: the privacy page names Cloudflare, not Upstash, for rate-limit state. Musubi's says Cloudflare hosts the databases in its Oceania region and keeps sign-in and rate-limit state there where it can, counting per-minute rate limits where a request arrives.
  - `@shared/crypto`, `@shared/rate-limit`: comments only.

- Updated dependencies [403cd83]
  - @shared/infra@0.6.1

## 0.2.0

### Minor Changes

- e8d8167: The musubi stack runs on production, declaring its sites alone: musubi landing on `www.musubi.social`, and musubi social staged on `next.musubi.social` while Pages keeps `musubi.social`. `@shared/infra` gains the production sites switch (`PRODUCTION_SITE_MODES`, `PRODUCTION_HOSTS`, `PRODUCTION_STAGING_HOSTS`, `hostsFor()`), the plan guard (`parsePlan()`, `planTextFaults()`, `guardPlan()`, `runPlanGuardCli()`, which requires `--domains`, the custom domains each site Worker holds now, writes each site's added and removed hosts to its record, and refuses a Worker giving up a host other than its spare one unless `--unflip` names the site: `domainChanges()`, `domainRefusals()`), `assertProductionScope()`, and the `production-hosts` command; `plan-summary` also warns, without failing, at each fault the guard would refuse in a plan's text. `assertDevDeployTarget()` is renamed `assertDeployTarget()` and accepts the production tier; `apiWorkerProps()`, `retainedD1Props()` and `retainedBucketProps()` refuse a production resource not in `PRODUCTION_ADOPTIONS`, which is empty. The pulse and zap stacks still refuse production. `CLOUDFLARE_PAGES_DNS_TOKEN` joins the production Environment's required credentials.

### Patch Changes

- Updated dependencies [e8d8167]
  - @shared/infra@0.6.0

## 0.1.6

### Patch Changes

- Updated dependencies [b1e4140]
  - @shared/infra@0.5.0

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
