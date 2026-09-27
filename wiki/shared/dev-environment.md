---
title: Dev environment (cire + OSN identity)
tags: [runbooks, infra, deploy, cire, osn]
related:
  - "[[production-deploy]]"
  - "[[database-environments]]"
  - "[[free-tier-limits]]"
  - "[[musubi-identity-migration]]"
  - "[[cire-auth]]"
  - "[[oidc-provider]]"
  - "[[devloop-urls]]"
last-reviewed: 2026-09-27
---

# Dev environment (cire + OSN identity)

`cireweddings.com` serves live weddings. Before 2026-08-13 a merge to `main`
deployed straight to production, unattended — a bad merge landed on a real
couple's invite site with no stop between the two.

Now every merge deploys a **dev tier** automatically, and production waits for a
human to click approve in the same run.

```
changes ──┐
          ├──> deploy-<surface>-dev ──> deploy-<surface> (production)
build ────┘        automatic               waits for approval
```

The dev tier is **fully isolated**: its own Workers, D1, R2, rate-limit
namespaces, Upstash database and its own OSN identity origin. No dev request
reads or writes a byte of live-wedding data, and a dev account is not a
production account.

---

## 1. Tier map

| Surface | Dev host | Dev resource | Prod host |
|---|---|---|---|
| cire API | `api.dev.cireweddings.com` | Worker `cire-api-dev` (`[env.dev]`) | `api.cireweddings.com` |
| Guest invites | `invite.dev.cireweddings.com` | Worker `cire-invites-dev` | `invite.cireweddings.com` |
| Organiser portal | `host.dev.cireweddings.com` | Pages `cire-host-dev` | `host.cireweddings.com` |
| Vendor portal | `vendor.dev.cireweddings.com` | Pages `cire-vendor-dev` | `vendor.cireweddings.com` |
| Cire marketing | `dev.cireweddings.com` | Pages `cire-landing-dev` | `cireweddings.com` (apex) |
| OSN identity API | `id.dev.musubi.social` | Worker `osn-api-dev` (`[env.dev]`) | `id.musubi.social` |
| OSN social / consent | `dev.musubi.social` | Pages `osn-social-dev` | `musubi.social` |

Backing resources:

| Kind | Dev | Prod |
|---|---|---|
| D1 | `cire-db-dev` `bf0510eb-6998-4ee3-b5a0-833c646ef855` | `cire-db` `6e835474-…` |
| D1 | `osn-db-dev` `1c1425e1-bb9f-4760-b090-763ccf61eb83` | `osn-db-prod` `767a9ac1-…` |
| R2 | `cire-sheets-dev`, `cire-assets-dev` | `cire-sheets`, `cire-assets` |
| Redis | second Upstash database (**paid** — see below) | `osn-redis` (Sydney) |
| Rate-limit namespaces | cire `1101`–`1106`, osn `2101`–`2105` | cire `1001`–`1006`, osn `2001`–`2005` |
| Durable Object namespace | the dev Worker's own `TopicHub` namespace | the production Worker's |

> [!warning] The dev tier costs $10/month, and Upstash is the whole bill
> Planning assumed the Upstash free plan allowed 10 databases. It allows **one**,
> so the dev database needed a **paid $10/month plan**, bought 2026-08-14. Every
> other dev resource here is free. If the dev tier is ever cut, cancelling that
> plan is the saving. [[free-tier-limits]]

> [!note] Two-label dev hosts are free, despite the free-SSL rule
> The zone's free Universal SSL certificate does cover only the apex and **one**
> subdomain label — but no dev host rides on it. Every one is an explicit custom
> domain, and both products issue a certificate per hostname: Workers custom
> domains auto-provision an advanced certificate for the exact name (free, no ACM
> subscription), Pages custom domains use Cloudflare for SaaS certificates. Both
> work at any depth. Verified on 2026-08-14 by attaching
> `invite.dev.cireweddings.com` to `cire-invites-dev`: the certificate issued
> about two minutes after deploy, `SAN: invite.dev.cireweddings.com`, issuer
> Google Trust Services. That two-minute wait is worth remembering — a TLS
> handshake failure right after attaching a domain is provisioning, not failure.

> [!warning] Rate-limit namespace ids are the whole scope of the counter
> The Worker name is not part of the key. Reusing production's ids would let dev
> traffic burn a real guest household's claim budget. Dev takes fresh ranges —
> and `1002` was unavailable anyway: the torn-down 2026-07 preview tier used it
> and the live `CLAIM_SESSION_RATE_LIMITER` owns it now.

### WebAuthn on dev

Dev's RP ID is **`dev.musubi.social`** — the origin `@musubi/social`'s dev
deployment is served from, because a ceremony may only run on an origin same-site
with the RP ID. Deliberately **not** the `musubi.social` apex: an apex RP ID would
make a dev-enrolled credential usable against production.

Consequence, and it is expected: **a dev passkey is a separate credential.** You
enrol once on `dev.musubi.social` and that key does nothing on `musubi.social`.
See [[musubi-identity-migration]] for why RP IDs behave this way.

### What dev does *not* do

- **No mail to anyone but us.** `ZAP_API_URL` is deliberately unset on
  `cire-api-dev`, so vendor-enquiry delivery fails closed. The rest of the
  enquiry flow works; only the outbound send is inert.
- **No live feature flags.** `GROWTHBOOK_CLIENT_KEY` unset ⇒ every flag serves
  its coded default with zero network. Set it to rehearse a rollout.
- **No Cloudflare Access on the two API hosts.** See §5.

---

## 2. How a deploy runs

`.github/workflows/deploy.yml`, on push to `main` or `workflow_dispatch`.

1. **`changes`** — one boolean per deployable surface from
   `git diff --name-only "$BEFORE_SHA" HEAD`. A landing-page tweak deploys the
   landing page and nothing else. Two escalations to "deploy everything": a
   trigger with no diff base (`workflow_dispatch`), and a diff that fails to
   compute (first push, force-push — `git diff` exits 128). Any change under
   `shared/`, `bun.lock`, root `package.json`/`turbo.json`/`tsconfig.json`,
   `.browserslistrc`, or `deploy.yml` itself also deploys everything, rather
   than maintaining a shared-package→consumer map that rots on the first new
   import. The cire packages are the exception: each cire surface's filter
   lists every `@cire/*` package it bundles (`cire/ui`, `cire/dietary`,
   `cire/theme`, …), and
   [`scripts/tests/deploy-surface-map.test.ts`](../../scripts/tests/deploy-surface-map.test.ts)
   fails when a surface's `package.json` gains a `@cire/*` dependency its
   filter does not name.
2. **`build`** — install, `bun run build`, `bun run test`, `bun run test:d1`.
   Everything below `needs:` it, so nothing ships from a broken tree.
3. **`deploy-<surface>-dev`** — `environment: dev`, no reviewers, runs unattended.
4. **`deploy-<surface>`** — `needs:` its dev counterpart, `environment: production`.
   **The run parks here** until an approver clicks.

`deploy-zap-api` is production-only — zap has no dev tier (out of scope).

### Two Environments, two tokens

| Environment | Cloudflare token secret | Reviewers |
|---|---|---|
| `dev` | `CLOUDFLARE_API_TOKEN_DEV` | none |
| `production` | `CLOUDFLARE_API_TOKEN` | required |

The two secrets are deliberately named differently, so that a job landing in the
wrong Environment fails on an empty token instead of quietly deploying with the
other tier's rights. That is what closed the tracked finding **S-M
(preview-ci-prod-token)**: no push-triggered job can reach a prod-scoped
credential any more.

**Both secrets now sit on their Environments.** Each tier holds its own token,
and `CLOUDFLARE_ACCOUNT_ID` sits on both alongside it. The `Cloudflare
credential scope` job in `deploy.yml` prints which credential a run actually
got; read its line rather than assuming.

*Measured 2026-09-11 — run 34578664876 on `main` printed `Dev jobs in this run
hold CLOUDFLARE_API_TOKEN_DEV (dev Environment)`, and all seven dev and all
eight production deploys were green on the Environment-scoped tokens.*

#### Where the tokens live

Both are **user-owned tokens**, listed under My Profile → API Tokens
(`dash.cloudflare.com/profile/api-tokens`). Cloudflare keeps a second, separate
list of **account-owned** tokens under Manage Account → API Tokens, and a token
in one list never appears in the other.

Look in the profile list. A token there is visible only to the Cloudflare user
who created it, so no other account member can see or rotate these two — an
accepted trade for now, and the reason this paragraph exists. Searching the
account list and finding nothing does not mean the token is gone.

Permissions granted to `CLOUDFLARE_API_TOKEN_DEV`, one line per thing the dev
jobs actually call:

| Scope | Permission | What needs it |
|---|---|---|
| Account | `Workers Scripts: Edit` | `wrangler deploy --env dev` for cire-api and osn-api, plus their cron triggers and rate-limit bindings |
| Account | `D1: Edit` | `db:migrate:dev` in `cire/db` and `osn/db`, and the D1 bindings |
| Account | `Cloudflare Pages: Edit` | `pages deploy` and `pages project create` for cire-host-dev, cire-landing-dev, cire-vendor-dev, osn-social-dev |
| Account | `Workers R2 Storage: Edit` | the `cire-assets` bucket binding — R2 is the one permission Cloudflare scopes per bucket, so restrict it to the dev bucket |
| Account | `Account Settings: Read` | wrangler's account lookup, on every call |
| Zone | `Zone: Read` | route resolution |
| Zone | `Workers Routes: Edit` | the `custom_domain = true` routes on `[env.dev]` for cire-api and osn-api |

`Workers KV Storage: Edit` is **not** granted and is not needed: the only
`kv_namespaces` block in the repo is commented out, in `cire/api/wrangler.toml`.
Uncomment it and the token needs that permission too.

One case is untested. `custom_domain = true` provisions a DNS record and a
certificate the first time it runs, which may want `DNS: Edit` and `SSL and
Certificates: Edit` on the zone. Every dev custom domain already exists, so
steady-state deploys never re-provision and the token has neither. If a *new*
dev Worker on a *new* custom domain ever fails at the DNS step, that is the
cause — do not grant them before then.

#### The fallback is now dead code

Every dev job in `deploy.yml` still reads

```yaml
CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN_DEV || secrets.CLOUDFLARE_API_TOKEN }}
```

and a `||` cannot tell a missing secret from a deliberate one. With
`CLOUDFLARE_API_TOKEN_DEV` unset the fallback was taken silently, and a dev job
ran on whatever `CLOUDFLARE_API_TOKEN` resolved to — a repository-scope copy,
visible to every job in every workflow, gate or no gate. That is the state this
section used to describe. It is no longer the state: the left side of the `||`
is set, so the right side is never reached. Leave the expression alone anyway —
it costs nothing and it is what makes a wrongly-placed job fail loudly.

#### Repository scope holds no writing credential

Done, 2026-09-13. `CLOUDFLARE_API_TOKEN` no longer exists at repository scope.
Every credential that can write to Cloudflare now sits on an Environment, and
those two Environments are the only places a job can reach one.

*Measured 2026-09-13 — `gh secret list --repo englishstventures/osn` returns
ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, CLOUDFLARE_ACCOUNT_ID,
CLOUDFLARE_API_TOKEN_READONLY, RELEASE_TOKEN and TESSL_TOKEN — no deploy token
among them.*

`free-tier-ceiling-alert.yml` was the one workflow that had to change before
that delete. It declares no `environment:`, by design — it is a scheduled
watcher, and it cannot take `environment: production`, because that gate waits
on a person and nobody approves a cron at 22:00 UTC. So it now carries its own
repository-scope secret, `CLOUDFLARE_API_TOKEN_READONLY`, a separate Cloudflare
token granted only:

| Scope | Permission | What needs it |
|---|---|---|
| Account | `Account Settings: Read` | resolving the account the counters belong to |
| Account | `D1: Read` | the D1 rows-written and reads counters |
| Account | `Account Analytics: Read` | the `d1AnalyticsAdaptiveGroups` and `workersInvocationsAdaptive` GraphQL sets — a token without it returns an authentication error, not empty data |

No write right of any kind. A read-only token at a scope every job can read is a
much smaller thing to leak than a deploy token at the same scope, which is the
whole point of the swap.

Before adding a workflow that touches Cloudflare, check what scope it resolves
at rather than trusting this page: `grep -l CLOUDFLARE .github/workflows/*.yml`,
then read each hit for an `environment:` line. As of 2026-09-13 the other four
(`deploy.yml`, `cire-dev-db-rebuild.yml`, `deploy-osn-pulse-landing.yml`,
`set-osn-api-secret.yml`) all declare one. A workflow that declares none and
needs to write has no credential to read — that is the design. Give it an
Environment, or a job that can be approved; do not answer it by putting a
writing token back at repository scope.

`CLOUDFLARE_ACCOUNT_ID` stays at repository scope. It is not a secret — it is an
identifier that appears in wrangler output — and the alert workflow needs it.

**What the split does not buy.** `Workers Scripts:Edit` and `D1:Edit` are
account-level permissions — Cloudflare offers no per-script or per-database
resource filter, and only R2 scopes per bucket. So `CLOUDFLARE_API_TOKEN_DEV`
can write production Workers as well, however the token is named. The boundary
is the approval gate plus a separate credential to revoke, not a narrower grant.
The only hard boundary is a **separate Cloudflare account** for dev; that is
tracked as an open item rather than done here, because a second account means a
second zone, second D1 set and second Upstash, and the cost maths changes.

### Concurrency is per job, not per workflow

A workflow-level `concurrency` group would make the whole run the unit of
exclusion — and since prod jobs park waiting for a human, the *next* merge's dev
deploy would queue behind that click. Each job takes a group named for its own
surface **and** tier (`deploy-dev-cire-api`, `deploy-production-cire-api`), so two
runs never deploy the same thing at once while unrelated surfaces stay parallel.

The dev cire job also sets **`cancel-in-progress: true`**. A burst of merges
otherwise queues one dev deploy per merge, and each one only brings dev to the
shape the last one would; superseding them is free. Cancelling mid-flight can
leave dev's database one migration ahead of its Worker, which the next merge
puts right — the tier is disposable, and the alternative was multiplying the D1
bill by the size of the burst (englishstventures/osn#980). **Production stays
`cancel-in-progress: false`**: a half-deployed live wedding is not a trade worth
making.

### The dev database is rebuilt nightly, not every deploy

`deploy-cire-api-dev` runs **migrate → deploy**, applying migrations forward
exactly as production does:

```
bun run --cwd cire/db db:migrate:dev  # apply anything not in d1_migrations yet
bunx wrangler deploy --env dev        # from cire/api
```

The full rebuild — **reset → migrate → seed** — moved to its own workflow,
`.github/workflows/cire-dev-db-rebuild.yml`, on a nightly schedule (14:00 UTC,
01:00 in Sydney) and `workflow_dispatch`:

```
bun run --cwd cire/db db:reset:dev    # drop every table INCLUDING d1_migrations
bun run --cwd cire/db db:migrate:dev  # replay 0001.. against an empty database
bun run --cwd cire/db db:seed:dev     # the sample wedding, at production scale
```

**Why it moved.** A rebuild costs **8,007 D1 rows written and about 22,630
read**, and the free tier allows 100,000 written a day across every database on
the account. Thirteen merges on 2026-09-09 spent 104,091 and went over the
ceiling. Almost none of that is the seed: SQLite rebuilds the whole table for
every `ALTER TABLE ... DROP COLUMN`, and D1 bills the schema churn even against
empty tables. Of the 200 heaviest queries on `cire-db-dev` in a week, DDL
accounted for 89% of rows written and 99.7% of rows read; the seed's `INSERT`s
were 11% and 0.3%. See englishstventures/osn#979.

The rebuild also shares the deploy's `deploy-dev-cire-api` concurrency group, so
a rebuild and a deploy never touch `cire-db-dev` at once.

The seeded wedding matches a real live one in shape and size — 5 events, 199
households, 494 guests, 1131 invitations, 168 replies, 3 co-hosts, all 4
entitlements comped, and the invite customisation row. Four households and six
guests are hand-written (`seed/data/`) and are the ones every claim-code and RSVP
test uses; the rest are generated from a seeded PRNG in `seed/data/households.ts`
so a list, a search and a dashboard count all have enough rows to be honest. **No
real guest's details are copied into dev** — the synthetic names, codes and
dietary notes are invented and deterministic.

### Placeholder images (one-off, not CI)

The seed stores R2 object **keys**, not URLs. A key with nothing behind it is a
broken image on every guest page, and R2 objects survive the D1 reset — so the
images are uploaded once per bucket, by hand, not on every deploy:

```bash
bun run --cwd cire/db assets:seed:dev   # 8 generated PNGs -> cire-assets-dev
```

It writes the hero, story and footer slots plus one image per event. The pictures
are generated gradients, not photographs: the bucket is `cire-assets-dev`, pinned
in `seed/assets.ts`, and no couple's photo is ever copied onto a tier this many
people can reach. Re-run only after recreating the bucket.

**What still re-tests the migration chain.** The nightly rebuild replays it from
zero against real D1, and that is the only place DDL which `bun:sqlite` accepts
but D1 rejects gets caught. Most of the proof is cheaper and more frequent than
that: `cire/api/tests/db/ddl-lockstep.test.ts` (T-S1) applies the whole chain to
an in-memory database on every `bun test`, so on every pull request, and diffs a
normalised snapshot of it against the DDL mirror in `cire/api/src/db/setup.ts`
and the Drizzle schema. A migration that only works as an increment fails there
first.

Dev data now gets its clean floor once a night rather than once a merge, so a
wedding a tester made by hand survives the working day.

Both destructive steps route through `scripts/cire-dev-db-guard.ts`, which
re-derives the target from `cire/api/wrangler.toml` at run time and aborts unless
`[env.dev]` really is `cire-db-dev` with an id no other environment shares. There
is no flag anywhere in `cire/db` that can reset or seed production.

**`osn-db-dev` is NOT reset.** Accounts and passkeys are the thing being tested,
and wiping them every merge would mean re-enrolling a credential before every
manual check. Migrations still apply forward.

---

## 3. Promoting to production

1. Merge the PR. The run starts; dev deploys within a few minutes.
2. Check dev (§6 below, or just the surface you changed).
3. Open the run in Actions. Each prod job shows **Review deployments**.
4. Approve. Prod jobs run in the same run, and GitHub records who approved on the
   run itself.

Rejecting leaves dev ahead of prod. That is a valid resting state — the next
merge's dev deploy is unaffected. To ship later, re-run the prod jobs from the
same run, or merge the next change and approve that run.

**A prod job never runs without its dev counterpart having succeeded**
(`needs: deploy-<surface>-dev`). Promotion is an edge in the graph, not a
convention.

---

## 4. One-time setup

Everything below needs the dashboard or a credential CI does not hold. Ordered — do
them in this order, and do them **before** the first merge that would fire the dev jobs.

Status as of 2026-08-14: **steps 1–6 are done** — both dev databases, both R2 buckets
and the dev Upstash database exist, the D1 ids are in the wrangler blocks, both GitHub
Environments are armed, every dev Worker secret is set, both dev Workers are deployed
and answering on their custom domains, the dev `oauth_clients` row is seeded and
`cire-api` is ARC-registered against the dev issuer. **Steps 7–9 are open** and are all
dashboard-only.

> **Bootstrap ordering.** `wrangler secret put` needs the Worker to exist, so the very
> first pass is **deploy → set secrets → deploy again**. The second deploy is not
> optional: `secret put` does not cycle warm isolates, so a Worker deployed before its
> secrets keeps answering from the isolate that has none.

1. **Create the backing resources.** ✅ done
   ```bash
   bunx wrangler d1 create cire-db-dev --location oc
   bunx wrangler d1 create osn-db-dev  --location oc
   bunx wrangler r2 bucket create cire-sheets-dev
   bunx wrangler r2 bucket create cire-assets-dev
   ```
   Paste each real `database_id` into the matching `[[env.dev.d1_databases]]`
   block. `scripts/check-d1-database-id.sh` fails CI on a placeholder.
   The Upstash dev database sits in the same Sydney region as prod. It needed a
   **paid $10/month plan** — the free plan allows one database, not ten. Its REST
   URL and token go in as Worker secrets in step 3.

2. **Create the GitHub Environments.** ✅ done — `dev` carries a branch policy only
   (`main`), `production` carries **Required reviewers** (`chav-aniket`) plus the same
   branch policy. Verify with:

   ```bash
   gh api repos/englishstventures/osn/environments --jq '.environments[] | {name, rules: [.protection_rules[].type]}'
   ```

   `production` had existed with **empty** protection rules, so the approval gate this
   whole pipeline depends on was not armed until 2026-08-14. Re-check it after any
   repo-settings change; an unarmed `production` silently deploys straight to the live
   couples' sites.

   **On the two token names.** Every dev job reads
   `${{ secrets.CLOUDFLARE_API_TOKEN_DEV || secrets.CLOUDFLARE_API_TOKEN }}`; prod jobs
   read the bare `CLOUDFLARE_API_TOKEN`. `CLOUDFLARE_API_TOKEN_DEV` is **not set today**
   and an unset secret is the empty string, so dev falls through to the prod-scoped
   token. That is deliberate: it was decided on 2026-08-14 to ship the dev tier on the
   single existing Cloudflare account and take separate accounts later. A second token
   inside one account buys nothing anyway — `Workers Scripts:Edit` and `D1:Edit` are
   account-scoped with no per-script or per-database filter (only R2 scopes per bucket),
   so a token named `…_DEV` can still write production Workers. The boundary that makes
   the name real is a **separate Cloudflare account**, tracked as S-M
   (`dev-token-not-resource-scoped`) in `englishstventures/osn-tracker`. Set `CLOUDFLARE_API_TOKEN_DEV` on the
   `dev` Environment the day that account exists — no workflow change needed, the
   fallback picks it up.

   `CLOUDFLARE_ACCOUNT_ID` is shared by both Environments.

3. **Set the dev Worker secrets.** ✅ done. Same inventory as production
   ([[production-deploy]] §3.1/§3.2), `--env dev`:

   ```bash
   cd osn/api
   bunx wrangler secret put OSN_JWT_PRIVATE_KEY      --env dev   # own keypair
   bunx wrangler secret put OSN_JWT_PUBLIC_KEY       --env dev
   bunx wrangler secret put OSN_SESSION_IP_PEPPER    --env dev
   bunx wrangler secret put OSN_TOTP_ENCRYPTION_KEY  --env dev   # openssl rand -base64 32 — KEEP YOUR COPY, rotating it needs the old value ([[production-deploy#10. Rotating OSN_TOTP_ENCRYPTION_KEY]])
   bunx wrangler secret put UPSTASH_REDIS_REST_URL   --env dev
   bunx wrangler secret put UPSTASH_REDIS_REST_TOKEN --env dev
   bunx wrangler secret put RESEND_API_KEY           --env dev
   bunx wrangler secret put INTERNAL_SERVICE_SECRET  --env dev
   cd ../../cire/api
   bunx wrangler secret put CIRE_OIDC_CLIENT_SECRET  --env dev
   bunx wrangler secret put CIRE_API_ARC_PRIVATE_KEY --env dev   # own ARC keypair
   bunx wrangler secret put CIRE_API_ARC_KEY_ID      --env dev
   bunx wrangler secret put OSN_API_URL              --env dev   # https://id.dev.musubi.social
   ```

   > ⚠️ Never `source` a secrets file to set a JWK-shaped value — an unquoted
   > `{"a":"b"}` is mangled by brace expansion. Extract and pipe:
   > ```bash
   > VAL=$(grep -m1 '^KEY=' "$SF" | sed 's/^[^=]*=//'); printf '%s' "$VAL" | bunx wrangler secret put KEY --env dev
   > ```

   Three of these are easy to miss because they are not in the production secrets
   file under an obvious name:

   - `OSN_API_URL` is a **secret, not a var** on cire-api, and it feeds the ARC
     bridge. Absent ⇒ `POST /api/account/link` answers 503.
   - `OSN_PAIRWISE_SALT` is step 4, not this list.
   - Two are deliberately **left unset on dev, matching production**:
     `CIRE_INTERNAL_REVOKE_SECRET`, and `TURNSTILE_SECRET_KEY` — the Turnstile gate
     is key-optional and fail-closed, so setting the key before the dev hostnames
     are in the widget's Domains (step 8) breaks **every** guest claim. That exact
     incident hit production on 2026-07-20. [[turnstile]]

   > On this machine `bunx --bun wrangler` is silently broken — every
   > network-touching command prints nothing and exits 0. Use plain `bunx wrangler`
   > (node), notwithstanding the repo-wide `bunx --bun` rule.

4. **Set the dev `OSN_PAIRWISE_SALT`** with the **Set an osn-api Worker
   secret** workflow, `secret: OSN_PAIRWISE_SALT`, `tier: dev`. It generates 64
   random bytes in-job, never prints them, and **refuses to rotate** an existing
   value. ✅ done — but set by hand with `wrangler secret put`, because
   `workflow_dispatch` resolves the workflow file against `main` and neither the
   `tier` input nor the generalised workflow exists there until this branch
   merges. Same effect; from the next dev bootstrap on, use the workflow.

   > ⚠️ The dev salt must never be rotated either. Rotation changes every pairwise
   > `sub`, so every dev relying party sees its users as strangers — permanently.
   > Each tier gets its **own** salt: a shared one would make a dev `sub` equal
   > the prod `sub` for the same account, and a dev client pointed at prod would
   > recognise real users. [[oidc-provider]]

   `deploy-osn-api-dev` preflights this secret and fails with an actionable error
   rather than deploying a Worker that 503s every route.

5. **Seed the dev `oauth_clients` row** ✅ done — in `osn-db-dev`, `client_id` `cid_cire`,
   redirect URI `https://api.dev.cireweddings.com/api/auth/oidc/callback`,
   `sector_identifier` `cireweddings.com`, `is_first_party = 1`. The row's hash
   must be the SHA-256 of the `CIRE_OIDC_CLIENT_SECRET` set in step 3. Shape and
   procedure: [[production-deploy]] §3.5.

6. **Register `cire-api-dev` for ARC** ✅ done — `POST /graph/internal/register-service`
   against `id.dev.musubi.social`, bearing `INTERNAL_SERVICE_SECRET`. Idempotent
   and per-environment; a non-local env throws at startup without it. Body:
   `serviceId: "cire-api"`, `keyId` = the `CIRE_API_ARC_KEY_ID` UUID,
   `publicKeyJwk` = the public JWK **as a JSON string**, `allowedScopes` =
   `graph:read,graph:resolve-account,org:read` (drop `org:read` and every
   `/api/vendor/*` write answers 503). Note the two key encodings differ: the OSN
   JWT keys are **base64-encoded** JWK JSON, the ARC keys are a **raw** JWK string.

7. **Attach the custom domains.** Worker routes (`api.dev`, `invite.dev`,
   `id.dev`) auto-provision from `custom_domain = true` on deploy — ✅ all three
   are live. The four Pages projects exist and have had their first dev deploy
   (bootstrapped by hand on 2026-08-14, the same build env the CI jobs use), so
   each answers on its `*.pages.dev` URL. **Attaching the custom domain is still
   open** and is dashboard-only: wrangler has no `pages domain` command, and the
   Pages domains API needs a real API token — the OAuth login CI and this machine
   use cannot reach it. Pages → project → Custom domains:

   | Project | Domain to attach |
   |---|---|
   | `cire-host-dev` | `host.dev.cireweddings.com` |
   | `cire-vendor-dev` | `vendor.dev.cireweddings.com` |
   | `cire-landing-dev` | `dev.cireweddings.com` |
   | `osn-social-dev` | `dev.musubi.social` |

   `dev.musubi.social` is not cosmetic — it is the dev **WebAuthn RP ID**. Until it
   resolves, no dev passkey can be registered and verification steps 3 and 4 cannot
   run.

8. **Turnstile domains — nothing to do.** Checked on 2026-08-14 and left alone.
   The one account widget `osn-turnstile` lists the two **apexes**
   `cireweddings.com` and `musubi.social`, and Turnstile matches subdomains, so
   every dev host is already allowed. Confirmed live: the widget renders on
   `dev.musubi.social` with no `error-callback` (`110200`) and no console error.
   Only add an entry here if a dev host ever moves off those two zones.
   [[turnstile]]

9. **Cloudflare Access** — done 2026-08-15, one application over all five browser
   hosts. See §5.

---

## 5. Access control on dev

Cloudflare Access (Zero Trust, free for 50 users), email-OTP policy, on the
**browser** hosts only:

`invite.dev.cireweddings.com`, `host.dev.cireweddings.com`,
`vendor.dev.cireweddings.com`, `dev.cireweddings.com`, `dev.musubi.social`.

**Live since 2026-08-15.** Zero Trust Free is onboarded; the team domain is
`wispy-sun-215a.cloudflareaccess.com`. All five hosts 302 to
`…cloudflareaccess.com/cdn-cgi/access/login/<host>` before the app is reached.

What exists, exactly — **one** self-hosted application, not one per host:

| Field | Value |
|---|---|
| Application name | `cire dev tier` |
| Type | Self-hosted |
| Destinations | the five public hostnames above |
| Policy | `allow owner email` — Action `Allow`, Include `Emails` → `chavaniket@duck.com` |
| Identity | "Accept all available identity providers" left **on**; One-time PIN is the only IdP on this account, so that is the email-OTP path |
| Session duration | 24 hours |

One app beats five because an Access session is **per application**: five apps
would mean five separate OTP prompts for one browsing session. Five is also the
cap — the form refuses a sixth destination with *"You've added the maximum number
of hostnames per application allowed."* A sixth dev host needs a second
application, and then two OTP prompts.

Add more people by adding emails to `allow owner email`, never by adding an
application.

> [!note] Building it in the dashboard
> Save the policy with **Save policy** inside the Access-policies card *before*
> clicking **Create**. Until you do, the Preview card reads "No policies added /
> No destinations assigned" — which looks like the destinations were lost, but
> they are only unrendered. Use the **Builder** tab rather than "Create new
> policy", which navigates away and drops the unsaved destination list.

> [!warning] Do NOT put Access on `api.dev` or `id.dev`
> An Access cookie is not sent on a cross-origin XHR. Gating the API hosts would
> break every dev fetch and the whole OIDC redirect, and the failure looks like a
> CORS bug rather than an auth policy. Those two stay guarded by the CORS
> allowlist and `origin-guard.ts`, exactly as production is.

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
curl -s -o /dev/null -w '%{http_code}\n' https://id.dev.musubi.social/openapi/json  # 200
curl -s -o /dev/null -w '%{http_code}\n' https://id.musubi.social/openapi/json      # 404
```

`pulse-api` has no deployed tier yet. Its `[env.dev.vars]` still points at
localhost and deliberately leaves `OSN_ENV` unset, which reads as `local`, so
`wrangler dev --env dev` keeps its docs; set `OSN_ENV = "dev"` there in the same
commit that gives that env real https origins. `staging` and `production` do set
it, which also switches on the cookie `Secure` flag, the plaintext-JWKS refusal
and the fail-closed CORS check on those tiers — all three were silently off
before, since the code keys them off the same var.

### Passkey-less sign-in on local and dev

A passkey is the only primary login factor, so a seeded account is unreachable:
nobody can enrol a WebAuthn credential on behalf of a row a seed script wrote.
`GET /dev/login` on `osn-api` mints a **real** OSN session for one fixed
principal instead, so the OIDC chain, the organiser portal, the vendor portal and
`@musubi/social` all run untouched — there is no bypass anywhere else in the stack.

The principal is fixed and provisioned on first use (idempotent, so it survives
`osn-db-dev` never being reset):

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

# deployed dev — one-time. Park the value on the dev GitHub Environment, then
# let the workflow put it on the Worker; neither step prints it.
gh secret set DEV_LOGIN_SECRET --repo englishstventures/osn --env dev --body "$SECRET"
gh workflow run set-osn-api-secret.yml -f secret=DEV_LOGIN_SECRET -f tier=dev
# then redeploy osn-api to cycle warm isolates — deps are built once per isolate
open "https://id.dev.musubi.social/dev/login?secret=$SECRET&return_to=https://host.dev.cireweddings.com/dashboard"
```

`return_to` is optional; without it the response is the session JSON. With it the
route 302s, after checking the target's origin against
**`DEV_LOGIN_RETURN_ORIGINS`** — a comma-separated var of its own, already set in
`wrangler.toml`'s `[env.dev.vars]` for the four dev browser hosts. Locally the
`dev-env` launcher sets it to this worktree's own portless hosts, so a linked
worktree allows its own surfaces and no other's ([[devloop-urls]]). An off-list `return_to` is a 400, never a
redirect, so the endpoint can't be turned into an open redirect that leaks the
session cookie. **Unset ⇒ every `return_to` is a 400** — closed by default, so
each origin is an explicit decision.

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
> the route unmounted and the production deploy job **fails** while
> `DEV_LOGIN_SECRET` is set on `osn-api-production`. Tracked open as `S-L3` in
> `englishstventures/osn-tracker` (#437).

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
> `vendor.dev` therefore authenticates fine and shows an empty directory listing
> until that row is seeded.

---

## 6. Verifying the dev tier

A dev tier is only proven when a passkey ceremony completes end to end — a
ceremony spans two requests, so it is what catches Redis being misconfigured.

1. `cire-api` has **no health route** in any tier — `/health` is a 404 on dev and
   on production alike, so it proves nothing. Probe two real routes instead and
   read the status codes, not the bodies:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://api.dev.cireweddings.com/api/claim/session
   # 401 — the route ran. A 503 here means the CLAIM_RATE_LIMITER binding is
   # missing and the deployed-tier guard failed closed.

   curl -s -o /dev/null -w '%{http_code}\n' https://api.dev.cireweddings.com/api/auth/oidc/start
   # 400 — the handler ran and rejected the empty body. A 503 means one of
   # OSN_ISSUER_URL / CIRE_API_ORIGIN / CIRE_OIDC_CLIENT_ID / _SECRET is unset.

   bunx wrangler tail cire-api-dev   # tier logs as `dev`, not `local`
   ```

2. `https://id.dev.musubi.social/.well-known/jwks.json` serves keys, and
   `/.well-known/openid-configuration` reports
   `"issuer": "https://id.dev.musubi.social"` — not the prod issuer.
3. Register a **new** passkey on `https://dev.musubi.social`, sign out, sign back
   in. Proves Upstash-backed ceremony state survives across requests.
4. Sign in on `host.dev.cireweddings.com` through the OIDC redirect. Proves the
   dev `oauth_clients` row, the pairwise salt and the redirect URI agree.

   Steps 3 and 4 both passed on 2026-08-15. Neither leaves a log line worth
   keeping, so check the two databases instead — `osn-db-dev` should hold
   `accounts`/`users`/`passkeys`/`sessions`/`oauth_consents` = 1 each with
   `oauth_authorization_codes` back to 0 (the code is single-use and consumed),
   and `cire-db-dev` should hold one `organiser_sessions` row. A consent row with
   no organiser session means the token came back but cire refused it — look at
   `CIRE_OIDC_CLIENT_SECRET` and the pairwise salt.
5. Claim the seeded code `TESTFOR-JOY-DD44` on `invite.dev.cireweddings.com` and
   submit an RSVP. Proves the guest session cookie, the `WEB_ORIGIN` ordering and
   the D1 seed. Passed 2026-08-15 — the reply lands in `rsvps` with
   `status = 'attending'` and a seconds-precision `created_at`.
6. Every browser host prompts for Access; `api.dev` and `id.dev` do not. No
   browser needed — `curl -sI` each one. Verified 2026-08-15: the five browser
   hosts return **302** to
   `https://wispy-sun-215a.cloudflareaccess.com/cdn-cgi/access/login/<host>`,
   `api.dev.cireweddings.com/api/claim/session` still returns **401** and
   `id.dev.musubi.social/.well-known/openid-configuration` still returns **200**.
   A 302 on either API host means Access was put on the wrong destination — pull
   it off before anything else.
7. Run the **Rebuild cire dev D1** workflow by hand (`workflow_dispatch`) and
   confirm the reset replayed migrations from zero.

---

## 7. Resetting or repairing dev by hand

```bash
# Wipe + rebuild the cire dev database (what CI does on every deploy)
bun run --cwd cire/db db:reset:dev
bun run --cwd cire/db db:migrate:dev
bun run --cwd cire/db db:seed:dev

# Apply osn dev migrations without touching accounts
bun run --cwd osn/db db:migrate:dev

# Redeploy one Worker out of band
bunx wrangler deploy --env dev        # from cire/api or osn/api

# Watch a dev Worker
bunx wrangler tail cire-api-dev
bunx wrangler tail osn-api-dev

# Redeploy a dev frontend out of band. The PUBLIC_*/VITE_* values are baked in at
# build time, so they must be passed to the BUILD, not the deploy — a bundle built
# without them points at production.
PUBLIC_ORGANISER_URL=https://host.dev.cireweddings.com SITE=https://dev.cireweddings.com \
  bun run --cwd cire/landing build
(cd cire/landing && bunx wrangler pages deploy dist --project-name cire-landing-dev --branch main --commit-dirty=true)
```

Each dev job in `deploy.yml` carries the full env block for its surface — copy it
from there rather than retyping the hostnames. `cire/invites` is the odd one out:
it is a **Worker**, not Pages, and its generated `dist/server/wrangler.json` must be
retargeted at `cire-invites-dev` before `wrangler deploy` (the committed
`wrangler.jsonc` names the production Worker). The job does that rewrite inline.

Every remote script names its target database explicitly **and** passes `--env`.
Neither is optional: without `--env`, wrangler resolves the name against the
top-level config, so a script meant for dev silently hits the top-level binding.

`wrangler secret put/delete` does **not** cycle warm isolates. After a dev secret
change that must take effect now, redeploy.

**Dev is disposable. Prod is not.** No script in this repo can reset or seed
production, and nothing here should ever grow one.

---

## 8. Known gaps

- **Zap and Pulse have no dev tier.** `deploy-zap-api` is production-only.
- **No staging.** `osn-db-staging` exists and stays unused; the dev tier is the
  single pre-production step by design.
- **No automated rollback.** Reverting means merging a revert and approving it.
- **Free-tier caps are account-wide.** Dev traffic draws on the same 100K Workers
  requests/day and the same D1 row budget as production. [[free-tier-limits]]
