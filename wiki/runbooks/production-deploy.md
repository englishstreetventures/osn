---
title: Production Deploy Runbook (osn + cire)
description: End-to-end runbook for the first production deploy of osn-api and the cire stack (api worker + guest SSR Worker + organiser Pages). Enumerates every required secret/var by source line.
tags: [runbook, deploy, production, osn, cire, secrets, cloudflare]
severity: high
related:
  - "[[observability-setup]]"
  - "[[cire-auth]]"
  - "[[database-environments]]"
  - "[[redis]]"
  - "[[email]]"
  - "[[vendors]]"
last-reviewed: 2026-07-21
---

# Production Deploy Runbook — osn + cire

> Scope: the first production cut-over of **osn-api** (identity/auth, **now a
> Cloudflare Worker** — `export default { fetch, scheduled }` in
> `osn/api/src/index.ts`, migration Phase 6) and the **cire** wedding-invite
> stack (**cire-api** Worker + **cire/web** guest **SSR Worker** + **cire/organiser**
> Pages portal). _(cire/web was a static Pages site; it is now an SSR Worker — see §3.3.)_
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

> **🔀 Domain reshuffle (2026-07-16) — end-state supersedes older `app.`/apex
> framing below.** Apex `cireweddings.com` → marketing **landing** site;
> `invite.cireweddings.com` → **guest** site (`cire/web`); `host.cireweddings.com`
> → **organiser** portal (moved off `app.cireweddings.com`); `api.` / `id.`
> unchanged. Passkeys survive the move (`OSN_RP_ID` stays the registrable apex
> `cireweddings.com`). The full cutover — code changes already merged + the manual
> Cloudflare dashboard steps + the osn-api manual redeploy — is in
> **[[cire-landing]] → "Apex cutover"**. Where a line below still says
> `app.cireweddings.com` as the organiser origin or apex-as-guest-site, read it as
> `host.cireweddings.com` / `invite.cireweddings.com` post-reshuffle.

---

## 0. Values to fill before deploy (read this first)

Everything in this list must have a real value before you start. Anything still
marked **TBD** blocks the deploy.

| Value | Used by | Status |
|---|---|---|
| `OSN_JWT_PRIVATE_KEY` / `OSN_JWT_PUBLIC_KEY` (ES256 JWK, base64) | osn-api | **generate** (section 1) |
| `OSN_SESSION_IP_PEPPER` (≥32 bytes) | osn-api | **generate** (section 1) |
| `OSN_RP_ID` (WebAuthn RP ID — registrable domain) | osn-api WebAuthn | **DONE — `cireweddings.com`** (registrable apex; organiser portal is the only prod passkey surface). Unchanged by the 2026-07-16 reshuffle — RP ID stays the apex, so passkeys survive the `app.`→`host.` move. |
| `OSN_ORIGIN` (prod https origins, comma-sep) | osn-api WebAuthn | **DONE — `https://host.cireweddings.com`** (organiser portal = the passkey origin; reshuffle moved it `app.`→`host.`; the transitional `app.` entry was pruned post-cutover 2026-07-16). Picked up on merge — **osn-api auto-deploys via CI** (`deploy-osn-api` in `deploy.yml`); no manual `wrangler deploy` needed. |
| `OSN_ISSUER_URL` (public https base of osn-api) | osn-api + cire | **DONE — `https://id.cireweddings.com`** (custom-domain route in `osn/api/wrangler.toml` `[env.production]`) |
| `OSN_CORS_ORIGIN` (prod app origins, comma-sep) | osn-api | **DONE — `https://host.cireweddings.com`** (organiser portal calls osn-api; reshuffle `app.`→`host.`; transitional `app.` pruned post-cutover 2026-07-16) |
| `OSN_EMAIL_FROM` (verified sender) | osn-api | **DONE — `hello@cireweddings.com`** (Resend sender-domain verification for `cireweddings.com` still required — §1.1) |
| `RESEND_API_KEY` (live email transport) | osn-api | **provision** (Resend domain verify + key — §1.1) |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` | osn-api | optional / **legacy** (Cloudflare-email fallback transport; not used now Resend is the live path — §1.1) |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | osn-api | **provision** (section 1) — region locked to **`ap-southeast-2` (Sydney)** (C-M18 resolved) |
| `INTERNAL_SERVICE_SECRET` (S2S register-service) | osn-api | optional — only to register cire's ARC key (§6.2) |
| `TRUSTED_PROXY_COUNT` (proxy hops in front of osn-api) | osn-api rate limits | optional — CF sets `cf-connecting-ip`, usually unneeded on Workers |
| osn D1 `database_id` per env | osn-api wrangler.toml | **DONE** — dev `a1dfceb8-2e7a-48eb-a161-ad428f3ddff5`, staging `eb71428e-8540-4a30-815f-fb9cd4ae97ea`, prod `767a9ac1-129b-4efa-9fcf-f68ed7a48c38` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS` | osn-api + cire | **provision** (Grafana, section 1) |
| `INTERNAL_SERVICE_SECRET` | osn-api | needed only to register cire's ARC key (section 6.2) |
| cire D1 `database_id` | cire-api wrangler.toml | **DONE** — `6e835474-e0a7-4db9-8883-3247c3c891cd` |
| cire R2 buckets | cire-api | **DONE** — `cire-sheets[-preview]`, `cire-assets[-preview]` |
| cire `WEB_ORIGIN` allowlist (guest **and** organiser origins) | cire-api | **DONE — `https://invite.cireweddings.com,https://host.cireweddings.com`** (reshuffle 2026-07-16: guest→`invite.`, organiser→`host.`; transitional apex + `app.` pruned post-cutover 2026-07-16) |
| cire `OSN_JWKS_URL` / `OSN_ISSUER_URL` | cire-api | **DONE — `https://id.cireweddings.com/.well-known/jwks.json` / `https://id.cireweddings.com`** (must equal osn-api's own `OSN_ISSUER_URL`) |
| `CIRE_API_ARC_PRIVATE_KEY` + `CIRE_API_ARC_KEY_ID` + `OSN_API_URL` | cire-api | needed only if guest account-linking is enabled (section 6.2) |
| cire/web `PUBLIC_API_URL`, `PUBLIC_SITE_URL` (build-time) | cire/web **SSR Worker** | **DONE — `https://api.cireweddings.com` / `https://cireweddings.com`** (set in `deploy.yml`). No `PUBLIC_WEDDING_SLUG` — wedding resolved from the path. Apex now served by the `cire-invites` Worker (custom-domain route), not the Pages project — see §3.3. |
| cire/organiser `PUBLIC_CIRE_API_URL`, `PUBLIC_OSN_ISSUER_URL`, `PUBLIC_CIRE_WEB_URL` (build-time) | cire/organiser Pages | **DONE — `https://api.cireweddings.com` / `https://id.cireweddings.com` / `https://cireweddings.com`** (set in `deploy.yml`) |

---

## 1. Pre-flight (lead-time items — start these early)

### 1.1 Resend email setup (sender-domain verification + API key) 📧

osn-api emails OTPs and security notices through **Resend's HTTP API**
(`https://api.resend.com/emails`; transport selection in
`osn/api/src/lib/email-layer.ts`). Resend is the **live transport** — it works on
workerd over plain HTTP and needs no paid Workers plan (the reason the Cloudflare Email
Service path was originally degraded). In a non-local env osn-api needs a real email
provider by default and fails closed at startup without one (surfaced as a `503 Worker
misconfigured`) **unless** the explicit degraded-email opt-in `OSN_EMAIL_OPTIONAL` is set
(see the box below). With `RESEND_API_KEY` set, email works normally and the opt-in is no
longer needed.

> **The degraded opt-in is now transitional.** 🚦 `OSN_EMAIL_OPTIONAL = "true"` is still in
> `osn/api/wrangler.toml` `[env.production.vars]` so the Worker keeps booting during the
> cutover (it would otherwise fail closed in the window before `RESEND_API_KEY` is set). It
> is **ignored once a real provider is configured** — Resend (or the legacy Cloudflare
> creds) wins. While the opt-in is active AND no provider is set, osn-api boots with a
> **no-op email transport** that **DISCARDS** every transactional email (loud redacted
> startup warning); **OTP step-up, email-change OTPs, and security-notice emails (passkey
> added/removed, recovery-code generate/consume, cross-device login) are NOT delivered**.
> **Passkey login is primary and unaffected.** **Do NOT remove `OSN_EMAIL_OPTIONAL` in the
> same change that adds Resend** — set the secret, confirm delivery, *then* drop the opt-in
> (step 4) so there is never a window where the Worker fails closed before the secret lands.

Setup steps (live path — Resend):

1. `OSN_EMAIL_FROM` is `hello@cireweddings.com` (set in `osn/api/wrangler.toml`
   `[env.production.vars]`). The sender domain is `cireweddings.com`.
2. **Verify the `cireweddings.com` sender domain in Resend** (Resend dashboard → Domains →
   Add Domain). Add the **SPF / DKIM / return-path** DNS records Resend provides into the
   Cloudflare DNS zone for `cireweddings.com` — quick, since the zone is already in-account.
   Wait for verification to go green.
3. Create a Resend API key (Sending access) and set it on osn-api:
   `bunx wrangler secret put RESEND_API_KEY --env production` (repeat per env as needed).
4. Confirm a real send arrives (watch `osn.email.send.attempts{outcome="sent"}`), **then
   remove `OSN_EMAIL_OPTIONAL`** from `osn/api/wrangler.toml` `[env.production.vars]` so a
   future Resend outage fails closed again rather than silently degrading. (Left in place by
   the PR that added Resend — it is removed operationally after delivery is confirmed.)

Until the domain is verified and the key is set, OTP email will not arrive. In the
**fail-closed default** (opt-in unset, no provider) the Worker 503s. In **degraded mode**
(opt-in set, no provider) the Worker boots but mail is discarded per the box above; the
in-memory `LogEmailLive` recorder is local/test only and is never used in production.

The **Cloudflare Email Service** path remains available as a legacy fallback (onboard the
sender domain in Cloudflare Email Sending, mint an Email-Send-scoped token →
`CLOUDFLARE_EMAIL_API_TOKEN`, note `CLOUDFLARE_ACCOUNT_ID`), but it requires a paid Workers
plan and is **not** the live transport — prefer Resend.

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
# Email — REQUIRED non-local UNLESS OSN_EMAIL_OPTIONAL is set (§1.1). RESEND_API_KEY
# is the live transport: verify cireweddings.com in Resend, set the key, confirm a
# send arrives, THEN remove OSN_EMAIL_OPTIONAL from wrangler.toml [vars]:
bunx wrangler secret put RESEND_API_KEY             --env <dev|staging|production>
# Cloudflare email creds — OPTIONAL / LEGACY fallback (needs a paid Workers plan;
# not used now Resend is live). Only set if falling back off Resend:
bunx wrangler secret put CLOUDFLARE_ACCOUNT_ID      --env <dev|staging|production>
bunx wrangler secret put CLOUDFLARE_EMAIL_API_TOKEN --env <dev|staging|production>
# OPTIONAL — only for the cire→osn account-linking ARC bridge (§6.2):
bunx wrangler secret put INTERNAL_SERVICE_SECRET    --env <dev|staging|production>
# Turnstile bot protection (OPTIONAL — only after the widget exists, §3.4):
bunx wrangler secret put TURNSTILE_SECRET_KEY        --env <dev|staging|production>
# Observability (deferred export on workerd; header is a secret):
bunx wrangler secret put OTEL_EXPORTER_OTLP_HEADERS  --env <dev|staging|production>
```

| Name | How to set | Required? | Notes |
|---|---|---|---|
| `OSN_ENV` | `[env.<env>.vars]` (`dev`/`staging`/`production`) | **Yes (master switch)** | Per-env in `wrangler.toml`. Local `wrangler dev` (no `--env`) is `"local"`: ephemeral JWT keys, no `Secure`/`__Host-` cookies, JWT/pepper/email/Upstash throws skipped, OTPs go to the log recorder. Non-local flips all of that on. |
| `OSN_JWT_PRIVATE_KEY` | `wrangler secret put` | **Yes** | base64 ES256 JWK. Throws if missing in non-local. §1.2 |
| `OSN_JWT_PUBLIC_KEY` | `wrangler secret put` | **Yes** | base64 ES256 JWK; published at `/.well-known/jwks.json`. §1.2 |
| `OSN_SESSION_IP_PEPPER` | `wrangler secret put` | **Yes** | ≥32 bytes or throws. §1.3 |
| `OSN_RP_ID` | `[env.<env>.vars]` | **Yes** | WebAuthn RP ID — must be a **registrable domain**. Prod = **`cireweddings.com`** (the registrable apex shared by the organiser portal `app.cireweddings.com`, the only prod passkey surface). Prod passkeys are now UNBLOCKED. |
| `OSN_ORIGIN` | `[env.<env>.vars]` | **Yes** | Comma-sep accepted WebAuthn origins; prod **https** origins. Prod = **`https://app.cireweddings.com`** (the organiser portal — the passkey origin). |
| `OSN_ISSUER_URL` | `[env.<env>.vars]` | **Yes** | Public https base URL of osn-api → JWT `iss`; must match what cire verifies. Prod = **`https://id.cireweddings.com`** (custom-domain route in `wrangler.toml` `[env.production]`). |
| `OSN_CORS_ORIGIN` | `[env.<env>.vars]` | **Yes** | Comma-sep prod app origins. In a secure env an empty list **throws** at `assertCorsOriginsConfigured` (`lib/cors-config.ts`) — Origin/CSRF guard is mandatory. Prod = **`https://app.cireweddings.com`** (organiser portal calls osn-api; the guest site never does). |
| `RESEND_API_KEY` | `wrangler secret put` | **Yes\* (live transport)** | Resend API key (bearer). When set in non-local → `ResendEmailLive` (POST `https://api.resend.com/emails`); **wins over the Cloudflare creds and the opt-in**. Fail-closed at startup if no provider is set in non-local — **unless `OSN_EMAIL_OPTIONAL` is set** (then degraded no-op). With this set, the opt-in is no longer needed. §1.1 |
| `CLOUDFLARE_ACCOUNT_ID` | `wrangler secret put` | Optional / **legacy** | Cloudflare-email fallback transport (paid Workers plan). Used only if `RESEND_API_KEY` is absent. §1.1 |
| `CLOUDFLARE_EMAIL_API_TOKEN` | `wrangler secret put` | Optional / **legacy** | Cloudflare-email fallback bearer token. Same role as `CLOUDFLARE_ACCOUNT_ID`. §1.1 |
| `OSN_EMAIL_OPTIONAL` | `[env.<env>.vars]` | No (default off) | **Explicit degraded-email opt-in (transitional).** Truthy (`true`/`1`/`yes`/`on`) → boot with a **no-op email transport** (transactional mail DISCARDED, loud startup warning) when **no real provider** (`RESEND_API_KEY` / `CLOUDFLARE_*`) is set in a non-local env, instead of failing closed. **Currently `"true"` in prod `[vars]`** to keep the Worker booting during the Resend cutover. A real provider wins — ignored when `RESEND_API_KEY` (or the Cloudflare creds) is present. **Remove it once Resend delivery is confirmed** (§1.1 step 4) so a future Resend outage fails closed again. §1.1 |
| `OSN_EMAIL_FROM` | `[env.<env>.vars]` (or secret) | **Yes (prod)** | Verified sender address. Prod = **`hello@cireweddings.com`** (set in `wrangler.toml`). Resend-verified domain from §1.1. |
| `UPSTASH_REDIS_REST_URL` | `wrangler secret put` | **Yes** | Upstash REST URL. Worker refuses to boot in non-local without it + the token (`index.ts:92-96`). §1.4 |
| `UPSTASH_REDIS_REST_TOKEN` | `wrangler secret put` | **Yes** | Upstash REST token. §1.4 (region `ap-southeast-2` / Sydney — C-M18 resolved) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `[env.<env>.vars]` | Recommended | Grafana OTLP gateway. Metric/trace **export is deferred on workerd** — the redacting logger is active, recording call-sites are no-ops until an exporter is attached. [[observability-setup]] |
| `OTEL_EXPORTER_OTLP_HEADERS` | `wrangler secret put` | Recommended | `Authorization=Basic <base64(instance:token)>`. [[observability-setup]] |
| `INTERNAL_SERVICE_SECRET` | `wrangler secret put` | **Conditional** | Bearer secret guarding `POST /graph/internal/register-service` (`routes/graph-internal.ts`). Needed **only** to register cire-api's ARC public key (§6.2). Endpoint returns 501 when unset. |
| `TURNSTILE_SECRET_KEY` | `wrangler secret put` | **Optional (key-optional)** | Cloudflare Turnstile secret. When set, `/register/begin` + `/login/passkey/begin` **require** a valid Turnstile token and **fail-closed** (reject on missing/invalid/duplicate; single-use enforced by Cloudflare). When unset, those gates are skipped and the flows behave as before — safe to leave unset until the widget exists. Server half of the public `PUBLIC_TURNSTILE_SITEKEY` baked into the organiser-portal build. Create the widget in §3.4. (`build-deps.ts` → `createTurnstileVerifier`). |
| `TRUSTED_PROXY_COUNT` | `[env.<env>.vars]` | Optional | On Workers, Cloudflare sets `cf-connecting-ip`, so this is usually unneeded. Set only if a proxy sits in front and XFF must be trusted N hops. |
| `OSN_RP_NAME` | `[env.<env>.vars]` | Optional | Display name in passkey prompts (default `OSN`). |
| `OSN_ACCESS_TOKEN_TTL` / `OSN_REFRESH_TOKEN_TTL` | `[env.<env>.vars]` | Optional | Defaults 300s / 2592000s. |
| `PULSE_API_URL` / `ZAP_API_URL` | `[env.<env>.vars]` | Optional | Outbound ARC key registration for account-erasure fan-out. |

### 3.2 cire-api (Cloudflare Worker)

| Name | How to set | Required? | Notes |
|---|---|---|---|
| D1 `database_id` | edit `wrangler.toml:15` | **Yes** | §2.1 — `6e835474-e0a7-4db9-8883-3247c3c891cd`. |
| `WEB_ORIGIN` | `wrangler.toml` `[env.production.vars]` | **Yes** | Comma-sep allowlist; must include **both** the guest site origin **and** the organiser portal origin. Each entry must be `https://…` or the Worker fails closed at the edge (`src/index.ts:59-74`). Prod = **`https://cireweddings.com,https://app.cireweddings.com`**. |
| `OSN_JWKS_URL` | `wrangler.toml` `[env.production.vars]` | **Yes** | Deployed osn-api JWKS URL (`<OSN_ISSUER_URL>/.well-known/jwks.json`). Prod = **`https://id.cireweddings.com/.well-known/jwks.json`**. |
| `OSN_ISSUER_URL` | `wrangler.toml` `[env.production.vars]` | **Yes** | Deployed osn-api origin; must equal osn-api's own `OSN_ISSUER_URL`. Prod = **`https://id.cireweddings.com`**. |
| `OSN_AUDIENCE` | `wrangler.toml` `[env.production.vars]:43` | **Yes** | `osn-access` (the user access-token audience). |
| `CIRE_API_ARC_PRIVATE_KEY` | `wrangler secret put CIRE_API_ARC_PRIVATE_KEY` | **Conditional** | ES256 JWK (string). Only if guest account-linking is enabled (§6.2). Absent ⇒ linking `POST` answers 503 (`src/index.ts:78-85`, `services/osn-bridge.ts:99-113`). |
| `CIRE_API_ARC_KEY_ID` | `wrangler secret put CIRE_API_ARC_KEY_ID` | **Conditional** | `kid` matching the public key registered in osn-api `service_accounts` for serviceId `cire-api`. §6.2 |
| `OSN_API_URL` | `wrangler secret put OSN_API_URL` (or var) | **Conditional** | osn-api base URL the ARC bridge calls. §6.2 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` | `wrangler secret put` | Recommended | Worker observability. [[observability-setup]] |
| `TURNSTILE_SECRET_KEY` | `wrangler secret put TURNSTILE_SECRET_KEY` | **Optional (key-optional)** | Cloudflare Turnstile secret. When set, the guest **`/api/claim`** + **`/api/rsvp`** endpoints require a valid Turnstile token and **fail-closed** (403 on missing/invalid/duplicate). Unset ⇒ those gates are skipped (guest flow unchanged). Same widget/secret as osn-api — the widget's domains cover both `cireweddings.com` and `app.cireweddings.com`. Create the widget in §3.4. (`src/index.ts` → `createTurnstileVerifier`). |
| `GOOGLE_GEOCODING_API_KEY` | `wrangler secret put GOOGLE_GEOCODING_API_KEY` | **Optional (key-optional, fail-soft)** | Google Geocoding API key for the organiser per-event venue lookup (`POST /api/organiser/weddings/:id/settings/geocode`, driven from the Events tab's location editor). Unset ⇒ the endpoint answers `unavailable` and the editor falls back to manual lat/lng entry — nothing is ever sent to Google. **Before setting in prod: sign the Google Cloud DPA + confirm the EU→US transfer basis** (see `[[compliance/subprocessors]]`), restrict the key to the Geocoding API, **and set a daily quota cap** in the Google console — the per-IP edge limiter bounds each caller, but only a Google-side cap bounds aggregate spend across many IPs/accounts (S-L2). (`src/index.ts` → `createGoogleGeocoder`.) |

> ⚠️ **cire `wrangler.toml` env nuance:** the D1 + R2 bindings are at the **top level**
> (not under `[env.production]`), while the prod URLs live under `[env.production.vars]`.
> Confirm your deploy command targets the right binding set (section 5.2) — a bare
> `wrangler deploy` uses the top-level bindings and the default vars unless you pass
> `--env production`.

### 3.3 cire/web (Worker SSR) + cire/organiser (Pages — build-time `PUBLIC_*`)

> [!important] cire/web is now an **SSR Cloudflare Worker**, not Pages
> `cire/web` switched to `output: "server"` (the `@astrojs/cloudflare` adapter)
> and is deployed as a **Cloudflare Worker with Static Assets** via
> `wrangler deploy --config dist/server/wrangler.json` (the `deploy-cire-web` job
> in `deploy.yml`). The committed `cire/web/wrangler.jsonc` carries the worker
> name (`cire-invites`) + the **`cireweddings.com` custom-domain route**, and the
> adapter merges in `main`/the ASSETS binding. The old
> `wrangler pages deploy dist --project-name cire` is gone — **the Cloudflare
> Pages project `cire` no longer serves the apex.** The invite route resolves the
> wedding **from the path** (`/<slug>`) at request time and the bare domain (`/`)
> redirects to the primary wedding via `GET /api/primary-wedding`, so there is **no
> `PUBLIC_WEDDING_SLUG`**. No KV/Images binding is required on this Worker (Astro
> sessions pinned to an in-memory driver; image transforms stay in cire-api).
> **One-time Cloudflare setup (DONE 2026-06-19):** the apex moved from the Pages
> project to the `cire-invites` Worker. `custom_domain: true` auto-provisions it on
> `wrangler deploy`; a Pages→Worker move needs the apex detached from the old Pages
> project first (Pages → `cire` → Custom domains) or moved on the Worker side
> (Worker → Domains & Routes → Add → confirm move). A Worker→Worker rename (e.g.
> `cire-invites` → `cire-invites`) reassigns the custom domain automatically on deploy.
> No KV namespace or Images binding to create.
>
> **`legacy_env` strip (deploy foot-gun, fixed 2026-07-16):** the adapter writes a
> top-level `"legacy_env": true` into the generated `dist/server/wrangler.json`.
> Wrangler **4.111.0 removed** that field and hard-errors on it; since `cire/web`
> pins no wrangler, `bunx wrangler` pulls the latest, so the `deploy-cire-web` job
> failed on every merge from the moment 4.111 shipped (the apex stayed up on the
> last-good build — deploys just stopped landing). The job now deletes `legacy_env`
> from the generated config between build and deploy (behaviour-neutral: `true` was
> already the default). If a guest-site deploy fails on a config field again, check
> the generated `dist/server/wrangler.json` against the installed wrangler's schema.

`cire/organiser` is still a **static** Pages build (`output: "static"`); cire/web's
`PUBLIC_*` are read both **server-side per request** and by the client islands but
still bake in **at build time**. The prod values are wired in
`.github/workflows/deploy.yml` (the `deploy-cire-web` / `deploy-cire-organiser` jobs set
them on the build step); a localhost fallback stays in the source for local dev. If you
build outside CI, export these before `bun run --cwd <site> build`.

| Name | Site | Required? | Prod value | Notes |
|---|---|---|---|---|
| `PUBLIC_API_URL` | cire/web | **Yes** | `https://api.cireweddings.com` | cire-api prod origin, read server-side (`[slug].astro` / `index.astro` via `src/lib/invite.ts`) **and** by the islands (dev default `http://localhost:8787`). |
| `PUBLIC_SITE_URL` | cire/web | Recommended | `https://cireweddings.com` | Guest site canonical URL (apex). |
| `PUBLIC_GOOGLE_MAPS_EMBED_KEY` | cire/web | Optional | _(unset)_ | Google Maps Platform key with the **Maps Embed API** enabled. When set, the event "Where" section renders a real Maps Embed iframe (queried by the free-text venue address — no coordinates, no geocoding); when unset/blank it falls back to the CSS-drawn map card, so it is a pure enhancement (`cire/web/src/components/MapPreview.tsx`). **Human step:** create the key, **enable only the Maps Embed API**, and **restrict it by HTTP referrer** to the guest-site origin(s) — the key bakes into static HTML, and a referrer-restricted Embed-only key is safe to ship. |
| `PUBLIC_CIRE_API_URL` | cire/organiser | **Yes** | `https://api.cireweddings.com` | cire-api prod origin (`cire/organiser/src/lib/osn.ts`; `PUBLIC_API_URL` honoured as legacy fallback). |
| `PUBLIC_OSN_ISSUER_URL` | cire/organiser | **Yes** | `https://id.cireweddings.com` | osn-api prod origin for organiser passkey sign-in (`osn.ts`, dev default `http://localhost:4000`). Must equal osn-api's `OSN_ISSUER_URL`. |
| `PUBLIC_CIRE_WEB_URL` | cire/organiser | Recommended | `https://cireweddings.com` | Guest site URL used in organiser preview links (`osn.ts`). |
| `PUBLIC_TURNSTILE_SITEKEY` | cire/web **and** cire/organiser | Optional (key-optional) | _(unset)_ | Cloudflare Turnstile **sitekey** (public — safe to embed in client HTML). When set, the guest claim + RSVP forms (cire/web) and the organiser SignIn + Register forms (cire/organiser, via `@osn/ui`) render the Turnstile challenge and gate submit on it; when unset/blank no widget renders and no token is sent (a pure enhancement). Wired (commented) in the `deploy-cire-web` / `deploy-cire-organiser` build steps as `${{ vars.PUBLIC_TURNSTILE_SITEKEY }}` — set the repo **Variable** + uncomment once the widget exists (§3.4). The matching `TURNSTILE_SECRET_KEY` secret must be set on **both** the cire-api Worker (claim/rsvp) and the osn-api Worker (register/login). |

### 3.4 Create the Cloudflare Turnstile widget (one-time, gates Turnstile on) 🔑

Turnstile is **key-optional** — every flow ships and works with NO widget. Do this
step only when you want bot protection ON. The same widget (one sitekey + one secret)
covers **both** the guest site and the organiser portal.

The `wrangler` OAuth token in use (`owner@example.com`) lacks the `Account.Turnstile:Edit`
scope, so the widget **could not be created programmatically** during this work —
create it in the dashboard (or with a custom API token that has the scope):

1. **Dashboard → Turnstile → Add widget** (account `fad09b83d3590eaeb803eca52d5bf1b7`).
   - **Name:** `cire-weddings`
   - **Domains:** `cireweddings.com`, `app.cireweddings.com` (apex covers the guest
     site; `app.` covers the organiser portal — osn-api's passkey origin). Add
     `localhost` if you want to exercise it locally.
   - **Widget mode:** **Managed** (no pre-clearance — siteverify is the gate).
2. Copy the **Sitekey** (public, `0x…`) and the **Secret key** (private).
3. **Sitekey** → set as the repo **Variable** `PUBLIC_TURNSTILE_SITEKEY` and **uncomment**
   the two `PUBLIC_TURNSTILE_SITEKEY:` lines in `.github/workflows/deploy.yml`
   (`deploy-cire-web` + `deploy-cire-organiser` build steps). Static Astro bakes it
   in at build time, so a **rebuild + redeploy** of both Pages projects is required to
   activate the widget.
4. **Secret key** → set on **both** Workers (never commit it):
   ```bash
   # from osn/api (gates /register/begin + /login/passkey/begin)
   cd osn/api && echo "<secret>" | bunx wrangler secret put TURNSTILE_SECRET_KEY --env production
   # from cire/api (gates /api/claim + /api/rsvp)
   cd cire/api && echo "<secret>" | bunx wrangler secret put TURNSTILE_SECRET_KEY --env production
   ```
   Then `wrangler deploy` both Workers so the new isolate picks up the secret.
5. **Order matters (fail-closed):** set the **secret on the Workers FIRST**, then ship
   the **sitekey** in the Pages build. If you ship the sitekey while the secret is
   absent the widget renders but the server skips verify (harmless); if you set the
   secret while the sitekey is absent the server requires a token the UI never sends
   and legitimate requests 400/403. The safe rollout is secret-first, sitekey-second
   (or both together via a coordinated deploy).

---

## 4. Database migrations

### 4.1 Apply cire D1 migrations (remote)

Migrations live in `cire/db/migrations/` (`0001`…`0015`, incl.
`0015_drop_bootstrap_wedding.sql`). The `database_id` is already wired
(`6e835474-e0a7-4db9-8883-3247c3c891cd`, §2.1):

```bash
# from cire/api (wrangler.toml lives there)
cd cire/api
bunx wrangler d1 migrations apply cire-db --remote
# or, from repo root via the cire/db script:
# bun run --cwd cire/db db:push:remote
```

> Migration `0015_drop_bootstrap_wedding.sql` DELETEs the orphaned demo wedding
> row `wed_bootstrap` (seeded by `0006`, owned by the inert sentinel
> `usr_unclaimed_bootstrap`); its children cascade-delete. Pre-launch there is no
> real data on it. This runs automatically in the CI deploy pipeline's migration
> step (`.github/workflows/deploy.yml`) — no manual action.

> ✅ **No bootstrap-owner step.** cire-api needs **no** `BOOTSTRAP_OWNER_PROFILE_ID`
> and no seeded owner. **Every authenticated OSN user is a first-class
> organiser**: they sign in with their OSN passkey, see their own weddings (an
> empty list for a new account — never a 503), and create new ones via
> `POST /api/organiser/weddings`. Per-wedding access is scoped entirely by
> `weddingOwner()` / `weddingMember()` on the `/api/organiser/weddings/:weddingId/*`
> routes; there is no global boot gate. (Removed in `feat/cire-organiser-open-access`.)

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

> **⚠️ DEPLOY (handle-autocomplete PR):** the `users_handle_idx` migration
> (`osn/db/drizzle/0001_exotic_lady_vermin.sql` — a B-tree index on `users.handle`
> backing co-host handle prefix search) is **NOT applied by CI's `deploy.yml`** —
> osn-api migrations are a **manual** step (this §4.3). Run
> `bun run --cwd osn/db db:migrate:prod` (or the `wrangler … apply osn-db-prod`
> line above) **before** the new osn-api worker that serves
> `GET /graph/internal/profile-search` goes live, then **redeploy osn-api**
> (`cd osn/api && bunx wrangler deploy --env production`) so the new internal
> endpoint is live and isolates cycle. cire-api + Pages auto-deploy on merge and
> need no manual step — until the index + osn-api redeploy land, cire's
> handle-search route simply returns empty lists (fail-soft), and the manual
> add-by-handle path keeps working.

---

## 5. Deploy steps (CI + manual reference)

> The cire Worker + Pages sites deploy via `.github/workflows/deploy.yml` (PR #128).
> The commands below are the manual equivalents — they document what the pipeline runs.

### 5.1 osn-api (Worker)

> **CI (prod):** as of 2026-07-16 the `deploy-osn-api` job in `.github/workflows/deploy.yml`
> auto-deploys prod osn-api on every merge to `main` — migrate (`wrangler d1 migrations
> apply osn-db-prod --remote --env production`) then `wrangler deploy --env production`,
> mirroring cire-api. The manual commands below stay the reference for dev/staging and for
> what the pipeline runs; a manual prod deploy is now only needed out-of-cycle.

osn-api is a Cloudflare Worker (§2.3). With the §3.1 vars in `wrangler.toml` and the
§3.1 secrets set (`wrangler secret put … --env <env>`), and the D1 migrations applied
(§4.3):

```bash
cd osn/api
bunx wrangler types                          # regenerate binding types if bindings changed
bunx wrangler deploy --dry-run --outdir ./dist   # optional: build-only sanity check
bunx wrangler deploy --env dev               # or --env staging | --env production
```

**Prod URL (custom domain):** the production Worker is served at
**`https://id.cireweddings.com`** via the custom-domain route in `osn/api/wrangler.toml`
`[env.production]` (`routes = [{ pattern = "id.cireweddings.com", custom_domain = true }]`).
`custom_domain = true` auto-provisions the DNS record + edge cert on first
`wrangler deploy --env production` because the `cireweddings.com` zone is in-account —
confirm it went green afterwards (§5.4). Prod `OSN_ISSUER_URL` is set to that URL. (dev /
staging stay on their current `workers.dev` config; if/when they get hostnames, set their
`OSN_ISSUER_URL` to the served URL.)

> ✅ **Prod passkeys are now UNBLOCKED.** The WebAuthn RP ID is the registrable apex
> **`cireweddings.com`**, and the only prod passkey surface is the organiser portal
> **`app.cireweddings.com`** (`OSN_ORIGIN`). Guests use claim codes — no passkeys. The RP
> ID is the apex so it covers the `app.` subdomain origin (a credential scoped to
> `cireweddings.com` is usable from `app.cireweddings.com`).

> ℹ️ **cire must point at the deployed osn-api URL.** cire-api's `OSN_JWKS_URL` =
> `https://id.cireweddings.com/.well-known/jwks.json` and `OSN_ISSUER_URL` =
> `https://id.cireweddings.com` (§3.2), and cire/organiser's `PUBLIC_OSN_ISSUER_URL` (§3.3)
> = the same origin — all three must equal osn-api's own `OSN_ISSUER_URL` or token
> verification fails. These are already set in this PR.

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

CI (`deploy-cire-web` / `deploy-cire-organiser` in `deploy.yml`) builds each site with the
prod `PUBLIC_*` vars (§3.3) baked in, then publishes. The guest site uses the `cire` Pages
project; the organiser portal uses a separate **`cire-organiser`** Pages project (create it
once before the first run). Manual equivalents:

```bash
# guest site (Pages project: cire)
PUBLIC_API_URL=https://api.cireweddings.com \
PUBLIC_SITE_URL=https://cireweddings.com \
  bun run --cwd cire/web build
bunx wrangler pages deploy cire/web/dist --project-name cire

# organiser portal (Pages project: cire-organiser)
PUBLIC_CIRE_API_URL=https://api.cireweddings.com \
PUBLIC_OSN_ISSUER_URL=https://id.cireweddings.com \
PUBLIC_CIRE_WEB_URL=https://cireweddings.com \
  bun run --cwd cire/organiser build
bunx wrangler pages deploy cire/organiser/dist --project-name cire-organiser
```

Make sure the published guest + organiser origins are exactly the ones listed in
cire-api's `WEB_ORIGIN` allowlist (§3.2) and in osn-api's `OSN_CORS_ORIGIN` /
`OSN_ORIGIN` (organiser passkey sign-in talks to osn-api).

### 5.4 Attach custom domains (human / dashboard steps) 🌐

The Worker custom domains auto-provision from `wrangler.toml`; the Pages custom domains are
attached in the dashboard. The `cireweddings.com` zone is already in-account, so all DNS +
certs are issued automatically once attached.

1. **Worker custom domains (auto, verify only).** After `wrangler deploy --env production`:
   - osn-api → **`id.cireweddings.com`** (route in `osn/api/wrangler.toml`).
   - cire-api → **`api.cireweddings.com`** (route in `cire/api/wrangler.toml`).
   Confirm both show as active custom domains for their Worker (dashboard → Workers →
   *worker* → Settings → Domains & Routes, or `https://id.cireweddings.com/health` /
   `https://api.cireweddings.com/` return 200). `custom_domain = true` provisions the DNS
   record + cert; no manual DNS entry needed.
2. **Pages custom domains (dashboard, one-time).** In each Pages project → Custom domains:
   - `cire` (guest site) → add the apex **`cireweddings.com`**.
   - `cire-organiser` (organiser portal) → add **`app.cireweddings.com`**.
   Cloudflare adds the CNAME/records in the in-account zone and issues the cert. After the
   apex is attached to Pages, confirm it does not collide with the email/DNS records from
   §1.1 (SPF/DKIM/DMARC are TXT records, the apex Pages target is a separate record type —
   they coexist).
3. **Re-check the allowlists** once the domains resolve: the live guest + organiser origins
   must exactly match cire-api `WEB_ORIGIN` and osn-api `OSN_CORS_ORIGIN` / `OSN_ORIGIN`
   (all set in this PR). A trailing-slash or scheme mismatch fails the Origin guard.

---

## 6. Optional: guest account-linking bridge (cire → osn)

Account-linking (`POST /api/account/link`) lets a guest attach their household to their
OSN account. It is **additive and opt-in**; skip this section for the minimal launch.

### 6.1 What it needs

- cire-api: `CIRE_API_ARC_PRIVATE_KEY` (ES256 JWK), `CIRE_API_ARC_KEY_ID`, `OSN_API_URL`
  (§3.2). All three absent ⇒ the linking POST simply answers 503 (`src/index.ts:78-85`).
- osn-api: cire-api's matching ES256 **public** key registered in `service_accounts`
  under serviceId `cire-api` with scopes `graph:read,graph:resolve-account`, so osn-api
  can verify cire's ARC token on `GET /graph/internal/profile-account`
  (`services/osn-bridge.ts`). The `graph:resolve-account` scope is the dedicated gate
  on that endpoint (S-M1 pulse-onboarding) — a `graph:read`-only registration gets 401
  on account resolution. If cire-api was registered before this scope existed, re-run
  §6.2 with the widened `allowedScopes` (the endpoint upserts).

> ⚠ **Deploy order for the `graph:resolve-account` rollout (S-L2).** There is no
> order that avoids a brief account-linking outage without the manual step: new
> cire-api mints `graph:resolve-account` (old osn-api's registry rejects it), and new
> osn-api rejects old cire-api's `graph:read` on `/profile-account`. CI auto-deploys
> cire-api on merge while osn-api deploys are manual, so `POST /api/account/link`
> **401s from merge time until BOTH steps below are done**:
> 1. Deploy the osn-api Worker first (its widened `PERMITTED_SCOPES` is
>    backwards-compatible for every route except `/profile-account`).
> 2. Re-run §6.2 with `allowedScopes: "graph:read,graph:resolve-account"` (upsert).
>
> Likewise deploy osn-api **before** pulse-api in any environment — a new pulse-api
> booting against an old osn-api gets 400 `Unknown scopes: graph:resolve-account`
> from `/register-service`, which is fatal at boot in non-local envs. Impact is
> availability-only (the linking endpoint is additive/opt-in; failure mode is
> 401/503, never a bypass).

### 6.2 Register cire's ARC public key with osn-api

This is what `INTERNAL_SERVICE_SECRET` is for. Generate a stable ES256 key pair for
cire-api (same command as §1.2), store the **private** JWK as `CIRE_API_ARC_PRIVATE_KEY`
and the chosen `kid` as `CIRE_API_ARC_KEY_ID`, then register the **public** half:

```bash
curl -X POST "$OSN_ISSUER_URL/graph/internal/register-service" \
  -H "Authorization: Bearer $INTERNAL_SERVICE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"serviceId":"cire-api","keyId":"<CIRE_API_ARC_KEY_ID>","publicKeyJwk":"<public JWK string>","allowedScopes":"graph:read,graph:resolve-account,org:read"}'
```

(`POST /graph/internal/register-service` returns 501 if `INTERNAL_SERVICE_SECRET` is
unset, 401 on a bad bearer — `routes/graph-internal.ts:203-214`.)

> **Vendors (Phase 2): re-run this command per environment after the `@osn/api` `PERMITTED_SCOPES` change deploys.**
> The `org:read` scope (added in the Vendors PR A — migration 0040) enables cire-api's `vendorOrgMember()` middleware to resolve OSN org membership over ARC. The registration endpoint upserts, so re-running is safe and idempotent. Until it runs **per env**, the `vendorOrgMember()` org resolver fails-soft to null and `/api/vendor/*` writes return **503**. The organiser CRM (`/api/organiser/weddings/:weddingId/vendors`) and claim-link generation work regardless — they use only `graph:read`/`graph:resolve-account`.

---

## 7. Post-deploy verification (smoke checks)

Run these in order; each maps to a startup requirement enumerated above.

1. **Health / readiness / JWKS.** `curl https://id.cireweddings.com/health`,
   `/` , and `/.well-known/jwks.json` (and the cire-api root `https://api.cireweddings.com/`).
   200s confirm the Worker
   booted — meaning none of the startup throws fired (or, at the edge, no 503
   `Worker misconfigured`), so the JWT keys, pepper, and Upstash are all present (and
   either the email creds are present, or `OSN_EMAIL_OPTIONAL` is set and the Worker is
   running in degraded email mode — §1.1). `/.well-known/jwks.json` must return an ES256
   (`alg:"ES256"`, P-256) JWK.
2. **No ephemeral-key warning in logs.** Search osn-api boot logs; you must **NOT** see
   `"Using ephemeral JWT key pair — tokens will be invalidated on restart"`
   (`osn/api/src/index.ts:272-275`). If you do, `OSN_ENV` and/or the JWT key vars are not
   set — stop and fix before letting users in.
3. **Upstash reachable.** Confirm the Worker booted (no 503 `Worker misconfigured`
   refusing to fall back to in-memory limiters) — in non-local both
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` must be set, or the Worker
   fails closed (`osn/api/src/index.ts:92-96`). Hit a rate-limited endpoint and confirm
   limits persist across isolates.
4. **OTP email arrives — ONLY if email is enabled.** If the `CLOUDFLARE_*` creds are
   provisioned (email NOT degraded), trigger an OTP flow (e.g. organiser sign-up/step-up):
   a real email must land at the test address — this exercises §1.1 end-to-end. If nothing
   arrives, check `CLOUDFLARE_*` creds and sender-domain verification. **In degraded mode
   (`OSN_EMAIL_OPTIONAL` set, §1.1) skip this check** — no OTP/security-notice email is
   delivered by design; instead confirm the boot logs show the loud
   `EMAIL DEGRADED: … booting with a NO-OP email transport` warning, and rely on passkey
   login (step 5) as the primary, unaffected factor.
5. **Organiser passkey sign-in works.** On the prod organiser portal, any user
   registers + signs in with an OSN passkey. This validates `OSN_RP_ID`, `OSN_ORIGIN`,
   `OSN_ISSUER_URL`, `OSN_CORS_ORIGIN` (osn-api side) and `PUBLIC_OSN_ISSUER_URL`
   (organiser build).
6. **Organiser dashboard works for any OSN user.** A freshly signed-in account sees an
   **empty wedding list** (`GET /api/organiser/weddings` → `200 {weddings: []}`, never a
   404/503), and can **create their first wedding** via the portal's create form
   (`POST /api/organiser/weddings` → `201`). No bootstrap-owner config is involved.
   Confirm a created wedding then appears in the list and is owner-scoped (another
   account's list stays empty). Verify with:
   `bunx wrangler d1 execute cire-db --remote --command "SELECT count(*) FROM weddings;"`.
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
| Email transport selection (fail-closed default + `OSN_EMAIL_OPTIONAL` degraded opt-in + sender) | `osn/api/src/lib/email-layer.ts`; no-op transport `shared/email/src/noop.ts` |
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
| Drop orphaned demo wedding (`wed_bootstrap`) | `cire/db/migrations/0015_drop_bootstrap_wedding.sql` |
| Organiser open access (any OSN user; no boot gate) | list/create `cire/api/src/routes/organiser-weddings.ts`; per-wedding authz `cire/api/src/middleware/wedding-owner.ts`, `wedding-member.ts` |
| cire migrate scripts | `cire/db/package.json` (`db:push:remote`) |

## Related

- [[observability-setup]] — OTel/Grafana endpoint + header wiring
- [[cire-auth]] — guest/organiser two-auth model + cire→osn ARC bridge
- [[database-environments]] — local bun:sqlite vs dev/staging/prod D1
- [[redis]] — Redis-backed rate limiters + session stores
- [[email]] — transactional email transport (Cloudflare Email Service)
- [[vendors]] — vendor portal screens, API surface, token-stripping, Referrer-Policy, ARC org:read scope


---

## 8. Vendor portal first-run (manual, one-time)

> **These steps are NOT automated.** They must be performed manually by a team member with Cloudflare account access before or immediately after the first `deploy-cire-vendor` CI job runs. They are flagged here so the person merging PR B knows to action them. See [[vendors]] for the full vendor portal system doc; see [[cire-auth]] for the auth model the portal relies on.

### 8.1 Create the Pages project

```bash
bunx wrangler pages project create cire-vendor
```

This must be done **once** before the CI deploy job references it. If the project does not exist, the deploy job errors with "project not found."

### 8.2 Add the custom domain

In the Cloudflare dashboard (or via Wrangler if supported):

1. Open the `cire-vendor` Pages project.
2. Go to **Custom domains** → **Set up a custom domain**.
3. Enter `vendor.cireweddings.com`.
4. Cloudflare will create the DNS CNAME record on the `cireweddings.com` zone automatically (zone is managed in this account). Confirm the CNAME is present.

### 8.3 Confirm CORS allowlist changes are live

After the PR B merge deploy completes, verify that both Workers now allow the new origin. The allowlist entries (`https://vendor.cireweddings.com` added to `cire/api/wrangler.toml` `WEB_ORIGIN` and `osn/api/wrangler.toml` `OSN_ORIGIN` / `OSN_CORS_ORIGIN`) ship automatically with the PR B merge via normal CI deploy jobs — no separate `wrangler deploy` is needed.

Quick smoke check (replace `<token>` with a real short-lived claim token from a test seed):

```bash
# CORS preflight to cire-api
curl -si -X OPTIONS https://api.cireweddings.com/api/vendor/listing \
  -H "Origin: https://vendor.cireweddings.com" \
  -H "Access-Control-Request-Method: GET" \
  | grep -i "access-control"

# CORS preflight to osn-api
curl -si -X OPTIONS https://id.cireweddings.com/organisations \
  -H "Origin: https://vendor.cireweddings.com" \
  -H "Access-Control-Request-Method: GET" \
  | grep -i "access-control"
```

Expected: `access-control-allow-origin: https://vendor.cireweddings.com` in both responses.

### 8.4 Secrets

No new secret is required for the vendor portal itself:

- `RESEND_API_KEY` — already set on `cire-api` (see §1.1 and §3.2). The `vendor-claim-invite` email uses it.
- The vendor portal (`cire/vendor`) is a static Pages app with no server-side secrets. It reads from `cire-api` and `osn-api` via `authFetch` in the browser.

### 8.5 ARC re-registration (org:read scope)

The vendor portal uses `vendorOrgMember()` middleware, which requires the `org:read` scope on cire-api's ARC key registration. Re-run the §6.2 `register-service` call per environment with `allowedScopes: "graph:read,graph:resolve-account,org:read"` after deploying. Until this runs, `/api/vendor/*` writes return 503 (the organiser CRM and claim-link generation are unaffected).

### 8.6 Rollback

If the vendor portal must be rolled back:

1. Remove the `https://vendor.cireweddings.com` entries from `cire/api/wrangler.toml` `WEB_ORIGIN` and `osn/api/wrangler.toml` `OSN_ORIGIN` / `OSN_CORS_ORIGIN`.
2. Merge the revert PR — CI redeploys both Workers with the narrowed allowlists.
3. Optionally disable the `cire-vendor` Pages project custom domain in the Cloudflare dashboard.

The Pages project itself does not need to be deleted — it can be left idle.

---

## 9. zap-api production bring-up (PR A follow-up)

> ⚠️ **Requires explicit authorization; prod writes.** Every step in this section modifies production infrastructure or sets production secrets. Do NOT execute any of these steps without explicit human authorization from the team. They are documented here as a deploy-time checklist, not as automated tasks.

These steps are manual follow-ups to the c2b chats PR (Zap PR A). The `deploy-zap-api` CI job exists in `.github/workflows/deploy.yml` but is **dormant** until step 9.1 is completed — it will not fire on merges until the prod D1 id is filled in.

### 9.1 Create the zap-db-prod D1 database

```bash
# From repo root or zap/api/
bunx wrangler d1 create zap-db-prod --location oc
```

Copy the returned `database_id` and paste it into `zap/api/wrangler.toml` under `[env.production]`:

```toml
[[env.production.d1_databases]]
binding = "DB"
database_name = "zap-db-prod"
database_id = "<paste-id-here>"          # replace "placeholder-replace-after-d1-create"
migrations_dir = "../db/drizzle"
```

Commit and merge this change. **This activates the dormant `deploy-zap-api` CI job** — subsequent merges to `main` will automatically build and deploy zap-api to production and apply D1 migrations.

> **Region:** use `--location oc` (Oceania / Sydney) to co-locate with the other D1 databases (osn-db-prod and cire-db, all `oc`) and Upstash (`ap-southeast-2`). AU-centric traffic, low write latency.

### 9.2 Set zap-api production secrets

```bash
# From zap/api/
cd zap/api

# REQUIRED: OSN JWKS URL for access-token verification (also set as a [vars] entry in
# wrangler.toml [env.production.vars]; confirm it is already OSN_JWKS_URL = "https://id.cireweddings.com/.well-known/jwks.json")
# No secret needed for OSN_JWKS_URL — it is a plaintext var.

# REQUIRED: S2S bearer secret for ARC key registration at POST /internal/register-service.
# Needed to register cire-api's ARC public key with zap-api (§9.3 below).
bunx wrangler secret put INTERNAL_SERVICE_SECRET --env production

# OPTIONAL: ZAP_CORS_ORIGIN — comma-sep origins that may call user-facing /chats* routes
# (zap/app when it ships). Not required for c2b which uses internal routes only.
# bunx wrangler secret put ZAP_CORS_ORIGIN --env production
```

| Secret | Required? | Notes |
|---|---|---|
| `OSN_JWKS_URL` | Set as `[vars]` in wrangler.toml | Already in `zap/api/wrangler.toml [env.production.vars]` = `https://id.cireweddings.com/.well-known/jwks.json`. No separate secret needed. |
| `INTERNAL_SERVICE_SECRET` | **Yes (for §9.3)** | Guards `POST /internal/register-service`. Without it zap-api returns 501 on that endpoint. |
| `ZAP_CORS_ORIGIN` | Optional | Only needed once `@zap/app` client ships and calls user-facing routes. `c2b` uses only internal ARC routes. |

### 9.3 Register cire-api's ARC public key with zap-api

This mirrors the cire↔osn `org:read` registration in §6.2. cire-api needs the `chat:c2b` scope on zap-api to provision and message c2b chats.

Generate a stable ES256 key pair for cire-api's zap bridge (same command as §1.2 — or reuse an existing key pair if cire already has one for its osn-api bridge):

```bash
node -e "const {subtle}=globalThis.crypto; subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']).then(async k=>{const {exportJWK}=await import('jose');console.log('private:',btoa(JSON.stringify(await exportJWK(k.privateKey))));console.log('public:',btoa(JSON.stringify(await exportJWK(k.publicKey))))})"
```

Store the private key as a cire-api Worker secret and record the public key + kid:

```bash
# From cire/api/
bunx wrangler secret put CIRE_ZAP_ARC_PRIVATE_KEY --env production
bunx wrangler secret put CIRE_ZAP_ARC_KEY_ID      --env production   # the "kid" value
# NOTE: ZAP_API_URL is NOT a secret — it is set as a plaintext var in
# cire/api/wrangler.toml [env.production.vars] = "https://zap.cireweddings.com".
# No `wrangler secret put ZAP_API_URL` needed.
```

Then register the public half with zap-api (mirrors §6.2 for osn-api):

```bash
curl -X POST "$ZAP_API_URL/internal/register-service" \
  -H "Authorization: Bearer $INTERNAL_SERVICE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"serviceId":"cire-api","keyId":"<CIRE_ZAP_ARC_KEY_ID>","publicKeyJwk":"<public JWK string>","allowedScopes":"chat:c2b"}'
```

(`POST /internal/register-service` returns 501 if `INTERNAL_SERVICE_SECRET` is unset on zap-api, 401 on a bad bearer. The registration is an upsert — safe to re-run.) Until this step runs per environment, cire-api's `/api/organiser/weddings/:id/enquiries` and vendor-enquiry flows return 503 (the zap-api bridge fails-soft when the ARC key is absent).

> ⚠️ **Requires explicit authorization; prod writes.** This is a human-executed deploy-time step — not run by CI or triggered by this PR. Perform it once per environment (dev / staging / prod) after zap-api is deployed and `INTERNAL_SERVICE_SECRET` is set.
>
> **Trigger condition:** if `POST https://zap.cireweddings.com/internal/register-service` returns 501, `INTERNAL_SERVICE_SECRET` is not yet set on zap-api → complete §9.2 first, then re-attempt.

### 9.4 Apply zap-db-prod migrations

Once the D1 database exists and the wrangler.toml is updated (§9.1), apply the schema migrations:

```bash
# From zap/api/ (migrations_dir = "../db/drizzle" is in wrangler.toml)
bunx wrangler d1 migrations apply zap-db-prod --env production --remote

# Or via the @zap/db script:
# bun run --cwd zap/db db:migrate:prod
```

The CI deploy job (`deploy-zap-api`) runs migrations automatically on each deploy once activated — this manual step is needed only for the initial bring-up before the first CI deploy fires.

### 9.5 Smoke-check zap-api production

After the first `deploy-zap-api` run completes:

1. **Health check.** `curl https://<zap-api-prod-url>/health` → 200 (confirms the Worker booted, D1 binding is present, JWKS URL is set).
2. **D1 row count.** `bunx wrangler d1 execute zap-db-prod --remote --command "SELECT count(*) FROM chats;"` → `0` (empty schema, migrations applied).
3. **ARC registration (smoke).** After §9.3, a test `POST /internal/chats` from cire-api should return 201 (not 401/403/503). Confirm the `class` column on the returned row is `'c2b'`.

