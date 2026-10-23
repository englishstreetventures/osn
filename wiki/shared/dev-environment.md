---
title: Dev environment (cire + OSN identity)
tags: [runbooks, infra, deploy, cire, osn]
related:
  - "[[infrastructure-as-code]]"
  - "[[production-deploy]]"
  - "[[database-environments]]"
  - "[[free-tier-limits]]"
  - "[[musubi-identity-migration]]"
  - "[[cire-auth]]"
  - "[[oidc-provider]]"
  - "[[devloop-urls]]"
last-reviewed: 2026-10-23
---

# Dev environment (cire + OSN identity)

`cireweddings.com` serves live weddings, so nothing reaches production per merge.
Every merge deploys a **dev tier** automatically, and production waits for a
**release**: a separate workflow, run once a day and by hand, that ships whatever
production is behind on after one approval.

```
deploy.yml (every push)                              production-release.yml (daily, or by hand)

changes ──┐                                          plan ──> build ──> deploy-<surface>
          ├──> stack-<stack>-dev ──> deploy-<surface>-dev           waits for one approval
build ────┘        Alchemy, automatic     record jobs
```

The dev tier runs in **its own Cloudflare account**, built by four Alchemy stacks
([[infrastructure-as-code]]): its own Workers, D1 databases, R2 buckets, zone,
Upstash database and OSN identity origin. No dev request reads or writes a byte
of live-wedding data, no dev credential the deploys read reaches the production
account, and a dev account is not a production account. Tests, not the
Environment, keep it so: W8 in `shared/infra/tests/workflow-secrets.test.ts`
holds `deploy.yml` to the dev account's credentials, and
`shared/infra/tests/accounts.test.ts` holds `alchemy-state.yml` and the
free-tier alert to theirs. The `dev` Environment holds neither
`CLOUDFLARE_ACCOUNT_ID` nor `CLOUDFLARE_API_TOKEN_DEV`, the two names that
point at the production account, and `secrets:check-github -- --tier dev`
fails when it holds either ([[#The production account holds no dev tier]]).

---

## 1. Tier map

Every dev host derives from one GitHub `dev` Environment variable, `DEV_DOMAIN`,
a zone in the dev account ([[infrastructure-as-code#Dev hosts]]). `<D>` below is
its value. Each run's summary prints every host under **Dev hosts**.

| Surface | Dev host | Dev Worker (stack) | Prod host |
|---|---|---|---|
| cire API | `api.cire.<D>` | `cire-api-dev` (cire) | `api.cireweddings.com` |
| Guest invites | `invite.cire.<D>` | `cire-invites-dev` (cire) | `invite.cireweddings.com` |
| Organiser portal | `host.cire.<D>` | `cire-host-dev` (cire) | `host.cireweddings.com` |
| Vendor portal | `vendor.cire.<D>` | `cire-vendor-dev` (cire) | `vendor.cireweddings.com` |
| Cire marketing | `cire.<D>` | `cire-landing-dev` (cire) | `cireweddings.com` (apex) |
| OSN identity API | `id.musubi.<D>` | `osn-api-dev` (musubi) | `id.musubi.social` |
| OSN social / consent | `musubi.<D>` | `osn-social-dev` (musubi) | `musubi.social` |
| Musubi marketing | `www.musubi.<D>` | `musubi-landing-dev` (musubi) | none |
| Zap API | `zap.cire.<D>` | `zap-api-dev` (zap) | `zap.cireweddings.com` |
| Pulse marketing | `pulse.<D>` | `pulse-landing-dev` (pulse) | none |

Every dev surface is a Worker; the sites serve from Workers static assets, not
Pages ([[infrastructure-as-code#Sites]]).

Backing resources, all in the dev account:

| Kind | Dev | Prod |
|---|---|---|
| D1 | `cire-db-dev` | `cire-db` |
| D1 | `osn-db-dev` | `osn-db-prod` |
| D1 | `zap-db-dev` | `zap-db-prod` |
| R2 | `cire-sheets-dev`, `cire-assets-dev` | `cire-sheets`, `cire-assets` |
| Redis | a second Upstash database (**paid** — see below), its REST URL and token in the `dev` Environment | `osn-redis` (Sydney) |
| Rate-limit namespaces | cire `1101`–`1106`, osn `2101`–`2105` | cire `1001`–`1006`, osn `2001`–`2005` |
| Durable Object namespace | the dev Worker's own `TopicHub` namespace, which the cire stack declares | the production Worker's |

No file holds a dev database id: Alchemy creates each database and binds it by
resource. The dev stacks declare production's storage settings ([[database-environments]]).

> [!warning] The dev tier costs $10/month, and Upstash is the whole bill
> The Upstash free plan allows **one** database, so the dev database needs a
> **paid $10/month plan**. Every other dev resource is free. If the dev tier is
> ever cut, cancelling that plan is the saving. [[free-tier-limits]]

> [!note] Hosts two labels below the zone need no extra certificate
> The zone's free Universal SSL certificate covers only the apex and **one**
> subdomain label, but no dev host rides on it: each is a Workers custom domain,
> which provisions a certificate for its exact name, free, at any depth. The
> first certificate takes about two minutes, so a TLS handshake failure right
> after a host is attached is provisioning, not failure.
>
> *Measured 2026-08-14 — attaching a Workers custom domain two labels below its zone: certificate issued about two minutes after the deploy, SAN the exact host, issuer Google Trust Services.*

### WebAuthn on dev

Dev's RP ID is **`musubi.<D>`**, the host musubi social's dev Worker serves,
because a ceremony may only run on an origin same-site with the RP ID. It is
never a production zone: `parseDevDomain()` refuses one.

Consequence, and it is expected: **a dev passkey is a separate credential.** You
enrol once on the dev musubi social host and that key does nothing on
`musubi.social`. See [[musubi-identity-migration]] for why RP IDs behave this way.

### What dev does *not* do

- **No mail to anyone but us.** `ZAP_API_URL` is unset on `cire-api-dev`, so the
  enquiry chat bridge is off and vendor-enquiry delivery fails closed.
- **No live feature flags.** `GROWTHBOOK_CLIENT_KEY` unset ⇒ every flag serves
  its coded default with zero network.
- **No Turnstile verification.** `TURNSTILE_SECRET_KEY` is unset on
  `cire-api-dev`, so the gate does not verify ([[turnstile]]).
- **No Cloudflare Access on the API hosts.** See §5.

`cire/infra/tests/reads.test.ts` lists every name cire-api reads that dev leaves
unset, each with its reason.

---

## 2. How a deploy runs

`.github/workflows/deploy.yml`, on push to `main` or `workflow_dispatch`.
[[infrastructure-as-code#The dev deploy]] describes each step; in short:

1. **`changes`** — one boolean per dev surface and one per stack, from
   [`scripts/deploy-surfaces.ts`](../../scripts/deploy-surfaces.ts) run against
   `git diff --name-only "$BEFORE_SHA" HEAD`. A landing-page tweak deploys one
   stack. A dispatch, and a diff that fails to compute (first push,
   force-push), deploy everything. Any change under `shared/` or `patches/`,
   to `bun.lock`, root `package.json`/`turbo.json`/`tsconfig.json`,
   `.browserslistrc`, `deploy.yml` itself or the surface map also deploys
   everything, rather than maintaining a shared-package→consumer map that rots
   on the first new import. A change under `shared/infra/` runs every stack; one
   under a stack's own `infra/` directory runs that stack. A change to
   `scripts/smoke-check.ts` or `scripts/worker-deployments.ts` deploys every dev
   surface, so the check runs on dev before a release runs it. Each cire
   surface's paths list every `@cire/*` package it bundles (`cire/ui`,
   `cire/dietary`, `cire/theme`, …), and
   [`scripts/tests/deploy-surface-map.test.ts`](../../scripts/tests/deploy-surface-map.test.ts)
   fails when a surface's `package.json` gains a `@cire/*` dependency its paths
   do not name. The production release reads the same map, so the two tiers
   agree on what a change touches.
2. **`build`** — install, `bun run build`, `bun run test`, `bun run test:d1`.
   Everything below `needs:` it, so nothing ships from a broken tree.
3. **`stack-<stack>-dev`** — `environment: dev`, no reviewers, runs unattended.
   It builds the stack's sites against the dev hosts, deploys the whole stack
   with Alchemy, then runs the smoke check for every surface in it. A surface
   that answers wrongly is rolled back, if this run uploaded it, and the job
   fails once every surface has been checked.
4. **`deploy-<surface>-dev`** — one record job per surface, run only when its
   stack job deployed, read every Worker's new deployment, and its own check
   passed. It leaves the surface's dev
   Deployment record, which the release planner's dev gate reads by job name.

Production is not in this workflow. `production-release.yml` ships it in releases
([[production-deploy]] §5.5).

### Concurrency

Each stack job takes a group of its own, `deploy-dev-<stack>`, with
`cancel-in-progress: false`: two runs never deploy one stack at once, the
other stacks stay parallel, and no rollback can race the next run's deploy.
A queued run is replaced by a newer one; because each run deploys its whole
stack, the newer run carries every change before it. Production jobs live in
`production-release.yml` under `deploy-production-<surface>` groups, so a
release waiting for approval never holds up a dev deploy.

### Proving the rollback path

**Deploy** has no input that makes a check fail on purpose. The rollback has run
for real once: on 2026-10-16, **Deploy** run 38869446427 forced osn-api's check
to fail on the dev tier that ran in the production account. Its job
`Deploy osn/api — dev` (116870013485) rolled `osn-api-dev` back, reported that
the restored version answers healthy, and left its Deployment record in state
`failure`.

*Measured 2026-10-16 — `gh run view 38869446427 --log --job 116870013485`, and
`gh api repos/englishstreetventures/osn/deployments/7113807729/statuses`*

That run proved the rollback call itself. Two things have not yet run against
Cloudflare on the stacks' dev tier, and nothing there can force them:

- **The self-heal.** After a smoke check rolls a Worker back, the next run's
  snapshot sees the rollback's message and deploys that stack with `--force`,
  re-uploading what the commit declares. `scripts/tests/worker-deployments.test.ts`
  ("writes force=true, naming the Worker, when a newest deployment is a
  smoke-check rollback") and `scripts/tests/smoke-check.test.ts` ("an unchanged
  Worker still serving an earlier smoke check's rollback fails at once, naming
  the fix") check both halves against a fake Cloudflare API.
- **osn-api's rollback after Alchemy re-sends its secrets.** Cloudflare may
  refuse it as "secrets changed" (code 10220); the check then leaves the Worker
  as it is and says so by name ("Cloudflare's refusal over changed secrets is
  kept" in `scripts/tests/smoke-check.test.ts`).

*Unverified — no check has failed on the stacks' dev tier. The first that
fails shows the self-heal in the next run's log; the first on osn-api shows how
Cloudflare answers its rollback.*

To see which surfaces of a run failed: a run leaves one Deployment record per
stack job and one per record job, all for the same commit; a surface whose
check failed has no record job, so its stack job's record is the only one that
names it. To list them:

```bash
SHA=<the run's commit>; R=repos/englishstreetventures/osn
for id in $(gh api "$R/deployments?environment=dev&sha=$SHA" --jq '.[].id'); do
  gh api "$R/deployments/$id/statuses" \
    --jq '.[0] | "\(.state) \(.log_url | capture("job/(?<j>[0-9]+)").j)"'
done | while read -r state job; do
  echo "$state $(gh api "$R/actions/jobs/$job" --jq .name)"
done
```

### Two accounts, two Environments

| Environment | Cloudflare account | Credential secrets | Reviewers |
|---|---|---|---|
| `dev` | the dev account | `CLOUDFLARE_DEV_ACCOUNT_ID`, `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN`, `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY` (not set yet, englishstreetventures/osn#1538) | none; branch policy `main` |
| `production` | the production account | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | required; branch policy `main` |

The separate account is the hard boundary: `Workers Scripts: Edit` and
`D1: Edit` are account-level permissions with no per-script filter, so only a
second account keeps a dev token away from production Workers. The dev names
differ from production's so a job in the wrong Environment fails on an empty
secret instead of reaching the other account. [[access-control]] lists who holds
each credential.

Permissions the dev deploy token holds, one line per thing the stack jobs call:

| Scope | Permission | What needs it |
|---|---|---|
| Account | `Workers Scripts: Edit` | Alchemy's Worker uploads, crons and rate-limit bindings; the snapshot, compare and rollback calls of the smoke check |
| Account | `D1: Edit` | creating each dev database, migrating it and importing its seeds |
| Account | `Workers R2 Storage: Edit` | creating the dev buckets |
| Account | `Secrets Store: Edit` | the Alchemy state store ([[infrastructure-as-code#State store]]) |
| Account | `Account Settings: Read` | the account lookup on every call |
| Zone (the dev zone) | `Zone: Read`, `DNS: Edit`, `Workers Routes: Edit` | each Worker's custom domain |

The read-only token, `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY`, holds
`Account Settings: Read`, `D1: Read` and `Account Analytics: Read` on the dev
account, for the free-tier alert's dev job ([[free-tier-limits]]).

Repository scope holds no credential that can write to Cloudflare. It keeps
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN_READONLY`, the production
account's read-only pair, for the free-tier alert's production job, which
cannot take `environment: production` because that gate waits on a person and
nobody approves a cron at 22:00 UTC.

*Measured 2026-10-23 — `gh secret list --repo englishstreetventures/osn` returns
ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, CLOUDFLARE_ACCOUNT_ID,
CLOUDFLARE_API_TOKEN_READONLY, RELEASE_TOKEN and TESSL_TOKEN — no deploy token
among them.*

Before adding a workflow that touches Cloudflare, check what scope it resolves
at: `grep -l CLOUDFLARE .github/workflows/*.yml`, then read each hit for an
`environment:` line. `shared/infra/tests/accounts.test.ts` fails when a workflow
reads a credential nobody classified, or when any workflow but
`alchemy-state.yml`, `deploy.yml` and `free-tier-ceiling-alert.yml` reads a dev
account credential. A workflow that declares no Environment and needs to write
has no credential to read — that is the design.

### The dev data is not reset

Nothing resets a dev database. Alchemy creates each one on the first deploy,
applies every migration it has not recorded, and imports the seeds after them,
re-importing a seed only when its file changes
([[infrastructure-as-code#Seeds and the ARC registration]]). A wedding or an
account a tester makes by hand survives until someone deletes it.

The cire seed is the sample wedding, matching a real live one in shape and
size — 5 events, 199 households, 494 guests, 1131 invitations, 168 replies, 3
co-hosts, the Crimson plan tier comped (`tier_source = 'comp'`, so every module
opens) plus a comped `premium_templates` row, and the invite customisation row.
To see the portal as an Ivory or Gold wedding sees it, lower the tier with
`grant-tier.ts --lower` ([[cire-entitlements]]). Four households and six guests
are hand-written (`seed/data/`) and are the ones every claim-code and RSVP test
uses; the rest are generated from a seeded PRNG in `seed/data/households.ts` so
a list, a search and a dashboard count all have enough rows to be honest. **No
real guest's details are copied into dev** — the synthetic names, codes and
dietary notes are invented and deterministic. The seed is `INSERT OR IGNORE`,
so it never overwrites a row a tester changed.

The osn seed holds the cire OIDC client row and cire-api's ARC key, nothing else.
A re-import never re-enables a client or a key someone disabled or revoked in
the database, so a revoked key is replaced under a new `CIRE_API_ARC_KEY_ID`
([[infrastructure-as-code#Seeds and the ARC registration]]).

**The migration chain is still tested from zero.** `cire/api/tests/db/ddl-lockstep.test.ts`
applies the whole chain to an in-memory database on every pull request, and
diffs it against the DDL mirror in `cire/api/src/db/setup.ts` and the Drizzle
schema. Each new migration then runs against real D1 on the merge that adds it,
which catches DDL `bun:sqlite` accepts and D1 rejects at the migration that
introduces it.

> [!warning] A half-applied migration has no scripted recovery yet
> Alchemy applies migrations over D1's HTTP API, which has no transactions. A
> migration that fails part-way leaves its earlier statements applied and
> itself unrecorded, and every later deploy of that stack fails on it. Fix
> forward with a new migration that brings the database level.
> englishstreetventures/osn#1554 tracks a tested procedure.

### Re-setting the sample wedding's owner

The seed gives the wedding's owner seat to `usr_dev_bootstrap_owner`, the
dev-login principal (§5): `/dev/login` opens it. To own it from your own passkey
account instead:

1. Sign in on the dev musubi social host with a passkey, and copy your profile
   id (`usr_…`).
2. Set the `dev` Environment **variable** `CIRE_DEV_OWNER_PROFILE_ID` to it:
   `gh variable set CIRE_DEV_OWNER_PROFILE_ID --env dev --repo englishstreetventures/osn --body usr_…`.
3. Dispatch **Deploy**. The cire stack imports a new owner-seat file, which
   moves the seat to that profile.

A value that is not `usr_` plus url-safe base64 fails the cire stack before
anything uploads. Setting the variable back to a value used before may fail the
import (a known, unverified risk: [[infrastructure-as-code#Seeds and the ARC registration]]);
changing it again recovers.

### Placeholder images (one-off, not CI)

The seed stores R2 object **keys**, not URLs, and a key with nothing behind it is
a broken image on every guest page. Upload the images once, by hand, with the dev
account's credentials:

```bash
export CLOUDFLARE_ACCOUNT_ID=<dev account id> CLOUDFLARE_API_TOKEN=<dev token> DEV_DOMAIN=<dev domain>
bun run --cwd shared/infra token:check -- --tier dev   # go on only when it exits 0
bun run --cwd cire/db assets:seed:dev                  # 8 generated PNGs -> cire-assets-dev
```

It writes the hero, story and footer slots plus one image per event, by bucket
name with `--remote`, into whichever account the credentials name. The pictures
are generated gradients, not photographs: no couple's photo is ever copied onto
a tier this many people can reach. Re-run only after recreating the bucket.

---

## 3. Promoting to production

1. Merge the PR. The `Deploy` run starts; dev deploys within a few minutes.
2. Check dev (§6 below, or just the surface you changed).
3. Wait for the daily **Production release** run, or dispatch one from
   **Actions → Production release**. Its `plan` summary lists what ships.
4. Approve once. Every production job in the release runs, and GitHub records who
   approved on the run itself.

Rejecting leaves dev ahead of prod. That is a valid resting state — the next
merge's dev deploy is unaffected, and the next release offers the same surfaces
again. The full procedure and the dispatch inputs are in [[production-deploy]] §5.5.

**A surface reaches production only after dev deployed the same content.** The
release planner reads dev's Deployment records: a changed surface with no recent
successful dev record built from the same content is held back until dev has it.
A record exists only when the surface's smoke check passed. Dev redeploys a
stack only on a push that touches it, so after a failed dev deploy, dispatch
**Deploy**. Musubi landing and pulse landing have no production surface in the
release; zap-api's production release waits for its dev deploy like every other
surface.

---

## 4. Bootstrapping the dev account

Everything below needs the dashboard or a credential CI does not hold. Do it in
this order, and set every value **before** the first deploy into a new dev
account: a dispatch of **Deploy** deploys every dev stack at once, and a merge
to `main` deploys every stack whose files it changes. A stack whose value is
missing fails before it uploads anything; set the value and dispatch
**Deploy**.

Set each secret with no trailing newline:

```bash
printf '%s' "$VALUE" | gh secret set NAME --env dev --repo englishstreetventures/osn
```

1. **The account and its zone.** The dev account exists
   (englishstreetventures/osn#1538), with the dev zone active (registrar
   nameservers pointed at it), a `workers.dev` subdomain registered, and R2 and
   Images enabled.
2. **The `dev` Environment's variables.** `DEV_DOMAIN`: the zone, bare, no
   scheme. `PUBLIC_TURNSTILE_SITEKEY` and `PUBLIC_GOOGLE_MAPS_EMBED_KEY` stay as
   they are. Leave `CIRE_DEV_OWNER_PROFILE_ID` unset until step 8.
3. **Credentials.** `CLOUDFLARE_DEV_ACCOUNT_ID`;
   `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN` (the permissions in §2); and
   `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY` (`Account Settings: Read`,
   `D1: Read`, `Account Analytics: Read`).
4. **Worker secrets**, new values made for the dev account, never production's:
   - osn-api: `DEV_LOGIN_SECRET` (at least 32 characters), `INTERNAL_SERVICE_SECRET`
     (zap-api reads the same one), `OSN_JWT_PRIVATE_KEY`, `OSN_JWT_PUBLIC_KEY`,
     `OSN_PAIRWISE_SALT`, `OSN_SESSION_IP_PEPPER`, `OSN_TOTP_ENCRYPTION_KEY`,
     `RESEND_API_KEY`, `UPSTASH_REDIS_REST_TOKEN`, `UPSTASH_REDIS_REST_URL`.
   - cire-api: `CIRE_API_ARC_KEY_ID` (a UUID), `CIRE_API_ARC_PRIVATE_KEY` (a
     **raw** ES256 JWK), `CIRE_OIDC_CLIENT_SECRET`, `STRIPE_SECRET_KEY` (a
     test-mode key, starting `sk_test_` or `rk_test_`), `STRIPE_WEBHOOK_SECRET`,
     `STRIPE_PLATFORM_WEBHOOK_SECRET`. The musubi stack job's `cire_seed` step
     reads the first three too, to derive the OIDC client's hash and the ARC
     public key for osn-api's seed; the step that deploys the musubi stack holds
     none of them ([[infrastructure-as-code#Seeds and the ARC registration]]).
   - Optional, one value for both osn-api and cire-api:
     `CIRE_INTERNAL_REVOKE_SECRET` (at least 32 characters, `openssl rand -base64 32`).
     With it, sign out everywhere else ends the account's cire organiser
     sessions ([[sessions#Sign out everywhere else reaches cire]]). After setting
     or changing it, deploy both the musubi and cire stacks.
   - The guest site's build: `ASTRO_KEY`, from `bunx --bun astro create-key` in
     `cire/invites`, fixed so two builds of one commit match. Root `turbo.json`
     passes it to the build without hashing it, and that build runs with turbo's
     cache off, so the key never reaches a cache.
   - The smoke check behind Access: `CF_ACCESS_CLIENT_ID`,
     `CF_ACCESS_CLIENT_SECRET` (§5), a service token of the **dev** account's
     Zero Trust organisation; another account's token passes the name check
     and fails every browser host's smoke check.

   The cire and musubi stacks refuse to deploy while a value breaks its dev
   rule: a `STRIPE_SECRET_KEY` that is not a test-mode key, or a
   `DEV_LOGIN_SECRET` or `CIRE_INTERNAL_REVOKE_SECRET` shorter than 32 characters
   ([[infrastructure-as-code#GitHub Environment secrets]]).

   `secrets:check-github -- --tier dev` lists any missing Worker secret,
   credential (the read-only token included) or secret only a workflow reads
   (`ASTRO_KEY` and the `CF_ACCESS_*` pair)
   ([[infrastructure-as-code#Checking the inventory]]). It reads names only:
   it cannot tell that the `CF_ACCESS_*` pair is the dev account's service
   token rather than another account's, and it does not check `DEV_DOMAIN`,
   which `gh variable list --env dev` shows. The OSN JWT keys are
   **base64-encoded** JWK JSON; the ARC key is a **raw** JWK string.

   > [!warning] Never rotate the dev `OSN_PAIRWISE_SALT`
   > Rotation changes every pairwise `sub`, so every dev relying party sees its
   > users as strangers, permanently. Each tier has its **own** salt: a shared
   > one would make a dev `sub` equal the production `sub` for the same account.
   > Generate it once, 64 random bytes, and keep your copy. [[oidc-provider]]

   > [!note] `OSN_TOTP_ENCRYPTION_KEY` is exactly 32 bytes
   > `openssl rand -base64 32`, and keep your copy: rotating it needs the old
   > value ([[production-deploy#10. Rotating OSN_TOTP_ENCRYPTION_KEY]]).
5. **Cloudflare Access and its service token** (§5), and the **Turnstile**
   hostnames (§5). Access must cover every browser host before the first
   deploy: each browser host's smoke check asks `/` without the token and fails,
   with no rollback, unless Access answers with its sign-in. A failed check
   leaves no dev record, so the dev gate holds that surface's production
   releases.
6. **Stripe, test mode.** Two webhook endpoints, `https://api.cire.<D>/api/stripe/webhook`
   and `https://api.cire.<D>/api/stripe/platform-webhook` (each stack run's
   summary prints both as `stripe_webhook_url` and `stripe_platform_webhook_url`);
   their signing secrets go in `STRIPE_WEBHOOK_SECRET` and
   `STRIPE_PLATFORM_WEBHOOK_SECRET`. [[stripe-webhooks]]
7. **The state store.** Run **Actions → Alchemy state store** with `tier: dev,
   action: bootstrap`, then `action: check`.
8. **The first deploys**, on `main`:
   1. Dispatch **Deploy**; the first deploy creates every resource.
      Each custom domain waits about two minutes for its certificate, longer
      than the smoke check tries, so this run may go red with "unreachable" or
      TLS failures and no rollback. That is provisioning: go on to step 2.
   2. Dispatch **Deploy** with `expect_no_change: true`: every stack job must
      report `Plan: no changes`.
   3. Sign in on `musubi.<D>` with a passkey, set `CIRE_DEV_OWNER_PROFILE_ID`
      (§2), dispatch once more, and sign in on `host.cire.<D>`.
   4. Fill the asset bucket (§2, placeholder images).

   No step here proves the rollback or the self-heal against the new account:
   §2, *Proving the rollback path*, says what is unproven.

### The production account holds no dev tier

Every dev resource lives in the dev account. None of the dev names exists in
the **production** account: Workers `osn-api-dev`, `cire-api-dev`,
`cire-invites-dev`; D1 `osn-db-dev`, `cire-db-dev`; R2 `cire-assets-dev`,
`cire-sheets-dev`; Pages projects `osn-social-dev`, `cire-host-dev`,
`cire-vendor-dev`, `cire-landing-dev`. The production zones hold no dev DNS
record, so `api.dev.cireweddings.com`, `invite.dev.cireweddings.com`,
`host.dev.cireweddings.com`, `vendor.dev.cireweddings.com`,
`dev.cireweddings.com`, `dev.musubi.social` and `id.dev.musubi.social` resolve
to nothing. The production account's Zero Trust organisation has no dev Access
application or service token, and Stripe test mode sends no webhook to those
hosts.

The `dev` Environment holds neither `CLOUDFLARE_ACCOUNT_ID` nor
`CLOUDFLARE_API_TOKEN_DEV`. Both point at the production account, the first
as its id and the second as a Wrangler token's name there, and the `dev`
Environment has no reviewer, so
`bun run --cwd shared/infra secrets:check-github -- --tier dev`
exits 1 when it holds either (`RETIRED_DEV_CREDENTIALS`,
[[infrastructure-as-code#Accounts]]). Nothing in CI runs that check: run it
after any change to the `dev` Environment and read its output, since it also
exits 1 for a missing name; a held production name prints as
`forbidden but set`. It reads names alone, so a production token under any
other name passes it, and it lists Environment secrets only, so a token set at
repository scope passes it too; check that scope with
`gh secret list --repo englishstreetventures/osn`
([[#Two accounts, two Environments]]).

Deleting a secret from GitHub leaves its Cloudflare token valid: revoke the
token in its account's dashboard as well ([[access-control]]).

*Measured 2026-10-23 — in the production account, `wrangler d1 list` (five
databases, none a dev one), `wrangler pages project list` (none ending `-dev`)
and `wrangler r2 bucket list` (`cire-assets`, `cire-sheets`);
`gh secret list --env dev --repo englishstreetventures/osn` (21 names, neither
of those two); `dig +short <host> @1.1.1.1` for `A`, `AAAA` and `CNAME`, empty
for each host above.*

*Checked 2026-10-22 and 2026-10-23 by the owner — no dev Worker in the
production account (Cloudflare API); the Access application, its service token
and the Stripe test webhooks deleted in their dashboards.*

---

## 5. Access control on dev

Cloudflare Access (Zero Trust, free for 50 users) on the dev account, with an
email one-time PIN policy, guards the **browser** hosts: `invite.cire.<D>`,
`host.cire.<D>`, `vendor.cire.<D>`, `cire.<D>`, `musubi.<D>`, `www.musubi.<D>`
and `pulse.<D>`. The owner sets it up in the dev account's Zero Trust
organisation (englishstreetventures/osn#1553 holds the choice).

Things to know when building it:

- **An application takes at most five destinations**, and an Access session is
  per application, so each extra application is one more PIN prompt. The form
  refuses a sixth destination with *"You've added the maximum number of
  hostnames per application allowed."* Seven browser hosts need two
  applications.
- **Version preview URLs and `workers.dev` hosts are off on every dev Worker**
  (`previewUrls: false` and `workersDev: false` in each stack, K11 in each
  stack's `tests/stack.test.ts`, which checks the evaluated Workers): each would
  be a public `*.workers.dev` host that no application over the custom hosts
  covers.
  englishstreetventures/osn#1578 turns them on for per-pull-request previews.
- Admit people with a reusable policy (Action `Allow`, `Emails` and
  `Emails ending in` rules); add someone by adding their email to that policy,
  never by adding an application.
- Save the policy with **Save policy** inside the Access-policies card *before*
  clicking **Create**. Until you do, the Preview card reads "No policies added /
  No destinations assigned" — the destinations are only unrendered. Use the
  **Builder** tab rather than "Create new policy", which navigates away and drops
  the unsaved destination list.

> [!warning] Do NOT put Access on the API hosts
> An Access cookie is not sent on a cross-origin XHR. Gating `api.cire.<D>`,
> `id.musubi.<D>` or `zap.cire.<D>` would break every dev fetch and the whole
> OIDC redirect, and the failure looks like a CORS bug rather than an auth
> policy. They stay guarded by the CORS allowlist and `origin-guard.ts`, exactly
> as production is.

### The smoke check's service token

The checks of the seven browser hosts ask hosts Access answers with a login
redirect. To let them through, the check sends a Cloudflare Access **service
token** as the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers, to
those hosts only. An Access policy covers every host of its application, so a
token on an application opens all of its hosts to whoever holds it.

Each round of a browser host's check also asks its `/` once with no token,
following no redirect, to prove Access guards the host. Only Access's sign-in
passes: a 301, 302, 303 or 307 to a `*.cloudflareaccess.com` host. Any other
answer fails the check, with an annotation titled `Cloudflare Access` and no
rollback, since the Worker is not what failed. Like any failed check, it leaves
no dev record, so the dev gate holds that surface's next production release.

Setting up the token:

1. Zero Trust → Access → Service credentials → create a service token for the
   deploy check, with a fixed duration (one year), not "non-expiring". Copy the
   Client ID and Client Secret; the secret is shown once. Note the expiry date
   where the owner keeps renewal dates.
2. On each application, add a policy with Action **Service Auth** that includes
   that token. The email policy stays as it is. Leave the application's
   "Return 401 Response for Service Auth policies" setting off: with it on,
   Access answers the tokenless request with a 401 instead of its sign-in
   redirect, and every check of that application's hosts fails.
3. Store the two values as `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` on
   the `dev` Environment.

Without them the check probes anyway: Access answers in the Worker's place, the
check fails without a rollback, and the dev gate holds that surface's next
production release. A refused token — expired, revoked, or the policy gone —
fails the same way.

### Turnstile

The guest site and musubi social load the Turnstile widget with
`PUBLIC_TURNSTILE_SITEKEY` (`VITE_TURNSTILE_SITEKEY` in musubi social's build).
The widget renders only on hostnames its settings list; on any other it fires
its `error-callback` (`110200`) and the gated form's submit never enables, so
dev sign-in and guest claims stop at the form. So the dev domain goes on the
existing widget's hostname list (englishstreetventures/osn#1553 holds the
choice); Turnstile matches subdomains, so the bare dev domain covers every dev
host. Neither dev API holds `TURNSTILE_SECRET_KEY`, so the servers do not verify
on dev. [[turnstile]]

### The API docs are a dev-only surface

`osn-api` and `pulse-api` mount `@elysiajs/openapi` — the Scalar UI at
`/openapi`, the document at `/openapi/json` — on **`local` and `dev` only**.
On `staging` and `production` both paths are a 404, because the plugin is never
mounted; there is no route there to authorise or block.

Why it comes off the public tiers: the document is a complete map of every
route, every parameter and every error shape, and nothing reads it at runtime.
`shared/openapi/osn.json` and `shared/openapi/pulse.json` are committed, the
generated clients are built from those files, and each generator boots its own
app to produce one. So a deployed public host gains nothing by serving it and
saves an attacker the cheapest reconnaissance step there is.

> [!important] The tier comes from the `env` binding, never `process.env`
> On workerd `process.env` is a shim populated from `[vars]` on first access,
> and it is **empty during module evaluation**. Any tier decision taken at
> import time therefore reads `local` on every deployed tier and serves the
> docs everywhere. `osn-api` derives the flag inside `buildAppDeps(env, …)`
> (`osn/api/src/build-deps.ts`, `servesOpenapiDocs`); `pulse-api` derives it in
> `buildApp(env)` (`pulse/api/src/index.ts`) and passes
> `AppOptions.includeOpenapi`. Both read the request-scoped `env.OSN_ENV`.

Both gates fail closed. `isNonLocal` counts anything that isn't exactly `local`
as deployed, and `parseDeploymentEnvironment` answers `dev` only for `dev` or
`development` — so a typo'd tier string leaves the docs **off**, not on. To read
the docs against a deployed tier, use dev:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://id.musubi.<D>/openapi/json     # 200
curl -s -o /dev/null -w '%{http_code}\n' https://id.musubi.social/openapi/json  # 404
```

`pulse-api` has no deployed tier. Its `[env.dev.vars]` point at localhost for
`wrangler dev --env dev` and leave `OSN_ENV` unset, which reads as `local`.

### Passkey-less sign-in on local and dev

A passkey is the only primary login factor, so a seeded account is unreachable:
nobody can enrol a WebAuthn credential on behalf of a row a seed script wrote.
`GET /dev/login` on `osn-api` mints a **real** OSN session for one fixed
principal instead, so the OIDC chain, the organiser portal, the vendor portal and
`@musubi/social` all run untouched — there is no bypass anywhere else in the stack.

The principal is fixed and provisioned on first use (idempotent):

| Field | Value |
|---|---|
| Profile | `usr_dev_bootstrap_owner` — the id the cire seed writes as the **seeded wedding's owner**, so the organiser portal opens on real data |
| Account | `acc_dev_bootstrap`, `dev@seed.osn.dev` |
| Handle | `dev_bootstrap` — in `RESERVED_HANDLES`, so no real registration can take it first |
| Org | `org_dev_bootstrap`, handle `dev_bootstrap_org`, membership `admin` |

Both handles are in `RESERVED_HANDLES`, and organisation creation consults that
set too — so neither a profile nor an organisation registration can occupy the
row first.

Two gates, both fail-closed, both in `buildAppDeps` (`osn/api/src/build-deps.ts`,
`servesDevLogin`, which keeps **its own** tier list — deliberately not an alias
of the docs gate above, so a later change to how docs are gated cannot quietly
widen a credential bypass):

- tier is `local` or `dev` — a typo'd `OSN_ENV` leaves it **off**;
- `DEV_LOGIN_SECRET` is set.

Fail either and the routes are **never mounted**, so the path answers 404 rather
than a 401 that would admit the surface exists.

```bash
# local (bun run dev): put DEV_LOGIN_SECRET in osn/api/.env. DEV_LOGIN_RETURN_ORIGINS
# is set for you by the dev-env launcher, to this worktree's own hosts — see [[devloop-urls]]
open "https://id.musubi.localhost/dev/login?secret=$SECRET&return_to=https://host.cire.localhost/dashboard"

# deployed dev: the value is the dev Environment's DEV_LOGIN_SECRET, which the
# musubi stack uploads on every deploy and refuses under 32 characters. Set or
# rotate it there, then dispatch Deploy.
printf '%s' "$SECRET" | gh secret set DEV_LOGIN_SECRET --env dev --repo englishstreetventures/osn
open "https://id.musubi.<D>/dev/login?secret=$SECRET&return_to=https://host.cire.<D>/dashboard"
```

`return_to` is optional; without it the response is the session JSON. With it the
route 302s, after checking the target's origin against
**`DEV_LOGIN_RETURN_ORIGINS`** — a comma-separated var of its own, which the
musubi stack sets to the dev musubi social, organiser, vendor and guest origins.
Locally the `dev-env` launcher sets it to this worktree's own portless hosts, so a
linked worktree allows its own surfaces and no other's ([[devloop-urls]]). An
off-list `return_to` is a 400, never a redirect, so the endpoint can't be turned
into an open redirect that leaks the session cookie. **Unset ⇒ every `return_to`
is a 400** — closed by default, so each origin is an explicit decision.

> [!note] Why not the CORS allowlist
> `OSN_CORS_ORIGIN` also feeds the CSRF origin guard. Adding a redirect target
> there would widen that guard for **every** route, and a redirect target need
> not be an origin that fetches this API with credentials. The two lists overlap
> today; they are not the same list.

The origin check runs **before** the secret is compared, so a wrong secret
redirects nowhere, and both verbs answer `Referrer-Policy: no-referrer` so the
secret-bearing URL never reaches the target as a `Referer`.

> [!warning] The URL is the credential
> Anyone who can read a `/dev/login?secret=…` link can sign in as the dev
> principal and hand a signed-in link to someone else. Treat it like a password:
> never paste it into an issue, a PR, or a chat, and rotate `DEV_LOGIN_SECRET` if
> it turns up in one. Production is unreachable this way — the tier gate keeps
> the route unmounted, the inventory forbids the secret on production, and the
> production deploy job **fails** while `DEV_LOGIN_SECRET` is set on
> `osn-api-production`.

> [!important] Why `GET`, and why no button
> The origin guard rejects a POST without a matching `Origin` header, so GET is
> what works from an address bar, `curl` and headless Chrome. More importantly it
> keeps the secret **out of every public frontend bundle** — nothing but the
> operator's URL carries it. Do not add a "sign in as dev" button to any app.

The session is a normal one: it shows up in `/sessions`, rotates, and can be
revoked like any other. No `security_events` row is written (the kind union is
closed and this has no place in a real account-security UI) — the session row and
an `Effect.logWarning` are the audit trail.

> [!note] The vendor portal signs in but lists nothing
> The dev principal has an org and a membership, not a `directory_vendors` row.
> The dev vendor portal therefore authenticates fine and shows an empty directory
> listing until that row is seeded.

---

## 6. Verifying the dev tier

A dev tier is only proven when a passkey ceremony completes end to end — a
ceremony spans two requests, so it is what catches Redis being misconfigured.

Every stack job already asks each of its surfaces whether it answers (§2):
osn-api's `/health` and JWKS, cire-api's `/api/auth/session`, zap-api's
`/health`, the guest site's `/` and an unknown-slug page, each site's `/`,
musubi social's deep-link fallback and pulse landing's `/api/geo`, and on each
browser host `/` without the Access token (§5). Steps 1 and 2 below go further
by hand; steps 3 to 6 are what no machine checks; step 7 repeats by hand what
the checks already ask.

1. `cire-api` has **no health route** in any tier — `/health` is a 404 on dev and
   on production alike, so it proves nothing. Probe two real routes instead and
   read the status codes, not the bodies:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://api.cire.<D>/api/claim/session
   # 401 — the route ran. A 503 here means the CLAIM_RATE_LIMITER binding is
   # missing and the deployed-tier guard failed closed.

   curl -s -o /dev/null -w '%{http_code}\n' https://api.cire.<D>/api/auth/oidc/start
   # 400 — the handler ran and refused the missing return_to. A 302 to
   # /login?auth_error=sign_in_unavailable means one of OSN_ISSUER_URL /
   # OSN_JWKS_URL / CIRE_API_ORIGIN / CIRE_OIDC_CLIENT_ID / _SECRET is unset.
   ```

2. `https://id.musubi.<D>/.well-known/jwks.json` serves keys, and
   `/.well-known/openid-configuration` reports `"issuer": "https://id.musubi.<D>"`
   — not the production issuer.
3. Register a **new** passkey on `https://musubi.<D>`, sign out, sign back in.
   Proves Upstash-backed ceremony state survives across requests.
4. Sign in on `https://host.cire.<D>` through the OIDC redirect. Proves the
   seeded `oauth_clients` row, the pairwise salt and the redirect URI agree. A
   consent row in `osn-db-dev` with no `organiser_sessions` row in `cire-db-dev`
   means the token came back but cire refused it — look at
   `CIRE_OIDC_CLIENT_SECRET` and the pairwise salt.
5. Open one wedding's checklist on `https://host.cire.<D>` in two tabs and tick
   a task in one: the other shows it without a reload. Proves cire-api's
   `REALTIME_HUB` binding and the `TopicHub` class the cire stack declares
   ([[realtime]]); no smoke probe reaches the hub. A tab that changes only on
   reload means push is off — cire-api logs an error when the binding is
   missing.
6. Claim the seeded code `TESTFOR-JOY-DD44` on `https://invite.cire.<D>` and
   submit an RSVP. Proves the guest session cookie, the `WEB_ORIGIN` ordering and
   the D1 seed: the reply lands in `rsvps` with `status = 'attending'`.
7. Every browser host prompts for Access; the three API hosts do not. Each
   browser host's smoke check fails when Access does not answer `/`, and an API
   host's fails when Access answers in its place. By hand, `curl -sI`
   each one: a browser host answers 302 to `…cloudflareaccess.com/cdn-cgi/access/login/<host>`,
   `https://api.cire.<D>/api/claim/session` 401, and
   `https://id.musubi.<D>/.well-known/openid-configuration` 200. A 302 on an API
   host means Access is on the wrong destination — take it off before anything
   else.

---

## 7. Working on dev by hand

Every command below needs the dev account's credentials exported as
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, never production's, and
`DEV_DOMAIN`. Run the token check first, and go on only when it exits 0: no
stack and no `wrangler` command checks which account a token reaches.

```bash
# First, every time: the token reaches the dev account alone
bun run --cwd shared/infra token:check -- --tier dev

# Watch a dev Worker
bunx wrangler tail cire-api-dev
bunx wrangler tail osn-api-dev

# Plan a stack against dev without deploying, with OSN_DEPLOY_TIER=dev, the
# stack's secrets, and its sites built for the dev hosts
bun run --cwd musubi/infra plan:dev
```

A plan evaluates the whole stack, so it needs what a deploy needs: the sites
built with the dev hosts, and for the musubi stack the three seed values
([[infrastructure-as-code#How a stack run starts]] lists each step).

Redeploy by dispatching **Deploy**, not by hand: a stack job builds the sites
against the dev hosts, deploys, and runs every smoke check. `wrangler deploy` and
`wrangler secret put` on a dev Worker are overwritten by the next stack deploy,
and a dev rollback made by hand carries no smoke-check message, so no later run
sees it and re-uploads the declared code.

**Dev is disposable. Prod is not.** No script in this repo can reset or seed
production, and nothing here should ever grow one.

---

## 8. Known gaps

- **The Pulse app has no dev tier.** `pulse-api` has no deploy job and no stack;
  only pulse landing deploys to dev, built without `PUBLIC_APP_URL`.
- **No staging.** `osn-db-staging` exists and stays unused; the dev tier is the
  single pre-production step by design.
- **cire and musubi dev hosts are same-site.** Both live under one dev zone,
  while in production they are cross-site, so a defect that depends on them
  being cross-site does not show on dev.
- **Unknown paths on the dev sites answer 404.** Workers static assets serve no
  `index.html` for an unknown path where Pages did; only musubi social has a
  single-page fallback ([[infrastructure-as-code#Sites]]).
- **A rollback restores code only.** No rollback undoes a D1 migration
  ([[production-deploy]] §4), and a half-applied migration has no scripted
  recovery yet (§2).
- **Free-tier caps are per account.** Dev draws on its own account's 100K Workers
  requests/day and D1 row budget, apart from production's. [[free-tier-limits]]
