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
| cire API | `api-dev.cireweddings.com` | Worker `cire-api-dev` (`[env.dev]`) | `api.cireweddings.com` |
| Guest invites | `invite-dev.cireweddings.com` | Worker `cire-invites-dev` | `invite.cireweddings.com` |
| Organiser portal | `host-dev.cireweddings.com` | Pages `cire-host-dev` | `host.cireweddings.com` |
| Vendor portal | `vendor-dev.cireweddings.com` | Pages `cire-vendor-dev` | `vendor.cireweddings.com` |
| Cire marketing | `dev.cireweddings.com` | Pages `cire-landing-dev` | `cireweddings.com` (apex) |
| OSN identity API | `id-dev.musubi.social` | Worker `osn-api-dev` (`[env.dev]`) | `id.musubi.social` |
| OSN social / consent | `dev.musubi.social` | Pages `osn-social-dev` | `musubi.social` |

Backing resources:

| Kind | Dev | Prod |
|---|---|---|
| D1 | `cire-db-dev` `bf0510eb-6998-4ee3-b5a0-833c646ef855` | `cire-db` `6e835474-…` |
| D1 | `osn-db-dev` `1c1425e1-bb9f-4760-b090-763ccf61eb83` | `osn-db-prod` `767a9ac1-…` |
| R2 | `cire-sheets-dev`, `cire-assets-dev` | `cire-sheets`, `cire-assets` |
| Redis | second free Upstash database | `osn-redis` (Sydney) |
| Rate-limit namespaces | cire `1101`/`1102`, osn `2101`–`2105` | cire `1001`/`1002`, osn `2001`–`2005` |

> [!important] Hostnames are one label deep on purpose
> `invite-dev.cireweddings.com`, not `invite.dev.cireweddings.com`. Cloudflare's
> free Universal SSL certificate covers the apex and **one** subdomain label. A
> two-label host needs Advanced Certificate Manager (paid), so every dev host
> flattens the tier into the label itself.

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
second zone, second D1 set and second Upstash, and the free-tier maths changes.

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

Status as of 2026-08-14: **steps 1 and 2 are done** — `cire-db-dev`, `osn-db-dev` and
both R2 buckets exist with their real ids in the wrangler blocks, and both GitHub
Environments exist and are armed. The Upstash dev database (part of step 1) and steps
3–9 are open.

1. **Create the backing resources.** ✅ done — except Upstash
   ```bash
   bunx wrangler d1 create cire-db-dev --location oc
   bunx wrangler d1 create osn-db-dev  --location oc
   bunx wrangler r2 bucket create cire-sheets-dev
   bunx wrangler r2 bucket create cire-assets-dev
   ```
   Paste each real `database_id` into the matching `[[env.dev.d1_databases]]`
   block. `scripts/check-d1-database-id.sh` fails CI on a placeholder.
   Create the second Upstash database (free plan allows 10) in the same Sydney
   region as prod.

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

3. **Set the dev Worker secrets.** Same inventory as production
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
   ```

   > ⚠️ Never `source` a secrets file to set a JWK-shaped value — an unquoted
   > `{"a":"b"}` is mangled by brace expansion. Extract and pipe:
   > ```bash
   > VAL=$(grep -m1 '^KEY=' "$SF" | sed 's/^[^=]*=//'); printf '%s' "$VAL" | bunx wrangler secret put KEY --env dev
   > ```

4. **Set the dev `OSN_PAIRWISE_SALT`** with the **Set OSN_PAIRWISE_SALT**
   workflow, `tier: dev`. It generates 64 random bytes in-job, never prints them,
   and **refuses to rotate** an existing value.

   > ⚠️ The dev salt must never be rotated either. Rotation changes every pairwise
   > `sub`, so every dev relying party sees its users as strangers — permanently.
   > Each tier gets its **own** salt: a shared one would make a dev `sub` equal
   > the prod `sub` for the same account, and a dev client pointed at prod would
   > recognise real users. [[oidc-provider]]

   `deploy-osn-api-dev` preflights this secret and fails with an actionable error
   rather than deploying a Worker that 503s every route.

5. **Seed the dev `oauth_clients` row** in `osn-db-dev` — `client_id` `cid_cire`,
   redirect URI `https://api-dev.cireweddings.com/api/auth/oidc/callback`,
   `sector_identifier` `cireweddings.com`, `is_first_party = 1`. The row's hash
   must be the SHA-256 of the `CIRE_OIDC_CLIENT_SECRET` set in step 3. Shape and
   procedure: [[production-deploy]] §3.5.

6. **Register `cire-api-dev` for ARC** — `POST /graph/internal/register-service`
   against `id-dev.musubi.social`, bearing `INTERNAL_SERVICE_SECRET`. Idempotent
   and per-environment; a non-local env throws at startup without it.

7. **Attach the custom domains.** Worker routes (`api-dev`, `invite-dev`,
   `id-dev`) auto-provision from `custom_domain = true` on deploy. The four Pages
   projects need their domain attached in the dashboard —
   Pages → project → Custom domains.

8. **Add the dev hostnames to the Turnstile widget's Domains** — dashboard only,
   the wrangler OAuth token lacks `Account.Turnstile:Edit`. A gated origin missing
   from that list fires `error-callback` (`110200`) and the form's submit never
   enables. [[turnstile]]

9. **Cloudflare Access** — see §5.

---

## 5. Access control on dev

Cloudflare Access (Zero Trust, free for 50 users), email-OTP policy, on the
**browser** hosts only:

`invite-dev.cireweddings.com`, `host-dev.cireweddings.com`,
`vendor-dev.cireweddings.com`, `dev.cireweddings.com`, `dev.musubi.social`.

> [!warning] Do NOT put Access on `api-dev` or `id-dev`
> An Access cookie is not sent on a cross-origin XHR. Gating the API hosts would
> break every dev fetch and the whole OIDC redirect, and the failure looks like a
> CORS bug rather than an auth policy. Those two stay guarded by the CORS
> allowlist and `origin-guard.ts`, exactly as production is.

---

## 6. Verifying the dev tier

A dev tier is only proven when a passkey ceremony completes end to end — a
ceremony spans two requests, so it is what catches Redis being misconfigured.

1. `curl https://api-dev.cireweddings.com/health` → 200. `wrangler tail
   cire-api-dev` shows the tier as `dev`, not `local`.
2. `https://id-dev.musubi.social/.well-known/jwks.json` serves keys.
3. Register a **new** passkey on `https://dev.musubi.social`, sign out, sign back
   in. Proves Upstash-backed ceremony state survives across requests.
4. Sign in on `host-dev.cireweddings.com` through the OIDC redirect. Proves the
   dev `oauth_clients` row, the pairwise salt and the redirect URI agree.
5. Claim the seeded code `TESTFOR-JOY-DD44` on `invite-dev.cireweddings.com` and
   submit an RSVP. Proves the guest session cookie, the `WEB_ORIGIN` ordering and
   the D1 seed.
6. Every browser host prompts for Access; `api-dev` and `id-dev` do not.
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
```

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
