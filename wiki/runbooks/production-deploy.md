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
last-reviewed: 2026-06-17
---

# Production Deploy Runbook — osn + cire

> Scope: the first production cut-over of **osn-api** (identity/auth, a long-running
> Bun process) and the **cire** wedding-invite stack (**cire-api** Worker + **cire/web**
> guest Pages site + **cire/organiser** Pages portal).
>
> **CI pipeline:** a GitHub Actions deploy workflow (`.github/workflows/deploy.yml`,
> PR #128) now deploys the cire Worker + Pages sites; the manual `wrangler` / process
> commands in section 5 remain the reference for what the pipeline runs and for the
> osn-api Bun process (not yet a Worker — §2.3).
>
> Read alongside [[observability-setup]] (OTel/Grafana wiring) and
> [[cire-auth]] (the two-auth model + the cire→osn ARC bridge).

⚠️ **Never put real secret values in this file or any committed file.** Every secret
below is set out-of-band (`wrangler secret put` for the cire Worker; the process
environment / your secrets manager for the osn-api Bun process).

---

## 0. Values to fill before deploy (read this first)

Everything in this list must have a real value before you start. Anything still
marked **TBD** blocks the deploy.

| Value | Used by | Status |
|---|---|---|
| `OSN_JWT_PRIVATE_KEY` / `OSN_JWT_PUBLIC_KEY` (ES256 JWK, base64) | osn-api | **generate** (section 1) |
| `OSN_SESSION_IP_PEPPER` (≥32 bytes) | osn-api | **generate** (section 1) |
| `OSN_RP_ID` (prod apex/host, e.g. `osn.app`) | osn-api WebAuthn | **TBD — confirm prod domain** |
| `OSN_ORIGIN` (prod https origins, comma-sep) | osn-api WebAuthn | **TBD — confirm prod domains** |
| `OSN_ISSUER_URL` (public https base of osn-api) | osn-api + cire | **TBD — confirm prod URL** |
| `OSN_CORS_ORIGIN` (prod app origins, comma-sep) | osn-api | **TBD — confirm prod domains** |
| `OSN_EMAIL_FROM` (verified sender, e.g. `noreply@osn.app`) | osn-api | **TBD — pick + onboard sender domain** |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` | osn-api | **provision** (~1 week lead, section 1) |
| `REDIS_URL` (`rediss://…`) | osn-api | **provision** (section 1) |
| `TRUSTED_PROXY_COUNT` (proxy hops in front of osn-api) | osn-api rate limits | **TBD — depends on prod topology** |
| `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS` | osn-api + cire | **provision** (Grafana, section 1) |
| `INTERNAL_SERVICE_SECRET` | osn-api | needed only to register cire's ARC key (section 6.2) |
| cire D1 `database_id` | cire-api wrangler.toml | **DONE** — `e0ebc94c-77df-47a6-af52-40a8c39b3afb` |
| cire R2 buckets | cire-api | **DONE** — `cire-sheets[-preview]`, `cire-assets[-preview]` |
| cire `WEB_ORIGIN` allowlist (guest **and** organiser origins) | cire-api | **TBD — confirm prod domains** |
| cire `OSN_JWKS_URL` / `OSN_ISSUER_URL` | cire-api | **TBD — real osn-api origin (placeholder `osn-api.example.com` today)** |
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

### 1.4 Provision Redis

osn-api's rate limiters, rotated-session store, and step-up single-use JTI store are
Redis-backed in production (`osn/api/src/index.ts:133-165`). Set both:

- `REDIS_URL` — use a **TLS** URL (`rediss://…`); a plain `redis://` in production logs a
  loud "connection is unencrypted" warning (`osn/api/src/redis.ts:55-58`).
- `REDIS_REQUIRED=true` — makes a failed Redis connection **abort startup** instead of
  silently falling back to in-memory limiters (`osn/api/src/redis.ts:83-88`). Set it to
  `true` so a Redis outage fails loud rather than quietly degrading cross-pod rate limits
  and session-reuse detection.

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
| database_id | `e0ebc94c-77df-47a6-af52-40a8c39b3afb` |
| region | `WEUR` |

Substitute the id into `cire/api/wrangler.toml:15` (currently
`database_id = "placeholder-replace-after-d1-create"`):

```toml
[[d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "e0ebc94c-77df-47a6-af52-40a8c39b3afb"
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

### 2.3 osn-api hosting note

osn-api is **not** a Cloudflare Worker in this cut. `osn/api/wrangler.toml` has **no
`main` / deploy target** (see the comment block at `osn/api/wrangler.toml:5-15`) — it
exists only so the osn D1 databases can be created/migrated. osn-api runs as a
**long-running Bun process** (`bun build` → `bun run start`, see
`osn/api/package.json:8-9`). Consequently **osn-api secrets are process environment
variables**, set on whatever runs the Bun process (your host / orchestrator / secrets
manager) — *not* `wrangler secret put`.

---

## 3. Secret / variable checklist

> "How to set": **cire-api** secrets use `wrangler secret put` from `cire/api/`; cire-api
> non-secret vars live in `cire/api/wrangler.toml` (`[vars]` / `[env.production.vars]`);
> cire Pages `PUBLIC_*` are **build-time** env vars. **osn-api** vars are all **process
> env** (set in your deploy environment / secrets manager).

### 3.1 osn-api (process environment)

| Name | How to set | Required? | Notes |
|---|---|---|---|
| `OSN_ENV` | process env = `production` | **Yes (master switch)** | Without it the app falls back to ephemeral JWT keys, drops the `Secure`/`__Host-` cookie flags (`index.ts:167-170`), skips the JWT/pepper/email throws, and emails OTPs to the log recorder instead of sending them. Set it **first**. |
| `OSN_JWT_PRIVATE_KEY` | process env | **Yes** | base64 ES256 JWK. Throws if missing in non-local (`index.ts:60-65`). §1.2 |
| `OSN_JWT_PUBLIC_KEY` | process env | **Yes** | base64 ES256 JWK; published at `/.well-known/jwks.json`. §1.2 |
| `OSN_SESSION_IP_PEPPER` | process env | **Yes** | ≥32 bytes or throws (`index.ts:94-100`). §1.3 |
| `OSN_RP_ID` | process env | **Yes** | WebAuthn Relying Party ID — the prod registrable domain (e.g. `osn.app`). Defaults to `localhost` (`index.ts:103`); a wrong value makes every passkey ceremony fail. |
| `OSN_ORIGIN` | process env | **Yes** | Comma-sep list of accepted WebAuthn origins; must be the prod **https** origins, not `http://localhost:5173` (`index.ts:109-112`). |
| `OSN_ISSUER_URL` | process env | **Yes** | Public https base URL of osn-api; becomes the JWT `iss` and must match what cire verifies. Defaults to `http://localhost:<port>` (`index.ts:113`). |
| `OSN_CORS_ORIGIN` | process env | **Yes** | Comma-sep prod app origins. In a secure env an empty list **throws** at `assertCorsOriginsConfigured` (`lib/cors-config.ts:56-62`) — Origin guard / CSRF protection is mandatory. |
| `CLOUDFLARE_ACCOUNT_ID` | process env | **Yes** | Email transport; throws if missing in non-local (`index.ts:187-191`). §1.1 |
| `CLOUDFLARE_EMAIL_API_TOKEN` | process env | **Yes** | Email transport bearer token; throws if missing (`index.ts:187-191`). §1.1 |
| `OSN_EMAIL_FROM` | process env | **Yes (prod)** | Verified sender address (`index.ts:198`), e.g. `noreply@osn.app`. Must be the onboarded domain from §1.1. |
| `REDIS_URL` | process env | **Yes** | Use `rediss://` (TLS). Plain `redis://` logs an unencrypted-connection warning (`redis.ts:55-58`). §1.4 |
| `REDIS_REQUIRED` | process env = `true` | **Yes** | Fail-closed: abort startup if Redis is unreachable (`redis.ts:83-88`). §1.4 |
| `TRUSTED_PROXY_COUNT` | process env | **Yes (behind a proxy)** | Per-IP rate limits key off the client IP from `x-forwarded-for` (`shared/rate-limit/src/index.ts:85-88`). Behind a reverse proxy / load balancer, set this to the number of trusted proxy hops so the real client IP is used; otherwise every request can share one IP and rate limiting breaks (or is spoofable). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | process env | **Yes** | Grafana OTLP gateway (`…/otlp`). [[observability-setup]] |
| `OTEL_EXPORTER_OTLP_HEADERS` | process env | **Yes** | `Authorization=Basic <base64(instance:token)>`. [[observability-setup]] |
| `DEPLOYMENT_ENVIRONMENT` | process env = `production` | Recommended | Classifies telemetry; keep prod/dev data separate. |
| `NODE_ENV` | process env = `production` | Recommended | JSON+redacted logging; TLS-warning logic (`redis.ts:55`). |
| `INTERNAL_SERVICE_SECRET` | process env | **Conditional** | Bearer secret guarding `POST /graph/internal/register-service` (`routes/graph-internal.ts:203-214`). Needed **only** to register cire-api's ARC public key for the guest account-linking bridge (§6.2). Endpoint returns 501 when unset. |
| `OSN_RP_NAME` | process env | Optional | Display name in passkey prompts (default `OSN`, `index.ts:104`). |
| `OSN_ACCESS_TOKEN_TTL` / `OSN_REFRESH_TOKEN_TTL` | process env | Optional | Defaults 300s / 2592000s (`index.ts:121-122`). |
| `PULSE_API_URL` / `ZAP_API_URL` | process env | Optional | Outbound ARC key registration for account-erasure fan-out (`index.ts:288-291`). |

### 3.2 cire-api (Cloudflare Worker)

| Name | How to set | Required? | Notes |
|---|---|---|---|
| D1 `database_id` | edit `wrangler.toml:15` | **Yes** | §2.1 — `e0ebc94c-77df-47a6-af52-40a8c39b3afb`. |
| `WEB_ORIGIN` | `wrangler.toml` `[env.production.vars]:39` | **Yes** | Comma-sep allowlist; must include **both** the guest site origin **and** the organiser portal origin. Each entry must be `https://…` or the Worker fails closed at the edge (`src/index.ts:59-74`). Placeholder today: `https://cire.pages.dev`. |
| `OSN_JWKS_URL` | `wrangler.toml` `[env.production.vars]:41` | **Yes** | Real osn-api JWKS URL (`<OSN_ISSUER_URL>/.well-known/jwks.json`). Placeholder today: `https://osn-api.example.com/.well-known/jwks.json`. |
| `OSN_ISSUER_URL` | `wrangler.toml` `[env.production.vars]:42` | **Yes** | Real osn-api origin; must equal osn-api's `OSN_ISSUER_URL`. Placeholder today: `https://osn-api.example.com`. |
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
| `PUBLIC_CIRE_API_URL` | cire/organiser | **Yes** | cire-api prod origin (`cire/organiser/src/lib/osn.ts:8-9`; `PUBLIC_API_URL` honoured as legacy fallback). |
| `PUBLIC_OSN_ISSUER_URL` | cire/organiser | **Yes** | osn-api prod origin for organiser passkey sign-in (`osn.ts:3`, default `http://localhost:4000`). |
| `PUBLIC_CIRE_WEB_URL` | cire/organiser | Recommended | Guest site URL used in organiser links (`osn.ts:14`). |

---

## 4. Database migrations + bootstrap-owner substitution

### 4.1 Apply cire D1 migrations (remote)

Migrations live in `cire/db/migrations/` (`0001`…`0012`, incl.
`0012_dietary_consent.sql`). The `database_id` is already wired
(`e0ebc94c-77df-47a6-af52-40a8c39b3afb`, §2.1):

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

---

## 5. Deploy steps (CI + manual reference)

> The cire Worker + Pages sites deploy via `.github/workflows/deploy.yml` (PR #128).
> The commands below are the manual equivalents — they document what the pipeline runs
> and remain the path for the osn-api Bun process (not yet covered by the pipeline).

### 5.1 osn-api (Bun process)

osn-api is a long-running Bun process, **not** a Worker (§2.3). With all §3.1 process env
vars set in the deploy environment:

```bash
bun install
bun run --cwd osn/api build      # bun build → osn/api/dist
bun run --cwd osn/api start      # bun run dist/index.js  (listens on $PORT, default 4000)
```

Front it with your reverse proxy / TLS terminator on the public `OSN_ISSUER_URL` host,
and set `TRUSTED_PROXY_COUNT` to the proxy-hop count (§3.1).

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

1. **Health / readiness.** `curl https://<osn>/health` and `/ready` (and the cire-api
   root). 200s confirm the processes booted — meaning none of the startup throws fired,
   so the JWT keys, pepper, and email creds are all present.
2. **No ephemeral-key warning in logs.** Search osn-api boot logs; you must **NOT** see
   `"Using ephemeral JWT key pair — tokens will be invalidated on restart"`
   (`osn/api/src/index.ts:272-275`). If you do, `OSN_ENV` and/or the JWT key vars are not
   set — stop and fix before letting users in.
3. **No Redis/TLS warnings.** Confirm no `"REDIS_URL does not use TLS"` warning
   (use `rediss://`) and that startup did not abort on Redis (REDIS_REQUIRED working as
   intended only matters if Redis is actually up).
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
| osn-api not a Worker | `osn/api/wrangler.toml:5-15`; build/start `osn/api/package.json:8-9` |
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
