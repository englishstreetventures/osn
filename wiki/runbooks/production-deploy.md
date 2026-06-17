---
title: Production Deploy Runbook (osn + cire)
description: End-to-end runbook for the first production deploy of osn-api and the cire stack (api worker + guest/organiser Pages). Enumerates every required secret/var by source line.
tags: [runbook, deploy, production, osn, cire, secrets, cloudflare]
severity: high
related:
  - "[[observability-setup]]"
  - "[[cire-auth]]"
  - "[[database-environments]]"
  - "[[redis]]"
  - "[[email]]"
last-reviewed: 2026-06-18
---

# Production Deploy Runbook — osn + cire

> Scope: the first production cut-over of **osn-api** (identity/auth, **now a
> Cloudflare Worker** — `export default { fetch, scheduled }` in
> `osn/api/src/index.ts`, migration Phase 6) and the **cire** wedding-invite
> stack (**cire-api** Worker + **cire/web** guest Pages site + **cire/organiser**
> Pages portal).
>
> **osn-api is a Worker now (was a long-running Bun process).** All its secrets
> are set with `wrangler secret put … --env <env>` and surfaced **only on the
> `env` binding** (never `process.env` on workerd); non-secret config lives in
> `osn/api/wrangler.toml` `[vars]` / `[env.<env>.vars]`. The Bun dev server
> (`osn/api/src/local.ts`) is unchanged and remains the local devloop only — it
> is **not** the production runtime. Older "process env" framing in §3.1 / §5.1
> has been corrected; some `osn/api/src/index.ts:NN` line refs below predate the
> Worker entry rewrite and are approximate.
>
> **CI pipeline:** a GitHub Actions deploy workflow (`.github/workflows/deploy.yml`,
> PR #128) deploys the cire Worker + Pages sites; the manual `wrangler` commands
> in section 5 remain the reference for what the pipeline runs and for the
> osn-api Worker deploy.
>
> Read alongside [[observability-setup]] (OTel/Grafana wiring) and
> [[cire-auth]] (the two-auth model + the cire→osn ARC bridge).

⚠️ **Never put real secret values in this file or any committed file.** Every secret
below is set out-of-band with `wrangler secret put` (osn-api **and** cire-api are
both Workers).

---

## 0. Values to fill before deploy (read this first)

Everything in this list must have a real value before you start. Anything still
marked **TBD** blocks the deploy.

| Value | Used by | Status |
|---|---|---|
| `OSN_JWT_PRIVATE_KEY` / `OSN_JWT_PUBLIC_KEY` (ES256 JWK, base64) | osn-api | **generate** (section 1) |
| `OSN_SESSION_IP_PEPPER` (≥32 bytes) | osn-api | **generate** (section 1) |
| `OSN_RP_ID` (WebAuthn RP ID — registrable domain) | osn-api WebAuthn | **TBD — needs a custom domain; workers.dev can't be the RP ID across surfaces (prod passkeys deferred)** |
| `OSN_ORIGIN` (prod https origins, comma-sep) | osn-api WebAuthn | **TBD — confirm prod domains** |
| `OSN_ISSUER_URL` (public https base of osn-api) | osn-api + cire | **default `https://osn-api.<account-subdomain>.workers.dev`** — fill real subdomain at deploy |
| `OSN_CORS_ORIGIN` (prod app origins, comma-sep) | osn-api | **TBD — confirm prod domains** |
| `OSN_EMAIL_FROM` (verified sender, e.g. `noreply@osn.app`) | osn-api | **TBD — pick + onboard sender domain** |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` | osn-api | **provision** (~1 week lead, section 1) |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | osn-api | **provision** (section 1) — region locked to **`ap-southeast-2` (Sydney)** (C-M18 resolved) |
| `INTERNAL_SERVICE_SECRET` (S2S register-service) | osn-api | optional — only to register cire's ARC key (§6.2) |
| `TRUSTED_PROXY_COUNT` (proxy hops in front of osn-api) | osn-api rate limits | optional — CF sets `cf-connecting-ip`, usually unneeded on Workers |
| osn D1 `database_id` per env | osn-api wrangler.toml | **DONE** — dev `a1dfceb8-2e7a-48eb-a161-ad428f3ddff5`, staging `eb71428e-8540-4a30-815f-fb9cd4ae97ea`, prod `767a9ac1-129b-4efa-9fcf-f68ed7a48c38` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS` | osn-api + cire | **provision** (Grafana, section 1) |
| `INTERNAL_SERVICE_SECRET` | osn-api | needed only to register cire's ARC key (section 6.2) |
| cire D1 `database_id` | cire-api wrangler.toml | **DONE** — `6e835474-e0a7-4db9-8883-3247c3c891cd` |
| cire R2 buckets | cire-api | **DONE** — `cire-sheets[-preview]`, `cire-assets[-preview]` |
| cire `WEB_ORIGIN` allowlist (guest **and** organiser origins) | cire-api | **TBD — confirm prod domains** |
| cire `OSN_JWKS_URL` / `OSN_ISSUER_URL` | cire-api | **TBD — point at deployed osn-api `https://osn-api.<account-subdomain>.workers.dev` (+`/.well-known/jwks.json`); placeholder `osn-api.example.com` today** |
| `BOOTSTRAP_OWNER_PROFILE_ID` (real `usr_*` OSN profile id) | cire D1 seed | **TBD — organiser must register an OSN passkey first** |
| `CIRE_API_ARC_PRIVATE_KEY` + `CIRE_API_ARC_KEY_ID` + `OSN_API_URL` | cire-api | needed only if guest account-linking is enabled (section 6.2) |
| cire/web `PUBLIC_API_URL`, `PUBLIC_SITE_URL` (build-time) | cire/web Pages | **TBD — confirm prod URLs** |
| cire/organiser `PUBLIC_CIRE_API_URL`, `PUBLIC_OSN_ISSUER_URL`, `PUBLIC_CIRE_WEB_URL` (build-time) | cire/organiser Pages | **TBD — confirm prod URLs** |

---

## 1. Pre-flight (lead-time items — start these early)

### 1.1 Cloudflare email sender-domain onboarding (~1 week lead) 🕐

osn-api emails OTPs and security notices through the **Cloudflare Email Service REST
API** (`osn/api/src/index.ts:185-200`). In production both `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_EMAIL_API_TOKEN` are **required** — the app throws at startup without them
(`osn/api/src/index.ts:187-191`).

Before tokens are useful you must onboard the **sender domain** (the domain in
`OSN_EMAIL_FROM`, e.g. `noreply@osn.app`) — SPF/DKIM/DMARC records and Cloudflare's
sender verification. **Budget ~1 week.** Steps:

1. Decide the `OSN_EMAIL_FROM` address and its domain.
2. In the Cloudflare dashboard, start sender-domain onboarding for that domain; add the
   DNS records it asks for.
3. Wait for verification to go green.
4. Mint an API token scoped to the Email Service; store as `CLOUDFLARE_EMAIL_API_TOKEN`.
5. Note the `CLOUDFLARE_ACCOUNT_ID`.

Until the domain is verified, OTP email simply will not arrive — there is no fallback in
production (the in-memory `LogEmailLive` recorder is local/test only).

### 1.2 Generate the ES256 JWT key pair

osn-api signs user access/refresh/step-up JWTs with an **ES256 (ECDSA P-256)** key pair.
In any non-local env both halves are **required** — missing either throws at startup
(`osn/api/src/index.ts:60-65`). Without `OSN_ENV` set, the app silently generates an
**ephemeral** pair (tokens die on every restart) — see section 7's log check.

Generate once (command lifted from `osn/api/src/index.ts:46`):

```bash
node -e "const {subtle}=globalThis.crypto; subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']).then(async k=>{const {exportJWK}=await import('jose');console.log('private:',btoa(JSON.stringify(await exportJWK(k.privateKey))));console.log('public:',btoa(JSON.stringify(await exportJWK(k.publicKey))))})"
```

Store the `private:` value as `OSN_JWT_PRIVATE_KEY` and `public:` as `OSN_JWT_PUBLIC_KEY`
(both base64-encoded JWK JSON). Treat the private key like any other secret.

### 1.3 Generate the session IP pepper

`OSN_SESSION_IP_PEPPER` is the HMAC key that hashes issuing IPs into the
`sessions.ip_hash` column (the "is this device mine?" signal in the Sessions panel). In a
non-local env it must be set and **≥32 bytes**, or the app throws
(`osn/api/src/index.ts:94-100`).

```bash
openssl rand -base64 48   # ≥32 bytes after decode; store as OSN_SESSION_IP_PEPPER
```

### 1.4 Provision Redis (Upstash REST)

osn-api's rate limiters, rotated-session store, and step-up single-use JTI store are
Redis-backed in production. On workerd there is no TCP socket, so osn-api talks to
**Upstash Redis over the REST API** (matching the Worker's `Env`:
`osn/api/src/index.ts:51-52`). Set **both** secrets:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

In any non-local env (`OSN_ENV` set & `!= "local"`) **both are required** — the Worker
**refuses to boot** (fail-closed 503) without them rather than silently downgrading to
per-isolate in-memory limiters (`osn/api/src/index.ts:92-96`). Locally (`OSN_ENV`
unset/`local`) they are absent and the Worker uses in-memory fallbacks — no Upstash, no
external service needed.

> ✅ **C-M18 resolved — Upstash region = `ap-southeast-2` (Sydney).** Create the
> Upstash database in **`ap-southeast-2`** — co-located with the D1 databases (all in
> `oc` / Sydney) and the Australian edge traffic for low RSVP/auth-write latency (the
> project is AU-centric). Provision the database in that region, mint a REST token, and
> set the two secrets above. See `[[compliance/subprocessors]]`.

### 1.5 OTel / Grafana endpoint

Observability ships via OpenTelemetry → Grafana Cloud. Provision the OTLP endpoint +
auth header per [[observability-setup]]; you'll set `OTEL_EXPORTER_OTLP_ENDPOINT`
and `OTEL_EXPORTER_OTLP_HEADERS` (plus `DEPLOYMENT_ENVIRONMENT=production`) on osn-api and
the cire Worker.

---

## 2. One-time resource creation (D1 + R2)

### 2.1 cire D1 database — ALREADY CREATED ✅

| Field | Value |
|---|---|
| name | `cire-db` |
| database_id | `6e835474-e0a7-4db9-8883-3247c3c891cd` |
| region | `oc` (Oceania / Sydney) |

> **Region note:** all four D1 databases (this `cire-db` + the three osn-db
> dev/staging/prod below) are in **`oc` (Sydney)**, and Upstash must be created in
> **`ap-southeast-2` (Sydney)** — co-located for low AU latency (the project is
> AU-centric). The WEUR databases were deleted and recreated in `oc`; the ids above
> and in §2.3 are the new Oceania ones.

Substitute the id into `cire/api/wrangler.toml:15` (currently
`database_id = "placeholder-replace-after-d1-create"`):

```toml
[[d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "6e835474-e0a7-4db9-8883-3247c3c891cd"
migrations_dir = "../db/migrations"
```

### 2.2 cire R2 buckets — ALREADY CREATED ✅

All four exist (bindings in `cire/api/wrangler.toml:23-36`):

| Binding | Bucket | Preview bucket |
|---|---|---|
| `SHEETS` (spreadsheet import staging) | `cire-sheets` | `cire-sheets-preview` |
| `ASSETS` (invite-builder images) | `cire-assets` | `cire-assets-preview` |

If you ever need to recreate them:

```bash
bunx wrangler r2 bucket create cire-sheets
bunx wrangler r2 bucket create cire-sheets-preview
bunx wrangler r2 bucket create cire-assets
bunx wrangler r2 bucket create cire-assets-preview
```

### 2.3 osn-api D1 databases — ALREADY CREATED ✅

osn-api **is** a Cloudflare Worker now (`main = "src/index.ts"`, `export default
{ fetch, scheduled }`). Its three D1 databases (one per remote env) already exist and
are wired into `osn/api/wrangler.toml` under each `[[env.<env>.d1_databases]]`:

| Env | `database_name` | `database_id` |
|---|---|---|
| dev (also top-level local `wrangler dev`) | `osn-db` | `a1dfceb8-2e7a-48eb-a161-ad428f3ddff5` |
| staging | `osn-db-staging` | `eb71428e-8540-4a30-815f-fb9cd4ae97ea` |
| production | `osn-db-prod` | `767a9ac1-129b-4efa-9fcf-f68ed7a48c38` |

All three are in **`oc` (Sydney)** (co-located with cire-db + Upstash `ap-southeast-2`).
They are **freshly created and unmigrated** — apply the migrations per §4.3
before first use. (The `0002_add_user_handle` data-copy bug that blocked a clean
apply was fixed in-place; all `0000`→latest migrations apply ✅ to a fresh local D1.)

osn-api secrets are set with `wrangler secret put … --env <env>` (§3.1), surfaced
**only on `env`** on workerd — never `process.env`, which is why `src/index.ts` threads
`env` through `buildAppDeps`.

---

## 3. Secret / variable checklist

> "How to set": **osn-api** and **cire-api** are both Workers — secrets use
> `wrangler secret put <NAME> --env <env>` (from the package dir, against
> `wrangler.toml`); non-secret vars live in each `wrangler.toml` (`[vars]` /
> `[env.<env>.vars]`). cire Pages `PUBLIC_*` are **build-time** env vars.

### 3.1 osn-api (Cloudflare Worker)

osn-api is a Worker: non-secret config is `[vars]` / `[env.<env>.vars]` in
`osn/api/wrangler.toml`; secrets are `wrangler secret put … --env <env>` and surfaced
**only on the `env` binding** (never `process.env`). Run the `secret put` commands from
`osn/api/`. The inventory:

```bash
cd osn/api
# REQUIRED in non-local — Worker fails closed (503 / refuses boot) without these:
bunx wrangler secret put OSN_JWT_PRIVATE_KEY        --env <dev|staging|production>
bunx wrangler secret put OSN_JWT_PUBLIC_KEY         --env <dev|staging|production>
bunx wrangler secret put OSN_SESSION_IP_PEPPER      --env <dev|staging|production>
bunx wrangler secret put UPSTASH_REDIS_REST_URL     --env <dev|staging|production>
bunx wrangler secret put UPSTASH_REDIS_REST_TOKEN   --env <dev|staging|production>
bunx wrangler secret put CLOUDFLARE_ACCOUNT_ID      --env <dev|staging|production>
bunx wrangler secret put CLOUDFLARE_EMAIL_API_TOKEN --env <dev|staging|production>
# OPTIONAL — only for the cire→osn account-linking ARC bridge (§6.2):
bunx wrangler secret put INTERNAL_SERVICE_SECRET    --env <dev|staging|production>
# Observability (deferred export on workerd; header is a secret):
bunx wrangler secret put OTEL_EXPORTER_OTLP_HEADERS  --env <dev|staging|production>
```

| Name | How to set | Required? | Notes |
|---|---|---|---|
| `OSN_ENV` | `[env.<env>.vars]` (`dev`/`staging`/`production`) | **Yes (master switch)** | Per-env in `wrangler.toml`. Local `wrangler dev` (no `--env`) is `"local"`: ephemeral JWT keys, no `Secure`/`__Host-` cookies, JWT/pepper/email/Upstash throws skipped, OTPs go to the log recorder. Non-local flips all of that on. |
| `OSN_JWT_PRIVATE_KEY` | `wrangler secret put` | **Yes** | base64 ES256 JWK. Throws if missing in non-local. §1.2 |
| `OSN_JWT_PUBLIC_KEY` | `wrangler secret put` | **Yes** | base64 ES256 JWK; published at `/.well-known/jwks.json`. §1.2 |
| `OSN_SESSION_IP_PEPPER` | `wrangler secret put` | **Yes** | ≥32 bytes or throws. §1.3 |
| `OSN_RP_ID` | `[env.<env>.vars]` | **Yes (deferred for prod passkeys)** | WebAuthn RP ID — must be a **registrable custom domain**. workers.dev cannot be the RP ID across the app surfaces, so **prod passkeys are deferred** until a custom domain is provisioned. Placeholder in `wrangler.toml`. |
| `OSN_ORIGIN` | `[env.<env>.vars]` | **Yes** | Comma-sep accepted WebAuthn origins; prod **https** origins. |
| `OSN_ISSUER_URL` | `[env.<env>.vars]` | **Yes** | Public https base URL of osn-api → JWT `iss`; must match what cire verifies. Default workers.dev: `https://osn-api.<account-subdomain>.workers.dev`. |
| `OSN_CORS_ORIGIN` | `[env.<env>.vars]` | **Yes** | Comma-sep prod app origins. In a secure env an empty list **throws** at `assertCorsOriginsConfigured` (`lib/cors-config.ts`) — Origin/CSRF guard is mandatory. |
| `CLOUDFLARE_ACCOUNT_ID` | `wrangler secret put` | **Yes** | Email transport; throws if missing in non-local. §1.1 |
| `CLOUDFLARE_EMAIL_API_TOKEN` | `wrangler secret put` | **Yes** | Email transport bearer token; throws if missing. §1.1 |
| `OSN_EMAIL_FROM` | `[env.<env>.vars]` (or secret) | **Yes (prod)** | Verified sender address, e.g. `noreply@osn.app`. Onboarded domain from §1.1. |
| `UPSTASH_REDIS_REST_URL` | `wrangler secret put` | **Yes** | Upstash REST URL. Worker refuses to boot in non-local without it + the token (`index.ts:92-96`). §1.4 |
| `UPSTASH_REDIS_REST_TOKEN` | `wrangler secret put` | **Yes** | Upstash REST token. §1.4 (region `ap-southeast-2` / Sydney — C-M18 resolved) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `[env.<env>.vars]` | Recommended | Grafana OTLP gateway. Metric/trace **export is deferred on workerd** — the redacting logger is active, recording call-sites are no-ops until an exporter is attached. [[observability-setup]] |
| `OTEL_EXPORTER_OTLP_HEADERS` | `wrangler secret put` | Recommended | `Authorization=Basic <base64(instance:token)>`. [[observability-setup]] |
| `INTERNAL_SERVICE_SECRET` | `wrangler secret put` | **Conditional** | Bearer secret guarding `POST /graph/internal/register-service` (`routes/graph-internal.ts`). Needed **only** to register cire-api's ARC public key (§6.2). Endpoint returns 501 when unset. |
| `TRUSTED_PROXY_COUNT` | `[env.<env>.vars]` | Optional | On Workers, Cloudflare sets `cf-connecting-ip`, so this is usually unneeded. Set only if a proxy sits in front and XFF must be trusted N hops. |
| `OSN_RP_NAME` | `[env.<env>.vars]` | Optional | Display name in passkey prompts (default `OSN`). |
| `OSN_ACCESS_TOKEN_TTL` / `OSN_REFRESH_TOKEN_TTL` | `[env.<env>.vars]` | Optional | Defaults 300s / 2592000s. |
| `PULSE_API_URL` / `ZAP_API_URL` | `[env.<env>.vars]` | Optional | Outbound ARC key registration for account-erasure fan-out. |

### 3.2 cire-api (Cloudflare Worker)

| Name | How to set | Required? | Notes |
|---|---|---|---|
| D1 `database_id` | edit `wrangler.toml:15` | **Yes** | §2.1 — `6e835474-e0a7-4db9-8883-3247c3c891cd`. |
| `WEB_ORIGIN` | `wrangler.toml` `[env.production.vars]:39` | **Yes** | Comma-sep allowlist; must include **both** the guest site origin **and** the organiser portal origin. Each entry must be `https://…` or the Worker fails closed at the edge (`src/index.ts:59-74`). Placeholder today: `https://cire.pages.dev`. |
| `OSN_JWKS_URL` | `wrangler.toml` `[env.production.vars]:41` | **Yes** | Deployed osn-api JWKS URL (`<OSN_ISSUER_URL>/.well-known/jwks.json`), e.g. `https://osn-api.<account-subdomain>.workers.dev/.well-known/jwks.json`. Placeholder today: `https://osn-api.example.com/.well-known/jwks.json`. |
| `OSN_ISSUER_URL` | `wrangler.toml` `[env.production.vars]:42` | **Yes** | Deployed osn-api origin; must equal osn-api's own `OSN_ISSUER_URL` (the workers.dev URL until a custom domain exists). Placeholder today: `https://osn-api.example.com`. |
| `OSN_AUDIENCE` | `wrangler.toml` `[env.production.vars]:43` | **Yes** | `osn-access` (the user access-token audience). |
| `CIRE_API_ARC_PRIVATE_KEY` | `wrangler secret put CIRE_API_ARC_PRIVATE_KEY` | **Conditional** | ES256 JWK (string). Only if guest account-linking is enabled (§6.2). Absent ⇒ linking `POST` answers 503 (`src/index.ts:78-85`, `services/osn-bridge.ts:99-113`). |
| `CIRE_API_ARC_KEY_ID` | `wrangler secret put CIRE_API_ARC_KEY_ID` | **Conditional** | `kid` matching the public key registered in osn-api `service_accounts` for serviceId `cire-api`. §6.2 |
| `OSN_API_URL` | `wrangler secret put OSN_API_URL` (or var) | **Conditional** | osn-api base URL the ARC bridge calls. §6.2 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` | `wrangler secret put` | Recommended | Worker observability. [[observability-setup]] |

> ⚠️ **cire `wrangler.toml` env nuance:** the D1 + R2 bindings are at the **top level**
> (not under `[env.production]`), while the prod URLs live under `[env.production.vars]`.
> Confirm your deploy command targets the right binding set (section 5.2) — a bare
> `wrangler deploy` uses the top-level bindings and the default vars unless you pass
> `--env production`.

### 3.3 cire/web + cire/organiser (Pages — build-time `PUBLIC_*`)

Both are **static** Astro builds (`output: "static"`), so these are baked in **at build
time** — set them in the build environment, not at runtime.

| Name | Site | Required? | Notes |
|---|---|---|---|
| `PUBLIC_API_URL` | cire/web | **Yes** | cire-api prod origin (`cire/web/src/pages/index.astro:6`, default `http://localhost:8787`). |
| `PUBLIC_SITE_URL` | cire/web | Recommended | Guest site canonical URL (`index.astro:50`). |
| `PUBLIC_GOOGLE_MAPS_EMBED_KEY` | cire/web | Optional | Google Maps Platform key with the **Maps Embed API** enabled. When set, the event "Where" section renders a real Maps Embed iframe (queried by the free-text venue address — no coordinates, no geocoding); when unset/blank it falls back to the CSS-drawn map card, so it is a pure enhancement (`cire/web/src/components/MapPreview.tsx`). **Human step:** create the key, **enable only the Maps Embed API**, and **restrict it by HTTP referrer** to the guest-site origin(s) — the key bakes into static HTML, and a referrer-restricted Embed-only key is safe to ship. |
| `PUBLIC_CIRE_API_URL` | cire/organiser | **Yes** | cire-api prod origin (`cire/organiser/src/lib/osn.ts:8-9`; `PUBLIC_API_URL` honoured as legacy fallback). |
| `PUBLIC_OSN_ISSUER_URL` | cire/organiser | **Yes** | osn-api prod origin for organiser passkey sign-in (`osn.ts:3`, default `http://localhost:4000`). |
| `PUBLIC_CIRE_WEB_URL` | cire/organiser | Recommended | Guest site URL used in organiser links (`osn.ts:14`). |

---

## 4. Database migrations + bootstrap-owner substitution

### 4.1 Apply cire D1 migrations (remote)

Migrations live in `cire/db/migrations/` (`0001`…`0012`, incl.
`0012_dietary_consent.sql`). The `database_id` is already wired
(`6e835474-e0a7-4db9-8883-3247c3c891cd`, §2.1):

```bash
# from cire/api (wrangler.toml lives there)
cd cire/api
bunx wrangler d1 migrations apply cire-db --remote
# or, from repo root via the cire/db script:
# bun run --cwd cire/db db:push:remote
```

### 4.2 Set the bootstrap-owner profile id 🔑

> Assumes the `fix/cire-bootstrap-owner` PR is merged — it replaced the old
> hardcoded `usr_REPLACE_BEFORE_PROD` placeholder with an env-driven owner +
> runtime fixup. (Pre-merge behaviour was a manual post-migrate `UPDATE`.)

Migration `0006_multi_tenant.sql` seeds the single bespoke wedding row
`wed_bootstrap` with an **inert sentinel owner** `usr_unclaimed_bootstrap`
that satisfies the NOT NULL column + FK backfill but matches no real profile, so
the ownership gate (`ownedWedding()` / `weddingOwner()`) **fails closed** — the
real organiser sees nothing until the owner is repointed.

The repoint is **automatic on boot**, driven by a single secret:

1. Obtain the organiser's **real `usr_*` OSN profile id** by having them register
   their OSN passkey on production first (§7), then read their profile id from osn.
2. Set it on cire-api (alongside `OSN_ENV`), then redeploy / let the next isolate boot:

```bash
cd cire/api
bunx wrangler secret put BOOTSTRAP_OWNER_PROFILE_ID --env production   # paste usr_*
# OSN_ENV is a [vars] entry (dev|staging|production); confirm it is set non-local.
```

On first request per isolate, `ensureBootstrapOwner` (`src/index.ts`) UPDATEs the
row off the sentinel onto `BOOTSTRAP_OWNER_PROFILE_ID` (idempotent), or **throws →
503** if it is missing / still the placeholder / sentinel / not `usr_*`
(fail loud, never silently mis-owned). No manual SQL `UPDATE` is required.

Verify the live row carries the real id after the first request:

```bash
bunx wrangler d1 execute cire-db --remote \
  --command "SELECT id, owner_osn_profile_id FROM weddings WHERE id = 'wed_bootstrap';"
```

### 4.3 Apply osn-api D1 migrations (remote)

osn-api's migrations live in `osn/db/drizzle/` (`0000`→`0009`) and are wired into every
`[[env.<env>.d1_databases]]` via `migrations_dir = "../db/drizzle"`. The three remote D1s
(§2.3) are freshly created and **unmigrated**. Apply per env (against the binding name in
`osn/api/wrangler.toml`):

```bash
# from osn/api (wrangler.toml + the migrations_dir live relative to it)
cd osn/api
bunx wrangler d1 migrations apply osn-db          --env dev        --remote
bunx wrangler d1 migrations apply osn-db-staging  --env staging    --remote
bunx wrangler d1 migrations apply osn-db-prod     --env production  --remote

# or via the @osn/db scripts from repo root:
# bun run --cwd osn/db db:migrate:dev      # remote dev D1
# bun run --cwd osn/db db:migrate:staging  # remote staging D1
# bun run --cwd osn/db db:migrate:prod     # remote prod D1
```

The local equivalent (`bun run --cwd osn/db db:migrate:local`, miniflare) is verified to
apply all `0000`→latest cleanly after the `0002_add_user_handle` data-copy fix.

---

## 5. Deploy steps (CI + manual reference)

> The cire Worker + Pages sites deploy via `.github/workflows/deploy.yml` (PR #128).
> The commands below are the manual equivalents — they document what the pipeline runs.

### 5.1 osn-api (Worker)

osn-api is a Cloudflare Worker (§2.3). With the §3.1 vars in `wrangler.toml` and the
§3.1 secrets set (`wrangler secret put … --env <env>`), and the D1 migrations applied
(§4.3):

```bash
cd osn/api
bunx wrangler types                          # regenerate binding types if bindings changed
bunx wrangler deploy --dry-run --outdir ./dist   # optional: build-only sanity check
bunx wrangler deploy --env dev               # or --env staging | --env production
```

**Default URL (no custom domain yet):** the Worker is served at
`https://osn-api.<account-subdomain>.workers.dev` (the `<account-subdomain>` is your
Cloudflare account's workers.dev subdomain; the Worker name `osn-api` comes from
`wrangler.toml`). Set each env's `OSN_ISSUER_URL` to that URL.

> ⚠️ **Prod passkeys need a custom domain.** workers.dev cannot serve as the WebAuthn
> RP ID across the app surfaces (the RP ID must be a registrable domain shared by the
> frontends), so **production passkey sign-in is deferred** until a custom domain is
> provisioned and `OSN_RP_ID` / `OSN_ORIGIN` are repointed at it. The workers.dev URL is
> fine for `/health`, `/.well-known/jwks.json`, and the JWKS bridge to cire (§5.2) in the
> interim.

> ℹ️ **cire must point at the deployed osn-api URL.** After osn-api is deployed, set
> cire-api's `OSN_JWKS_URL` = `<osn-api URL>/.well-known/jwks.json` and `OSN_ISSUER_URL`
> = the osn-api URL (§3.2), and cire/organiser's `PUBLIC_OSN_ISSUER_URL` (§3.3) — all
> three must equal osn-api's own `OSN_ISSUER_URL` or token verification fails.

### 5.2 cire-api (Worker)

```bash
cd cire/api
bunx wrangler types          # regenerate binding types if bindings changed
bunx wrangler deploy --env production
```

Confirm the deploy picked up the prod vars from `[env.production.vars]` and the
top-level D1/R2 bindings (§3.2 nuance). Set any conditional secrets first
(`wrangler secret put …`, §6.2).

### 5.3 cire/web (guest Pages) + cire/organiser (Pages)

Build with the `PUBLIC_*` build-time vars (§3.3) in the environment, then publish:

```bash
# guest site
bun run --cwd cire/web build
bunx wrangler pages deploy cire/web/dist

# organiser portal
bun run --cwd cire/organiser build
bunx wrangler pages deploy cire/organiser/dist
```

Make sure the published guest + organiser origins are exactly the ones listed in
cire-api's `WEB_ORIGIN` allowlist (§3.2) and in osn-api's `OSN_CORS_ORIGIN` /
`OSN_ORIGIN` (organiser passkey sign-in talks to osn-api).

---

## 6. Optional: guest account-linking bridge (cire → osn)

Account-linking (`POST /api/account/link`) lets a guest attach their household to their
OSN account. It is **additive and opt-in**; skip this section for the minimal launch.

### 6.1 What it needs

- cire-api: `CIRE_API_ARC_PRIVATE_KEY` (ES256 JWK), `CIRE_API_ARC_KEY_ID`, `OSN_API_URL`
  (§3.2). All three absent ⇒ the linking POST simply answers 503 (`src/index.ts:78-85`).
- osn-api: cire-api's matching ES256 **public** key registered in `service_accounts`
  under serviceId `cire-api` with scope `graph:read`, so osn-api can verify cire's ARC
  token on `GET /graph/internal/profile-account` (`services/osn-bridge.ts:19-29,59-90`).

### 6.2 Register cire's ARC public key with osn-api

This is what `INTERNAL_SERVICE_SECRET` is for. Generate a stable ES256 key pair for
cire-api (same command as §1.2), store the **private** JWK as `CIRE_API_ARC_PRIVATE_KEY`
and the chosen `kid` as `CIRE_API_ARC_KEY_ID`, then register the **public** half:

```bash
curl -X POST "$OSN_ISSUER_URL/graph/internal/register-service" \
  -H "Authorization: Bearer $INTERNAL_SERVICE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"serviceId":"cire-api","keyId":"<CIRE_API_ARC_KEY_ID>","publicKeyJwk":"<public JWK string>","allowedScopes":"graph:read"}'
```

(`POST /graph/internal/register-service` returns 501 if `INTERNAL_SERVICE_SECRET` is
unset, 401 on a bad bearer — `routes/graph-internal.ts:203-214`.)

---

## 7. Post-deploy verification (smoke checks)

Run these in order; each maps to a startup requirement enumerated above.

1. **Health / readiness / JWKS.** `curl https://osn-api.<account-subdomain>.workers.dev/health`,
   `/` , and `/.well-known/jwks.json` (and the cire-api root). 200s confirm the Worker
   booted — meaning none of the startup throws fired (or, at the edge, no 503
   `Worker misconfigured`), so the JWT keys, pepper, Upstash, and email creds are all
   present. `/.well-known/jwks.json` must return an ES256 (`alg:"ES256"`, P-256) JWK.
2. **No ephemeral-key warning in logs.** Search osn-api boot logs; you must **NOT** see
   `"Using ephemeral JWT key pair — tokens will be invalidated on restart"`
   (`osn/api/src/index.ts:272-275`). If you do, `OSN_ENV` and/or the JWT key vars are not
   set — stop and fix before letting users in.
3. **Upstash reachable.** Confirm the Worker booted (no 503 `Worker misconfigured`
   refusing to fall back to in-memory limiters) — in non-local both
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` must be set, or the Worker
   fails closed (`osn/api/src/index.ts:92-96`). Hit a rate-limited endpoint and confirm
   limits persist across isolates.
4. **OTP email arrives.** Trigger an OTP flow (e.g. organiser sign-up/step-up). A real
   email must land at the test address — this exercises §1.1 end-to-end. If nothing
   arrives, check `CLOUDFLARE_*` creds and sender-domain verification.
5. **Organiser passkey sign-in works.** On the prod organiser portal, the organiser
   registers + signs in with an OSN passkey. This validates `OSN_RP_ID`, `OSN_ORIGIN`,
   `OSN_ISSUER_URL`, `OSN_CORS_ORIGIN` (osn-api side) and `PUBLIC_OSN_ISSUER_URL`
   (organiser build). Capture their `usr_*` profile id for §4.2 if not done yet.
6. **Organiser dashboard lists the wedding.** Once `BOOTSTRAP_OWNER_PROFILE_ID` is set
   (§4.2) and a request has booted the worker, the runtime fixup repoints the owner off
   the sentinel and the organiser sees `wed_bootstrap`'s guests/events. If it's empty,
   the owner is still the sentinel — check the secret is set and the worker rebooted (a
   missing/invalid value 503s rather than mis-owning).
7. **RSVP write succeeds.** A guest claims their family code on the guest site and submits
   an RSVP (`POST /api/rsvp`). A 2xx + a persisted row confirms cire-api ↔ D1 writes and
   the guest-session cookie path. Verify with:
   `bunx wrangler d1 execute cire-db --remote --command "SELECT count(*) FROM rsvps;"`.
8. **(If enabled) account-linking returns non-503.** `POST /api/account/link` should not
   answer 503 once §6 is wired; a 503 means the ARC bridge config is missing.

---

## Appendix — file:line index

| What | Where |
|---|---|
| JWT key-pair throw / ephemeral fallback | `osn/api/src/index.ts:52-88`, warn at `272-275` |
| Session IP pepper throw (≥32 bytes) | `osn/api/src/index.ts:94-100` |
| `OSN_ENV` cookie-secure switch | `osn/api/src/index.ts:167-170` |
| WebAuthn rpId / origin / issuer | `osn/api/src/index.ts:103-113` |
| CORS allowlist fail-closed | `osn/api/src/lib/cors-config.ts:41-62` |
| Cloudflare email throw + sender | `osn/api/src/index.ts:185-200` |
| Redis URL / required / TLS warning | `osn/api/src/redis.ts:38-88`, init `osn/api/src/index.ts:133-138` |
| Client-IP extraction (proxy) | `shared/rate-limit/src/index.ts:82-89` |
| `INTERNAL_SERVICE_SECRET` register-service | `osn/api/src/routes/graph-internal.ts:203-214` |
| osn-api Worker entry (fetch + scheduled) | `osn/api/src/index.ts`; deploy `osn/api/package.json` (`dev:wrangler` / `deploy`) |
| osn-api Upstash fail-closed (non-local) | `osn/api/src/index.ts:92-96` |
| osn D1 bindings + per-env vars | `osn/api/wrangler.toml` (`[[env.<env>.d1_databases]]`, `[env.<env>.vars]`) |
| osn migrations | `osn/db/drizzle/` (`0000`→`0009`); scripts `osn/db/package.json` (`db:migrate:*`) |
| cire D1 / R2 bindings + prod vars | `cire/api/wrangler.toml:12-43` |
| cire edge fail-closed + WEB_ORIGIN parse | `cire/api/src/index.ts:44-101` |
| cire ARC bridge (account-linking) | `cire/api/src/services/osn-bridge.ts`, env `cire/api/src/index.ts:25-27,80-85` |
| Bootstrap owner placeholder | `cire/db/migrations/0006_multi_tenant.sql:32-41`; mirror `cire/api/src/db/setup.ts:151-163` |
| cire migrate scripts | `cire/db/package.json` (`db:push:remote`) |

## Related

- [[observability-setup]] — OTel/Grafana endpoint + header wiring
- [[cire-auth]] — guest/organiser two-auth model + cire→osn ARC bridge
- [[database-environments]] — local bun:sqlite vs dev/staging/prod D1
- [[redis]] — Redis-backed rate limiters + session stores
- [[email]] — transactional email transport (Cloudflare Email Service)
