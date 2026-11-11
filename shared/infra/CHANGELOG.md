# @shared/infra

## 0.7.5

### Patch Changes

- 6c2f518: `CLOUDFLARE_PAGES_DNS_TOKEN` is retired: `RETIRED_CREDENTIALS` replaces `PAGES_DNS_CREDENTIALS`, the production Environment requires it no more, `forbiddenCredentials()` forbids it on both tiers, and `knownCredentials()` leaves it out, so no workflow may read it. The domain move rehearsal stack (`rehearsal/`, `rehearsal:deploy`, `rehearsal:destroy`) is removed with its tests.

## 0.7.4

### Patch Changes

- 6c209aa: The plan guard reads neither `--flip` nor `--unflip`, and its record carries no `flip` or `unflip` key. A Worker giving up its production host, another site's host, or one the code does not name is refused in every release; the refusal says to take the host off in the Cloudflare dashboard first. `GuardInput` loses `flip`, `sites` and `domains`, `domainRefusals()` its `unflip` argument, `planRecord()` its `flip` and `unflip` fields, and `DomainReading` its `read` list, which only the flip rules read. `@musubi/infra`'s `plan:guard` usage comment follows.

## 0.7.3

### Patch Changes

- ab6810e: Cire landing and musubi social serve from their Workers: `PRODUCTION_SITE_MODES.cire_landing` and `.osn_social` are `worker`, so the cire production stack declares the apex `cireweddings.com` on the `cire-landing` Worker and the musubi stack the apex `musubi.social` on the `osn-social` Worker, and the release workflow records each site with `record-cire-landing` and `record-osn-social` in place of its Pages job. No site is staged any more. Each domain moves in its own release, dispatched with `flip: cire_landing`, then `flip: osn_social`. Until a stack's flip has run, every release that ships that stack, the daily run included, fails its precheck, which stops every job of that release.

## 0.7.2

### Patch Changes

- df9b5d9: Cire host serves from its Worker: `PRODUCTION_SITE_MODES.cire_host` is `worker`, so the cire production stack declares `host.cireweddings.com` on the `cire-host` Worker and the release workflow records the site with `record-cire-host` in place of its Pages job. The domain moves in a release dispatched with `flip: cire_host`. Until then every release whose surfaces name a cire site or are empty, the daily run included, ships the cire stack and fails its precheck, which stops every job of that release.

## 0.7.1

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

## 0.7.0

### Minor Changes

- aeab4d4: The production plan guard lets a flip release update the stack's other site Workers, as long as their custom domains are read and do not change. Every cire site build bakes the release commit, so those Workers update in nearly every release, and the old rule (the flip site's own update, every other line a noop) refused every cire flip.

  In a flip release the guard now refuses: a flip site that does not update or whose Worker does not gain its production host; another site Worker updating while its custom domains were not read; any other site's custom-domain change, whatever its action; any other resource that is not a noop or a site Worker's update; and any binding change. `--flip` with `--unflip` is a usage error (exit 2). `DomainReading` gains `read`, the sites whose live hosts were read, and `GuardInput` gains `sites` and `domains`.

### Patch Changes

- d3b719a: Cire vendor serves from its Worker: `PRODUCTION_SITE_MODES.cire_vendor` is `worker`, so the cire production stack declares `vendor.cireweddings.com` on the `cire-vendor` Worker and the release workflow records the site with `record-cire-vendor` in place of its Pages job. The domain moves in a release dispatched with `flip: cire_vendor`. Until then every release whose surfaces name a cire site or are empty, the daily run included, ships the cire stack and fails its precheck, which stops every job of that release.

## 0.6.9

### Patch Changes

- a28e017: A stack for the domain move rehearsal (`rehearsal/alchemy.run.ts`): one marker Worker at the `domain-move` stage of the dev account, on the spare host `next.domain-move.<DEV_DOMAIN>` or the moved host `domain-move.<DEV_DOMAIN>` as `REHEARSAL_MODE` says, run by the new `rehearsal:deploy` and `rehearsal:destroy` scripts. `rehearsal/names.ts` holds the rehearsal's hosts, Worker and per-run Pages project names, and refuses a production zone. The rehearsal makes every Cloudflare call with the dev deploy token, so no credential is added.

## 0.6.8

### Patch Changes

- e87ed59: cire-api's dev secret inventory declares `STRIPE_CONNECT_CLIENT_ID` (the Stripe Connect OAuth client id) while it holds a value. Both tiers forbid `STRIPE_API_URL` and `STRIPE_CONNECT_URL`, which point Stripe calls at a local stand-in.

## 0.6.7

### Patch Changes

- 6dbdb99: Drop dependencies no file imports (`motion`, `jose`, `@solidjs/meta`, `@solidjs/testing-library`, `@shared/design-tokens`, `@effect/vitest`, `@opentelemetry/exporter-logs-otlp-http`, and the direct `@vitest/browser` that `@vitest/browser-playwright` already brings in), and stop exporting shared symbols used only inside their own file. No behaviour changes.

## 0.6.6

### Patch Changes

- 7af11c1: In each dev stack job, every step between the order check and the deploy that reads a secret runs only when the order check lets the commit deploy: the snapshot and the deploy, and in the musubi job the step that derives osn-api's cire seed values. `@shared/infra`'s workflow tests hold `deploy.yml` to that.

## 0.6.5

### Patch Changes

- 9661da5: The cire organiser and vendor portals stage on `next.host.cireweddings.com` and `next.vendor.cireweddings.com` (`PRODUCTION_STAGING_HOSTS`). `RETIRED_STAGING_HOSTS` lists the spare hosts a site served before its current one, and `domainRefusals()` lets a site's Worker give up one of its own without a `flip` or `unflip`, unless that host is a production host or any site's current spare host; another site's retired host is still refused. `domainRefusals()` takes the retired list as an optional third argument.

## 0.6.4

### Patch Changes

- 0eb887f: Alchemy moves to `2.0.0-beta.84`, with its Cloudflare provider and state backend from `@alchemy.run/cloudflare` at the same release, so `state:check` loads on Effect 4.0.7 again. Each stack imports the provider from `@alchemy.run/cloudflare`; the D1 import and asset upload patch moves onto it. `state:bootstrap` runs `alchemy state bootstrap --backend cloudflare`. Every Alchemy script, the state scripts and each stack's `plan:*` and `deploy:*`, sets `CI=true`, so a run by hand takes Cloudflare credentials from the environment alone and a plan never deploys a missing state store. `@shared/infra`'s tests check that the CLI imports exactly one provider package and that the lockfile holds none of the barred Alchemy packages, and the state CLI test runs as its own task, `test:alchemy`.

## 0.6.3

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

## 0.6.2

### Patch Changes

- 58761b7: Alchemy uploads every asset with the content type Wrangler gives it. The repository's alchemy patch now types a file by mime 4.0.7, as Wrangler and Miniflare do, adds `; charset=utf-8` to a text type without one, and uploads a name with no known extension as `application/null`, which Cloudflare serves with no Content-Type. `.ico` uploads as `image/vnd.microsoft.icon` and `.sql` as `application/sql`.

  The upload type is part of each file's manifest hash, so a file whose type changes uploads again. Every Alchemy asset Worker re-uploads its assets once on its next deploy, on both tiers.

  `tests/assets-content-type.test.ts` checks both of alchemy's copies against mime 4.0.7, now a dev dependency, for every extension the Alchemy sites serve, and checks that the wrangler the guest site deploys with still bundles that mime and the charset rule. It reads the sites from `SITE_BUILDS` and the cire declaration's guest-site assets, checks they are every asset directory a stack declaration uploads, and the stack declarations join `test:repo`'s turbo inputs. A file served with no Content-Type is safe only with `X-Content-Type-Options: nosniff`, so the test also reads each of those sites' `public/_headers` as Cloudflare does and fails unless it sends `nosniff` on every path.

## 0.6.1

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
