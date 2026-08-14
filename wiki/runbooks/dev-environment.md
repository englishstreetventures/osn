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
last-reviewed: 2026-08-14
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
| Rate-limit namespaces | cire `1101`/`1102`, osn `2101`–`2105` | cire `1001`/`1002`, osn `2001`–`2005` |

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

Dev's RP ID is **`dev.musubi.social`** — the origin `@osn/social`'s dev
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
   `shared/`, `bun.lock`, root `package.json`/`turbo.json`/`tsconfig.json`, or
   `deploy.yml` itself also deploys everything, rather than maintaining a
   shared-package→consumer map that rots on the first new import.
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

The two secrets are deliberately named differently. A job that lands in the wrong
Environment then fails on an empty token instead of quietly deploying with the
other tier's rights. This is what closed the tracked finding **S-M
(preview-ci-prod-token)**: no push-triggered job can reach a prod-scoped
credential any more.

Store both **only** on their Environment. A repository-level `CLOUDFLARE_API_TOKEN`
is visible to every job in every workflow, gate or no gate — which hands the
unattended dev job the production credential and undoes the split. Check with
`gh secret list` (repo scope) and `gh secret list --env production`; if the token
appears at repo scope, delete it there (`gh secret delete CLOUDFLARE_API_TOKEN`)
after confirming the `production` Environment holds it.

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

### The dev database is rebuilt every deploy

`deploy-cire-api-dev` runs **reset → migrate → seed → deploy**:

```
bun run --cwd cire/db db:reset:dev    # drop every table INCLUDING d1_migrations
bun run --cwd cire/db db:migrate:dev  # replay 0001.. against an empty database
bun run --cwd cire/db db:seed:dev     # sample wedding, 4 families, 6 guests
bunx wrangler deploy --env dev        # from cire/api
```

Two things fall out of that order. Dev data never drifts from the seed, and
**every merge re-tests the whole migration chain** — a migration that only works
as an increment from the current prod shape fails here, on a disposable database,
instead of in production months later.

Both destructive steps route through `scripts/cire-dev-db-guard.sh`, which
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
   gh api repos/xchromo/osn/environments --jq '.environments[] | {name, rules: [.protection_rules[].type]}'
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
   (`dev-token-not-resource-scoped`) in [[TODO]]. Set `CLOUDFLARE_API_TOKEN_DEV` on the
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

4. **Set the dev `OSN_PAIRWISE_SALT`** with the **Set OSN_PAIRWISE_SALT**
   workflow, `tier: dev`. It generates 64 random bytes in-job, never prints them,
   and **refuses to rotate** an existing value. ✅ done — but set by hand with
   `wrangler secret put`, because `workflow_dispatch` resolves the workflow file
   against `main` and the `tier` input does not exist there until this branch
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

8. **Add the dev hostnames to the Turnstile widget's Domains** — dashboard only,
   the wrangler OAuth token lacks `Account.Turnstile:Edit`. A gated origin missing
   from that list fires `error-callback` (`110200`) and the form's submit never
   enables. [[turnstile]]

9. **Cloudflare Access** — see §5.

---

## 5. Access control on dev

Cloudflare Access (Zero Trust, free for 50 users), email-OTP policy, on the
**browser** hosts only:

`invite.dev.cireweddings.com`, `host.dev.cireweddings.com`,
`vendor.dev.cireweddings.com`, `dev.cireweddings.com`, `dev.musubi.social`.

> [!warning] Do NOT put Access on `api.dev` or `id.dev`
> An Access cookie is not sent on a cross-origin XHR. Gating the API hosts would
> break every dev fetch and the whole OIDC redirect, and the failure looks like a
> CORS bug rather than an auth policy. Those two stay guarded by the CORS
> allowlist and `origin-guard.ts`, exactly as production is.

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
5. Claim the seeded code `TESTFOR-JOY-DD44` on `invite.dev.cireweddings.com` and
   submit an RSVP. Proves the guest session cookie, the `WEB_ORIGIN` ordering and
   the D1 seed.
6. Every browser host prompts for Access; `api.dev` and `id.dev` do not.
7. Re-run the dev deploy and confirm the reset replayed migrations from zero.

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
