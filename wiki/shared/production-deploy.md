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
  - "[[cire-vendors]]"
  - "[[musubi-identity-migration]]"
  - "[[dev-environment]]"
  - "[[cire-entitlements]]"
  - "[[stripe-webhooks]]"
last-reviewed: 2026-10-09
---

# Production Deploy Runbook — osn + cire

> Scope: the first production cut-over of **osn-api** (identity/auth, **now a
> Cloudflare Worker** — `export default { fetch, scheduled }` in
> `osn/api/src/index.ts`, migration Phase 6) and the **cire** wedding-invite
> stack (**cire-api** Worker + **cire/invites** guest **SSR Worker** + **cire/host**
> Pages portal). _(cire/invites was a static Pages site; it is now an SSR Worker — see §3.3.)_
>
> **osn-api is a Worker now (was a long-running Bun process).** All its secrets
> are set with `wrangler secret put … --env <env>` and surfaced **only on the
> `env` binding** (never `process.env` on workerd); non-secret config lives in
> `osn/api/wrangler.toml` `[vars]` / `[env.<env>.vars]`. The Bun dev server
> (`osn/api/src/local.ts`) is unchanged and remains the local devloop only — it
> is **not** the production runtime. §3.1 and §5.1 now use the correct Worker
> framing. Some `osn/api/src/index.ts:NN` line refs below predate the Worker
> entry rewrite and are approximate.
>
> **CI pipeline:** a GitHub Actions deploy workflow (`.github/workflows/deploy.yml`,
> PR #128) deploys the cire Worker + Pages sites; the manual `wrangler` commands
> in section 5 remain the reference for what the pipeline runs and for the
> osn-api Worker deploy.
>
> Read alongside [[observability-setup]] (OTel/Grafana wiring) and
> [[cire-auth]] (the two-auth model + the cire→osn ARC bridge).

⚠️ **Never put real secret values in this file or any committed file.** Set every secret
below out-of-band with `wrangler secret put` (osn-api **and** cire-api are both Workers).

> **🔀 Domain reshuffle (2026-07-16) — end-state supersedes older `app.`/apex
> framing below.** Apex `cireweddings.com` → marketing **landing** site;
> `invite.cireweddings.com` → **guest** site (`cire/invites`); `host.cireweddings.com`
> → **organiser** portal (moved off `app.cireweddings.com`); `api.` / `id.`
> unchanged. Passkeys survived *that* move (`OSN_RP_ID` stayed the registrable apex
> `cireweddings.com`) — see the next note, which is where they stopped surviving. The full
> cutover — code changes already merged + the manual Cloudflare dashboard steps + the
> osn-api manual redeploy — is in **[[cire-landing]] → "Apex cutover"**. Where a line below
> still says `app.cireweddings.com` as the organiser origin or apex-as-guest-site, read it
> as `host.cireweddings.com` / `invite.cireweddings.com` post-reshuffle.

> **🔑 Identity move (2026-07-27) — supersedes every `id.cireweddings.com` /
> `me.cireweddings.com` reference below.** OSN identity now lives on a zone of its own:
> `osn-api` on **`id.musubi.social`**, `@musubi/social` (identity app + OIDC consent screen) on
> the **`musubi.social` apex**, WebAuthn RP ID **`musubi.social`**. Two consequences worth
> reading before you deploy anything: **every passkey enrolled under `cireweddings.com` is
> dead** (recovery codes are the only way in), and **cire sign-in — organiser, vendor and
> guest linking — now runs through the OIDC redirect**, not a local passkey ceremony.
> Bearer-token verification is unaffected. Full reasoning + cutover order in
> **[[musubi-identity-migration]]**; the client registration and its secret are §3.5.

---

## 0. Values to fill before deploy (read this first)

Everything in this list must have a real value before you start. Anything still
marked **TBD** blocks the deploy.

| Value | Used by | Status |
|---|---|---|
| `OSN_JWT_PRIVATE_KEY` / `OSN_JWT_PUBLIC_KEY` (ES256 JWK, base64) | osn-api | **generate** (section 1) |
| `OSN_SESSION_IP_PEPPER` (≥32 bytes) | osn-api | **generate** (section 1) |
| `OSN_TOTP_ENCRYPTION_KEY` (exactly 32 bytes, base64) | osn-api | **DONE — set on dev and on production 2026-09-13** (`set-osn-api-secret` run 34760078500). Production ran without it from the 2026-07-27 cutover until then and answered 503 `Worker misconfigured` on **every** route, not just the TOTP ones — see §7 smoke check 1 for why a deploy can go green with the key missing. To set it on a new tier: `openssl rand -base64 32`, **keep your copy** (see below), add it as that tier's GitHub Environment secret, then run the `set-osn-api-secret` workflow. It must exist BEFORE the first deploy of the tier. Rotatable, in the fixed order in §10. See [[totp]]. |
| `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS` (exactly 32 bytes, base64) | osn-api | **optional** — set only while a rotation drains (§10), and deleted afterwards. Present-but-malformed fails the boot exactly as the current key does. |
| `OSN_RP_ID` (WebAuthn RP ID — registrable domain) | osn-api WebAuthn | **DONE — `musubi.social`** (identity's own registrable apex, as of the 2026-07-27 move — §5.4, [[musubi-identity-migration]]). It covers the apex itself plus every future `*.musubi.social` surface. **This invalidated every passkey enrolled under `cireweddings.com`** — the private half is bound to the RP ID inside the authenticator, so nothing in D1 re-points it. |
| `OSN_ORIGIN` (prod https origins, comma-sep) | osn-api WebAuthn | **DONE — `https://musubi.social`** (the identity app — the one surface that can legally run a ceremony under the new RP ID). The cire origins were **removed** on 2026-07-27: a different registrable domain cannot run a ceremony for RP ID `musubi.social`, so listing them would only have hidden the failure. Picked up on merge — **osn-api auto-deploys via CI** (`deploy-osn-api` in `deploy.yml`); no manual `wrangler deploy` needed. |
| `OSN_ISSUER_URL` (public https base of osn-api) | osn-api + cire | **DONE — `https://id.musubi.social`** (custom-domain route in `osn/api/wrangler.toml` `[env.production]`; moved off `id.cireweddings.com` 2026-07-27) |
| `OSN_CORS_ORIGIN` (prod app origins, comma-sep) | osn-api | **DONE — `https://musubi.social,https://host.cireweddings.com,https://vendor.cireweddings.com,https://invite.cireweddings.com`**. The cire origins stay here even though they left `OSN_ORIGIN` — these are two different lists: CORS governs browser calls, `OSN_ORIGIN` governs WebAuthn ceremonies. Since the 2026-07-27 OIDC swap the cire entries are **vestigial**: no cire browser calls osn-api any more (the exchange is server-side on cire-api, and the `/authorize` hop is a top-level navigation, not a CORS request). Pruning them is a tidy-up, not a fix — do it in its own change so a missed caller shows up alone. |
| `OSN_EMAIL_FROM` (verified sender) | osn-api | **DONE — `hello@cireweddings.com`** (Resend sender domain `cireweddings.com` verified — §1.1). **Deliberately not moved to musubi.social**: no verified musubi.social sender exists, and Resend fails closed on an unauthenticated domain — which would take OTP step-up down, the exact path back in after a recovery-code login. See [[email]]. |
| `RESEND_API_KEY` (live email transport) | osn-api | **DONE** — set on the production Worker; delivering since 2026-06-18 (§1.1) |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` | osn-api | optional / **legacy** (Cloudflare-email fallback transport; not used now Resend is the live path — §1.1) |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | osn-api | **provision** (section 1) — region locked to **`ap-southeast-2` (Sydney)** (C-M18 resolved) |
| `INTERNAL_SERVICE_SECRET` (S2S register-service) | osn-api | optional — only to register cire's ARC key (§6.2) |
| `TRUSTED_PROXY_COUNT` (proxy hops in front of osn-api) | osn-api rate limits | optional — CF sets `cf-connecting-ip`, usually unneeded on Workers |
| osn D1 `database_id` per env | osn-api wrangler.toml | **DONE** — dev `a1dfceb8-2e7a-48eb-a161-ad428f3ddff5`, staging `eb71428e-8540-4a30-815f-fb9cd4ae97ea`, prod `767a9ac1-129b-4efa-9fcf-f68ed7a48c38` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS` | osn-api + cire | **provision** (Grafana, section 1) |
| `INTERNAL_SERVICE_SECRET` | osn-api | needed only to register cire's ARC key (section 6.2) |
| cire D1 `database_id` | cire-api wrangler.toml | **DONE** — `6e835474-e0a7-4db9-8883-3247c3c891cd` |
| cire R2 buckets | cire-api | **DONE** — `cire-sheets`, `cire-assets` (the `-preview` pair was deleted 2026-07-27) |
| cire `WEB_ORIGIN` allowlist (guest, organiser **and** vendor origins) | cire-api | **DONE — `https://invite.cireweddings.com,https://host.cireweddings.com,https://vendor.cireweddings.com`** (reshuffle 2026-07-16: guest→`invite.`, organiser→`host.`; transitional apex + `app.` pruned post-cutover 2026-07-16) |
| cire `OSN_JWKS_URL` / `OSN_ISSUER_URL` | cire-api | **DONE — `https://id.musubi.social/.well-known/jwks.json` / `https://id.musubi.social`** (must equal osn-api's own `OSN_ISSUER_URL`, so these flip in the **same** deploy as osn-api's) |
| `CIRE_API_ARC_PRIVATE_KEY` + `CIRE_API_ARC_KEY_ID` + `OSN_API_URL` | cire-api | needed only if guest account-linking is enabled (section 6.2) |
| cire/invites `PUBLIC_API_URL`, `PUBLIC_SITE_URL` (build-time) | cire/invites **SSR Worker** | **DONE — `https://api.cireweddings.com` / `https://invite.cireweddings.com`** (set in `deploy.yml`). No `PUBLIC_WEDDING_SLUG` — wedding resolved from the path. `invite.` is served by the `cire-invites` Worker (custom-domain route), not a Pages project — see §3.3. The apex serves the marketing landing site. |
| cire/host `PUBLIC_CIRE_API_URL`, `PUBLIC_OSN_ACCOUNT_URL`, `PUBLIC_CIRE_WEB_URL` (build-time) | cire/host Pages | **DONE — `https://api.cireweddings.com` / `https://musubi.social` / `https://invite.cireweddings.com`** (set in `deploy.yml`). `PUBLIC_OSN_ISSUER_URL` is **gone** as of the 2026-07-27 OIDC swap — the frontends never call the issuer |
| `CIRE_OIDC_CLIENT_SECRET` + the `oauth_clients` row for cire | cire-api (secret) + osn D1 | **DONE 2026-07-27** — client `cid_cire` seeded in prod D1, secret set on the production cire-api Worker (§3.2, §6.3). The row's `redirect_uris` still lists the dead `api-preview` callback; pruning it is an open prod-D1 write |
| musubi/social `VITE_OSN_ISSUER_URL` (build-time) | musubi/social Pages (`osn-social`) | **DONE — `https://id.musubi.social`** (set in `deploy.yml`, job `deploy-osn-social`) |
| musubi/social `VITE_TURNSTILE_SITEKEY` (build-time) | musubi/social Pages (`osn-social`) | **DONE — `${{ vars.PUBLIC_TURNSTILE_SITEKEY }}`** in `deploy-osn-social`. **Not optional**: osn-api holds `TURNSTILE_SECRET_KEY`, and musubi.social is now the only origin running the OSN ceremonies, so a blank sitekey means `400 turnstile_failed` on every sign-in and registration (this is exactly what broke on 2026-07-27). [[turnstile]] |
| `OSN_AUTHORIZE_UI_URL` (OIDC consent screen) | osn-api wrangler.toml | **DONE — `https://musubi.social/authorize`**. Needs the apex attached to the `osn-social` Pages project (§5.4) to resolve |
| **musubi.social zone: apex → `osn-social` Pages, `id.` → osn-api Worker** | Cloudflare dashboard | **Apex attached 2026-07-27.** The Worker side auto-provisions on first deploy (`custom_domain = true`, zone in-account) — verify `https://id.musubi.social/health` returns 200 after the merge deploy. §5.4. |
| **musubi.social on the Turnstile widget** | Cloudflare dashboard | **DONE 2026-07-27.** `id.musubi.social` is not needed — only form-rendering hostnames are. [[turnstile]] |

---

## 1. Pre-flight (lead-time items — start these early)

### 1.1 Resend email setup (sender-domain verification + API key) 📧

osn-api emails OTPs and security notices through **Resend's HTTP API**
(`https://api.resend.com/emails`; transport selection in
`osn/api/src/lib/email-layer.ts`). Resend is the **live transport** — it works on
workerd over plain HTTP and needs no paid Workers plan (the reason the Cloudflare Email
Service path was originally degraded). In a non-local env osn-api needs a real email
provider. Without one it fails closed at startup, which surfaces as a `503 Worker
misconfigured`. The one exception is the degraded-email opt-in `OSN_EMAIL_OPTIONAL` (see
the box below).

> **Production is on the live path and the degraded opt-in is gone.** ✅
> `RESEND_API_KEY` is set on the production Worker and mail has delivered from
> `hello@cireweddings.com` since 2026-06-18, so `OSN_EMAIL_OPTIONAL` was removed from
> `osn/api/wrangler.toml` in #160 — production fails closed again. The steps below are
> the reference for a new environment, and the box that follows describes the escape
> valve you would use if a fresh env has to boot before its key lands.

> **The degraded opt-in, if you ever set it.** 🚦 `OSN_EMAIL_OPTIONAL = "true"` in an
> env's `[vars]` keeps the Worker booting in the window before `RESEND_API_KEY` is set. A
> real provider — Resend, or the legacy Cloudflare creds — **overrides the opt-in**.
> While the opt-in is active AND no provider is set, osn-api boots with a
> **no-op email transport** that **DISCARDS** every transactional email (loud redacted
> startup warning); **OTP step-up, email-change OTPs, and security-notice emails (passkey
> added/removed, recovery-code generate/consume, cross-device login) are NOT delivered**.
> **Passkey login is primary and unaffected.** **Do NOT remove `OSN_EMAIL_OPTIONAL` in the
> same change that adds Resend** — set the secret, confirm delivery, *then* drop the opt-in
> (step 7) so there is never a window where the Worker fails closed before the secret lands.

⚠️ In a **new** env, until the domain is verified and the key is set, OTP email does not
arrive. In the **fail-closed default** (opt-in unset, no provider) the Worker 503s. In
**degraded mode** (opt-in set, no provider) the Worker boots but discards mail, per the
box above. The in-memory `LogEmailLive` recorder is local/test only and never runs in
production.

Setup steps (live path — Resend). Production has finished all seven:

1. `OSN_EMAIL_FROM` is `hello@cireweddings.com` (set in `osn/api/wrangler.toml`
   `[env.production.vars]`). The sender domain is `cireweddings.com`.
2. **Verify the `cireweddings.com` sender domain in Resend** (Resend dashboard → Domains →
   Add Domain). Done for production.
3. Add the **SPF / DKIM / return-path** DNS records Resend provides into the Cloudflare
   DNS zone for `cireweddings.com`. The zone is already in-account, so this is quick.
4. Wait for verification to go green.
5. Create a Resend API key (Sending access). Set it on osn-api:
   `bunx wrangler secret put RESEND_API_KEY --env production` (repeat per env as needed).
6. Confirm a real send arrives. Watch `osn.email.send.attempts{outcome="sent"}`.
7. **Then remove `OSN_EMAIL_OPTIONAL`** from that env's `[vars]`, so a future Resend
   outage fails closed again instead of degrading quietly. The PR that added Resend left
   the opt-in in place; you remove it by hand once delivery is confirmed. Done for
   production in #160 — the only trace left in `osn/api/wrangler.toml` is a comment
   recording the removal.

The **Cloudflare Email Service** path stays available as a legacy fallback: onboard the
sender domain in Cloudflare Email Sending, mint an Email-Send-scoped token →
`CLOUDFLARE_EMAIL_API_TOKEN`, and note `CLOUDFLARE_ACCOUNT_ID`. It needs a paid Workers
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
`osn/api/src/index.ts:51-52`).

⚠️ In any non-local env (`OSN_ENV` set & `!= "local"`) **both secrets are required**. The
Worker **refuses to boot** (fail-closed 503) without them. It does not downgrade to
per-isolate in-memory limiters (`osn/api/src/index.ts:92-96`). Locally (`OSN_ENV`
unset/`local`) both are absent and the Worker uses in-memory fallbacks — no Upstash, no
external service needed.

Set **both** secrets:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

> ✅ **C-M18 resolved — Upstash region = `ap-southeast-2` (Sydney).** Create the
> Upstash database in **`ap-southeast-2`** — co-located with the D1 databases (all in
> `oc` / Sydney) and the Australian edge traffic for low RSVP/auth-write latency (the
> project is AU-centric). Provision the database in that region, mint a REST token, and
> set the two secrets above. See `[[compliance/subprocessors]]`.

### 1.5 OTel / Grafana endpoint

Observability ships via OpenTelemetry → Grafana Cloud. Provision the OTLP endpoint and
auth header per [[observability-setup]]. Then set `OTEL_EXPORTER_OTLP_ENDPOINT` and
`OTEL_EXPORTER_OTLP_HEADERS` (plus `DEPLOYMENT_ENVIRONMENT=production`) on osn-api and
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

The id is already substituted into `cire/api/wrangler.toml` (top-level binding and
`[env.production]`):

```toml
[[d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "6e835474-e0a7-4db9-8883-3247c3c891cd"
migrations_dir = "../db/migrations"
```

### 2.2 cire R2 buckets — ALREADY CREATED ✅

Both exist (bindings in `cire/api/wrangler.toml`):

| Binding | Bucket |
|---|---|
| `SHEETS` (spreadsheet import staging) | `cire-sheets` |
| `ASSETS` (invite-builder images) | `cire-assets` |

If you ever need to recreate them:

```bash
bunx wrangler r2 bucket create cire-sheets
bunx wrangler r2 bucket create cire-assets
```

The matching `cire-sheets-preview` / `cire-assets-preview` buckets and the
`preview_bucket_name` fields that named them went with the preview tier on
2026-07-27. `wrangler dev --remote` now has no remote bucket to bind; use the
local dev server, which fakes R2 on disk.

### 2.3 osn-api D1 databases — ALREADY CREATED ✅

osn-api **is** a Cloudflare Worker now (`main = "src/index.ts"`, `export default
{ fetch, scheduled }`). Its three D1 databases (one per remote env) already exist and
are wired into `osn/api/wrangler.toml` under each `[[env.<env>.d1_databases]]`:

| Env | `database_name` | `database_id` |
|---|---|---|
| top-level (local `wrangler dev` only) | `osn-db` | `a1dfceb8-2e7a-48eb-a161-ad428f3ddff5` |
| dev (deployed tier) | `osn-db-dev` | `1c1425e1-bb9f-4760-b090-763ccf61eb83` |
| staging (declared, unused) | `osn-db-staging` | `eb71428e-8540-4a30-815f-fb9cd4ae97ea` |
| production | `osn-db-prod` | `767a9ac1-129b-4efa-9fcf-f68ed7a48c38` |

> Before 2026-08-13 `[env.dev]` pointed at `osn-db` and carried localhost
> placeholder vars — it was the local devloop's config, not a tier. It is now a
> real deployed tier on `id.dev.musubi.social` with its own database, and
> `osn-db` is what plain `wrangler dev` still uses. [[dev-environment]]

All are in **`oc` (Sydney)** (co-located with cire-db + Upstash `ap-southeast-2`).
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
bunx wrangler secret put OSN_PAIRWISE_SALT          --env <dev|staging|production>
# OSN_TOTP_ENCRYPTION_KEY too — but set it through the `set-osn-api-secret` workflow,
# which checks the decoded length is exactly 32 bytes and refuses a blind overwrite:
bunx wrangler secret put OSN_TOTP_ENCRYPTION_KEY    --env <dev|staging|production>
bunx wrangler secret put UPSTASH_REDIS_REST_URL     --env <dev|staging|production>
bunx wrangler secret put UPSTASH_REDIS_REST_TOKEN   --env <dev|staging|production>
# Email — REQUIRED non-local UNLESS OSN_EMAIL_OPTIONAL is set (§1.1). RESEND_API_KEY
# is the live transport and is already set on production: verify cireweddings.com in
# Resend, set the key, confirm a send arrives, THEN remove any OSN_EMAIL_OPTIONAL:
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
| `OSN_PAIRWISE_SALT` | **Preferred: the `Set an osn-api Worker secret` GitHub workflow** (`.github/workflows/set-osn-api-secret.yml`, `workflow_dispatch`, `secret: OSN_PAIRWISE_SALT`, production environment) — idempotent, refuses to rotate, never prints the value. Manual `wrangler secret put` remains for non-prod envs. | **Yes** | ≥32 bytes or throws (`build-deps.ts`). HMAC key behind every OIDC pairwise `sub`. **Never rotate it** once clients hold tokens — every subject changes and every client sees its users as strangers. The workflow enforces this: it exits without touching an existing secret. [[oidc-provider]] |
| `OSN_TOTP_ENCRYPTION_KEY` | **Preferred: the `Set an osn-api Worker secret` GitHub workflow** (`.github/workflows/set-osn-api-secret.yml`, `secret: OSN_TOTP_ENCRYPTION_KEY`) — it validates the decoded length and will not overwrite an existing key unless `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS` is already staged. Manual `wrangler secret put` checks nothing. | **Yes** | Exactly 32 base64-encoded random bytes (`openssl rand -base64 32`) or the boot throws (`build-deps.ts`). AES-256-GCM key for every stored TOTP secret. **Keep your copy** — Cloudflare never hands it back, and a key nobody escrowed cannot be rotated, only replaced, which makes every enrolled user re-enrol. Missing ⇒ 503 on **every** route, not just TOTP. Rotate in the fixed order in §10. [[totp]] |
| `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS` | Same workflow, `secret: OSN_TOTP_ENCRYPTION_KEY_PREVIOUS` | Only while a rotation drains | The outgoing key, held in the second slot of the key ring so old ciphertext still decrypts. Set in §10.1, deleted in §10.4. Present-but-malformed fails the boot exactly as the current key does. [[totp]] |
| `OSN_AUTHORIZE_UI_URL` | `[env.<env>.vars]` | Optional, but **set it** | Absolute URL of the OIDC consent screen. Prod = **`https://musubi.social/authorize`** (`@musubi/social` on the `osn-social` Pages project, serving the musubi.social apex). Unset ⇒ `/authorize` on the **first** `OSN_ORIGIN` — which happens to be right under the current config, and would silently break the moment that list is reordered. Keep it explicit. [[oidc-provider]], [[authorize-ui]] |
| `OSN_RP_ID` | `[env.<env>.vars]` | **Yes** | WebAuthn RP ID — must be a **registrable domain**. Prod = **`musubi.social`** since 2026-07-27 (was `cireweddings.com`). The apex, not `id.musubi.social`, so a ceremony is legal on the apex identity app *and* on any future `*.musubi.social` surface. **The change invalidated every passkey enrolled under `cireweddings.com`** — a private key is bound to its RP ID inside the authenticator, so recovery-code login is the only way back in. [[musubi-identity-migration]] |
| `OSN_ORIGIN` | `[env.<env>.vars]` | **Yes** | Comma-sep accepted WebAuthn origins; prod **https** origins. Prod = **`https://musubi.social`** — the identity app, and the only origin same-site with the RP ID. The cire origins were **removed** on 2026-07-27; a ceremony from `host.`/`vendor.`/`invite.cireweddings.com` is now illegal no matter what this list says, so listing them would only mislead. |
| `OSN_ISSUER_URL` | `[env.<env>.vars]` | **Yes** | Public https base URL of osn-api → JWT `iss`; must match what cire verifies. Prod = **`https://id.musubi.social`** (custom-domain route in `wrangler.toml` `[env.production]`). |
| `OSN_CORS_ORIGIN` | `[env.<env>.vars]` | **Yes** | Comma-sep prod app origins. In a secure env an empty list **throws** at `assertCorsOriginsConfigured` (`lib/cors-config.ts`) — Origin/CSRF guard is mandatory. Prod = **`https://musubi.social,https://host.cireweddings.com,https://vendor.cireweddings.com,https://invite.cireweddings.com`**. **These are two different lists.** CORS governs **bearer-token** calls, which still work cross-site, so the cire origins stay. `OSN_ORIGIN` governs WebAuthn ceremonies, which do not. |
| `RESEND_API_KEY` | `wrangler secret put` | **Yes\* (live transport)** | Resend API key (bearer). **Set on production.** When set in non-local → `ResendEmailLive` (POST `https://api.resend.com/emails`); **wins over the Cloudflare creds and the opt-in**. Fail-closed at startup if no provider is set in non-local — **unless `OSN_EMAIL_OPTIONAL` is set** (then degraded no-op). §1.1 |
| `CLOUDFLARE_ACCOUNT_ID` | `wrangler secret put` | Optional / **legacy** | Cloudflare-email fallback transport (paid Workers plan). Used only if `RESEND_API_KEY` is absent. §1.1 |
| `CLOUDFLARE_EMAIL_API_TOKEN` | `wrangler secret put` | Optional / **legacy** | Cloudflare-email fallback bearer token. Same role as `CLOUDFLARE_ACCOUNT_ID`. §1.1 |
| `OSN_EMAIL_OPTIONAL` | `[env.<env>.vars]` | No (default off) | **Explicit degraded-email opt-in.** Truthy (`true`/`1`/`yes`/`on`) → boot with a **no-op email transport** (transactional mail DISCARDED, loud startup warning) when **no real provider** (`RESEND_API_KEY` / `CLOUDFLARE_*`) is set in a non-local env, instead of failing closed. **Set in no env today** — removed from prod `[vars]` in #160 once Resend delivery was confirmed, so production fails closed again. A real provider wins — the opt-in is ignored when `RESEND_API_KEY` (or the Cloudflare creds) is present. §1.1 |
| `OSN_EMAIL_FROM` | `[env.<env>.vars]` (or secret) | **Yes (prod)** | Verified sender address. Prod = **`hello@cireweddings.com`** (set in `wrangler.toml`). Resend-verified domain from §1.1. |
| `RESEND_API_URL` | **Never set** | **Must be absent** | Local emulation only ([[email#Local emulation]]). osn-api refuses to boot with it in any non-local tier (503 on every route), and the production deploy job refuses to run while it exists as a secret. |
| `UPSTASH_REDIS_REST_URL` | `wrangler secret put` | **Yes** | Upstash REST URL. Worker refuses to boot in non-local without it + the token (`index.ts:92-96`). §1.4 |
| `UPSTASH_REDIS_REST_TOKEN` | `wrangler secret put` | **Yes** | Upstash REST token. §1.4 (region `ap-southeast-2` / Sydney — C-M18 resolved) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `[env.<env>.vars]` | Recommended | Grafana OTLP gateway. Metric/trace **export is deferred on workerd** — the redacting logger is active, recording call-sites are no-ops until an exporter is attached. [[observability-setup]] |
| `OTEL_EXPORTER_OTLP_HEADERS` | `wrangler secret put` | Recommended | `Authorization=Basic <base64(instance:token)>`. [[observability-setup]] |
| `INTERNAL_SERVICE_SECRET` | `wrangler secret put` | **Conditional** | Bearer secret guarding `POST /graph/internal/register-service` (`routes/graph-internal.ts`). Needed **only** to register cire-api's ARC public key (§6.2). Endpoint returns 501 when unset. |
| `TURNSTILE_SECRET_KEY` | `wrangler secret put` | **Optional (key-optional)** | Cloudflare Turnstile secret. When set, `/register/begin` + `/login/passkey/begin` **require** a valid Turnstile token and **fail-closed** (reject on missing/invalid/duplicate; single-use enforced by Cloudflare). When unset, those gates are skipped and the flows behave as before — safe to leave unset until the widget exists. **Currently SET** on `osn-api-production` (#160), so the gates bite. Server half of the sitekey baked into the **musubi/social** build as `VITE_TURNSTILE_SITEKEY` (§3.3) — it was the organiser-portal build until the 2026-07-27 OIDC swap moved the ceremonies. Create the widget in §3.4. (`build-deps.ts` → `createTurnstileVerifier`). |
| `TRUSTED_PROXY_COUNT` | `[env.<env>.vars]` | Optional | On Workers, Cloudflare sets `cf-connecting-ip`, so this is usually unneeded. Set only if a proxy sits in front and XFF must be trusted N hops. |
| `OSN_RP_NAME` | `[env.<env>.vars]` | Optional | Display name in passkey prompts (default `OSN`). |
| `OSN_ACCESS_TOKEN_TTL` / `OSN_REFRESH_TOKEN_TTL` | `[env.<env>.vars]` | Optional | Defaults 300s / 2592000s. |
| `PULSE_API_URL` / `ZAP_API_URL` | `[env.<env>.vars]` | Optional | Outbound ARC key registration for account-erasure fan-out. |

### 3.1b Access-token issuer pinning (all downstream Workers)

Since 2026-08-30 every service that verifies an OSN access token pins the
`iss` claim, not just the signature and audience. A token minted by a
different OSN deployment verifies fine against its own JWKS; `iss` is the only
claim that says which deployment minted it.

That makes `OSN_ISSUER_URL` a **paired** value: the verifier's copy must equal
what osn-api mints, byte for byte, so **the two flip in the same deploy**. A
mismatch 401s every authenticated request, and the 401 is indistinguishable
from an expired token — there is nothing in the response to say the issuer is
wrong.

| Worker | Var | Required? | Prod value |
|---|---|---|---|
| osn-api | `OSN_ISSUER_URL` | **Yes** | `https://id.musubi.social` — the value every row below must match |
| cire-api | `OSN_ISSUER_URL` | **Yes — 503 without it** | `https://id.musubi.social` |
| pulse-api | `OSN_ISSUER_URL` | **Yes** | `https://id.musubi.social` (no deploy job yet) |
| zap-api | `OSN_ISSUER_URL` | **Yes** | `https://id.musubi.social` (prod D1 unprovisioned; deploy job skips) |

A trailing slash on either side is tolerated — the comparison normalises both
— but nothing else is. An **empty** value is rejected outright rather than
read as "no issuer check": a half-configured tier fails closed instead of
quietly accepting tokens from anywhere.

### 3.2 cire-api (Cloudflare Worker)

| Name | How to set | Required? | Notes |
|---|---|---|---|
| D1 `database_id` | `wrangler.toml` (top-level + `[env.production]`) | **Yes** | §2.1 — `6e835474-e0a7-4db9-8883-3247c3c891cd`, already set. |
| `WEB_ORIGIN` | `wrangler.toml` `[env.production.vars]` | **Yes** | Comma-sep allowlist; must include the guest, organiser **and** vendor origins. Each entry must be an exact origin (`new URL(o).origin === o`: no path, trailing slash or userinfo) over `https://`, or the Worker fails closed at the edge with a 503; `http://localhost` is accepted only when `OSN_ENV` is `local` (`cire/api/src/lib/web-origin.ts`). Prod = **`https://invite.cireweddings.com,https://host.cireweddings.com,https://vendor.cireweddings.com`**. |
| `OSN_JWKS_URL` | `wrangler.toml` `[env.production.vars]` | **Yes** | Deployed osn-api JWKS URL (`<OSN_ISSUER_URL>/.well-known/jwks.json`). Prod = **`https://id.musubi.social/.well-known/jwks.json`**. |
| `OSN_ISSUER_URL` | `wrangler.toml` `[env.production.vars]` | **Yes — Worker answers 503 without it** | Deployed osn-api origin; must equal osn-api's own `OSN_ISSUER_URL`, since it is the `iss` claim cire checks. Since 2026-08-30 it is on the edge required-vars list (`cire/api/src/index.ts`), so an unset value takes the Worker down rather than falling back to the localhost default and 401ing every request with nothing to say why. Prod = **`https://id.musubi.social`**. |
| `OSN_AUDIENCE` | `wrangler.toml` `[env.production.vars]` | **Yes** | `osn-access` (the user access-token audience). |
| `CIRE_API_ARC_PRIVATE_KEY` | `wrangler secret put CIRE_API_ARC_PRIVATE_KEY` | **Conditional** | ES256 JWK (string). Only if guest account-linking is enabled (§6.2). Absent ⇒ linking `POST` answers 503 (`src/index.ts:78-85`, `services/osn-bridge.ts:99-113`). |
| `CIRE_API_ARC_KEY_ID` | `wrangler secret put CIRE_API_ARC_KEY_ID` | **Conditional** | `kid` matching the public key registered in osn-api `service_accounts` for serviceId `cire-api`. §6.2 |
| `OSN_API_URL` | `wrangler secret put OSN_API_URL` (or var) | **Conditional** | osn-api base URL the ARC bridge calls. §6.2 |
| `CIRE_API_ORIGIN` | `wrangler.toml` `[env.production.vars]` | **Yes** | This Worker's own public origin. It builds the OIDC redirect URI (`<origin>/api/auth/oidc/callback`), which must match one of the client's registered `redirect_uris` **byte for byte**. Prod = **`https://api.cireweddings.com`**. |
| `CIRE_OIDC_CLIENT_ID` | `wrangler.toml` `[env.production.vars]` | **Yes** | **`cid_cire`** — the registered client. Not a secret. |
| `CIRE_OIDC_CLIENT_SECRET` | `wrangler secret put CIRE_OIDC_CLIENT_SECRET --env production` | **Yes** | The client secret, presented as `client_secret_post` at the token endpoint. Must be the pre-image of `oauth_clients.client_secret_hash` in osn's D1 — **rotate both together or organiser sign-in dies at the exchange** (§3.5). Any of the four OIDC values absent ⇒ `/api/auth/oidc/*` answers **503 `sign_in_unavailable`** and nothing else changes (`src/index.ts:291-308`). |
| `CIRE_OPS_EMAIL` | `wrangler secret put CIRE_OPS_EMAIL --env production` | **Optional** | The operator address for the daily "vendor claims are waiting for review" email. A secret because the repo is public. Needs `RESEND_API_KEY` on this Worker too; with either unset no email is sent and the cron's log line is the only signal (`src/index.ts` `scheduled`). [[cire-vendors]] |
| `CIRE_R2_RECONCILE_DISABLED` | `wrangler.toml` `[env.production.vars]` (and every other tier's vars block) | **Yes — `"false"`** | Stop flag for the cron's two R2 orphan reconcilers. Any value but `"false"` leaves both out of `scheduled` and logs `r2 reconcile disabled by CIRE_R2_RECONCILE_DISABLED` each run; every other cron job still runs. Set `"true"` before restoring `cire-db` ([[backup-dr]]). A dashboard edit takes effect at once, but the next deploy writes the file's value back. Never a secret: it is a declared var. `tests/services/r2-reconcile.test.ts` fails unless every tier holds the string `"false"`. |
| `RESEND_API_URL` | **Never set** | **Must be absent** | Local emulation only ([[email#Local emulation]]). In a deployed tier cire-api refuses it: no mail is sent, and `email disabled: Resend misconfigured` is logged. The production deploy job refuses to run while it exists as a secret. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` | `wrangler secret put` | Recommended | Worker observability. [[observability-setup]] |
| `TURNSTILE_SECRET_KEY` | `wrangler secret put TURNSTILE_SECRET_KEY` | **Optional (key-optional)** | Cloudflare Turnstile secret. When set, the guest **`/api/claim`** + **`/api/rsvp`** endpoints require a valid Turnstile token and **fail-closed** (403 on missing/invalid/duplicate). Unset ⇒ those gates are skipped (guest flow unchanged). Same widget/secret as osn-api — the widget's domains must cover every gated origin. **Currently unset** on `cire-api-production`: a mismatched secret rejected every guest claim on 2026-07-20 and was deleted, which reverts the gate to a no-op. Create the widget in §3.4. (`src/index.ts` → `createTurnstileVerifier`). |
| `GOOGLE_GEOCODING_API_KEY` | `wrangler secret put GOOGLE_GEOCODING_API_KEY` | **Optional (key-optional, fail-soft)** | Google Geocoding API key for the organiser per-event venue lookup (`POST /api/organiser/weddings/:id/settings/geocode`, driven from the Events tab's location editor). Unset ⇒ the endpoint answers `unavailable` and the editor falls back to manual lat/lng entry — nothing is ever sent to Google. **Before setting in prod: sign the Google Cloud DPA + confirm the EU→US transfer basis** (see `[[compliance/subprocessors]]`), restrict the key to the Geocoding API, **and set a daily quota cap** in the Google console — the per-IP edge limiter bounds each caller, but only a Google-side cap bounds aggregate spend across many IPs/accounts (S-L2). (`src/index.ts` → `createGoogleGeocoder`.) |

> ⚠️ **cire `wrangler.toml` env nuance:** always pass `--env production`. A bare
> `wrangler deploy` targets the **top-level** config — the local devloop's — not
> production.
>
> This was more dangerous before 2026-08-13, when `[env.production]` declared no
> D1 or R2 of its own and silently *looked* correct because the top-level bindings
> happened to name the prod resources. Named envs inherit **nothing**, so
> `[env.production]` now declares its own `d1_databases`, `r2_buckets`, `images`,
> `routes` and `triggers`, as does `[env.dev]`. Same rule caught the missing prod
> cron: `[triggers]` at the top level had never applied to the deployed Worker.

### 3.3 cire/invites (Worker SSR) + cire/host, cire/vendor (Pages — build-time `PUBLIC_*`)

> [!important] cire/invites is now an **SSR Cloudflare Worker**, not Pages
> `cire/invites` switched to `output: "server"` (the `@astrojs/cloudflare` adapter)
> and is deployed as a **Cloudflare Worker with Static Assets** via
> `wrangler deploy --config dist/server/wrangler.json` (the `deploy-cire-invites` job
> in `deploy.yml`). The committed `cire/invites/wrangler.jsonc` carries the worker
> name (`cire-invites`) + the **`invite.cireweddings.com` custom-domain route**, and the
> adapter merges in `main`/the ASSETS binding. The old
> `wrangler pages deploy dist --project-name cire` is gone — **the Cloudflare
> Pages project `cire` serves nothing; the apex belongs to the `cire-landing` Pages
> project since the 2026-07-16 reshuffle.** The invite route resolves the
> wedding **from the path** (`/<slug>`) at request time and the bare domain (`/`)
> 302-redirects **off-origin to the marketing site** (`PUBLIC_MARKETING_URL`,
> default + prod value `https://cireweddings.com`), so there is **no
> `PUBLIC_WEDDING_SLUG`**. (Until 2026-08-02 `/` instead redirected to whichever
> wedding was most-recently-created, via a since-deleted `GET /api/primary-wedding`
> — a single-tenant leftover that served one arbitrary couple's invite to every
> bare-domain visitor.) No KV/Images binding is required on this Worker (Astro
> sessions pinned to an in-memory driver; image transforms stay in cire-api).
> **One-time Cloudflare setup (DONE):** the apex first moved from the Pages project to
> the `cire-invites` Worker (2026-06-19), then the reshuffle (2026-07-16) moved the Worker
> onto `invite.cireweddings.com` and handed the apex to `cire-landing`.
> `custom_domain: true` auto-provisions a route on `wrangler deploy`; a Pages→Worker move
> needs the hostname detached from the old Pages project first (Pages → project → Custom
> domains) or moved on the Worker side (Worker → Domains & Routes → Add → confirm move).
> No KV namespace or Images binding to create.
>
> **`legacy_env` strip (deploy foot-gun, fixed 2026-07-16):** the adapter writes a
> top-level `"legacy_env": true` into the generated `dist/server/wrangler.json`.
> Wrangler **4.111.0 removed** that field and hard-errors on it; since `cire/invites`
> pins no wrangler, `bunx wrangler` pulls the latest, so the `deploy-cire-invites` job
> failed on every merge from the moment 4.111 shipped (the guest site stayed up on the
> last-good build — deploys stopped landing). The job now deletes `legacy_env`
> from the generated config between build and deploy (behaviour-neutral: `true` was
> already the default). If a guest-site deploy fails on a config field again, check
> the generated `dist/server/wrangler.json` against the installed wrangler's schema.

`cire/host` and `cire/vendor` are **static** Pages builds (`output: "static"`); cire/invites's
`PUBLIC_*` are read both **server-side per request** and by the client islands but
still bake in **at build time**. The prod values are wired in
`.github/workflows/deploy.yml` (the `deploy-cire-invites` / `deploy-cire-host` jobs set
them on the build step); a localhost fallback stays in the source for local dev. If you
build outside CI, export these before `bun run --cwd <site> build`.

| Name | Site | Required? | Prod value | Notes |
|---|---|---|---|---|
| `PUBLIC_API_URL` | cire/invites | **Yes** | `https://api.cireweddings.com` | cire-api prod origin, read server-side (`[slug].astro` / `index.astro` via `src/lib/invite.ts`) **and** by the islands (dev default `http://localhost:8787`). |
| `PUBLIC_SITE_URL` | cire/invites | Recommended | `https://invite.cireweddings.com` | Guest site canonical URL. The apex serves the marketing landing site since the 2026-07-16 reshuffle. |
| `PUBLIC_GOOGLE_MAPS_EMBED_KEY` | cire/invites | Optional | _(unset)_ | Google Maps Platform key with the **Maps Embed API** enabled. When set, the event "Where" section renders a real Maps Embed iframe (queried by the free-text venue address — no coordinates, no geocoding); when unset/blank it falls back to the CSS-drawn map card, so it is a pure enhancement (`cire/invites/src/components/MapPreview.tsx`). **Human step:** create the key, **enable only the Maps Embed API**, and **restrict it by HTTP referrer** to the guest-site origin(s) — the key bakes into static HTML, and a referrer-restricted Embed-only key is safe to ship. |
| `PUBLIC_CIRE_API_URL` | cire/host | **Yes** | `https://api.cireweddings.com` | cire-api prod origin (`cire/host/src/lib/osn.ts`; `PUBLIC_API_URL` honoured as legacy fallback). |
| `PUBLIC_OSN_ACCOUNT_URL` | cire/host **and** cire/vendor | Recommended | `https://musubi.social` | Where "Manage your account" links point — passkeys, recovery codes and connected apps all live on musubi's own origin now. **Replaced `PUBLIC_OSN_ISSUER_URL` on 2026-07-27**: the frontends no longer talk to the issuer at all. Sign-in is a top-level redirect to cire-api (`/api/auth/oidc/start`), which runs the code exchange server-side. [[cire-auth]], [[oidc-provider]] |
| `PUBLIC_CIRE_WEB_URL` | cire/host | Recommended | `https://invite.cireweddings.com` | Guest site URL used in organiser preview links (`osn.ts`). |
| `VITE_OSN_ISSUER_URL` | musubi/social | **Yes** | `https://id.musubi.social` | osn-api prod origin for the identity app **and** the `/authorize` consent screen (`musubi/social/src/lib/auth.ts`, dev default `http://localhost:4000`). A Vite SPA, so this bakes into the bundle: unset, the deployed app dials the visitor's own localhost. Set in `deploy.yml` (`deploy-osn-social`). Since 2026-08-13 a second job, `deploy-osn-social-dev`, builds the same app with `https://id.dev.musubi.social` for `dev.musubi.social` — change one and change the other, or dev silently dials prod identity. [[dev-environment]] |
| `PUBLIC_TURNSTILE_SITEKEY` | cire/invites **and** cire/host **and** cire/vendor | Optional (key-optional) | `${{ vars.PUBLIC_TURNSTILE_SITEKEY }}` | Cloudflare Turnstile **sitekey** (public — safe to embed in client HTML). When set, the guest claim form (cire/invites) renders the Turnstile challenge and gates submit on it; when unset/blank no widget renders and no token is sent. Wired in the `deploy-cire-invites` / `deploy-cire-host` / `deploy-cire-vendor` build steps, and the repo **Variable** is set (#160). Genuinely optional **here**, because the matching `TURNSTILE_SECRET_KEY` is **unset on cire-api** today (§3.2). Since the 2026-07-27 OIDC swap the organiser/vendor builds no longer render an OSN ceremony form, so their copy of this var is now inert. |
| `VITE_TURNSTILE_SITEKEY` | musubi/social | **Yes — see note** | `${{ vars.PUBLIC_TURNSTILE_SITEKEY }}` | Same widget, same repo Variable; the name differs only because Vite exposes `VITE_*` where Astro exposes `PUBLIC_*`. Feeds `turnstileSiteKey` into `SignIn` + `Register` (`@shared/ui`) at all three call sites — the sidebar dialogs and the `/authorize` sign-in island — via `musubi/social/src/lib/auth.ts`, which normalises blank to `undefined`. **Key-optional in code but required in production:** osn-api's `TURNSTILE_SECRET_KEY` is set, so a blank sitekey fails every gated call closed with `400 turnstile_failed`. Set in `deploy.yml` (`deploy-osn-social`), and again in `deploy-osn-social-dev` since 2026-08-13 — so `dev.musubi.social` needs its own widget **Domains** entry alongside `musubi.social`, or dev sign-in fails closed the same way. [[turnstile]] [[dev-environment]] |

### 3.4 Create the Cloudflare Turnstile widget (one-time, gates Turnstile on) 🔑

Turnstile is **key-optional** — every flow ships and works with NO widget. Do this
step only when you want bot protection ON. The same widget (one sitekey + one secret)
covers **both** the guest site and the organiser portal.

The `wrangler` OAuth token in use (`chavaniket@duck.com`) lacks the `Account.Turnstile:Edit`
scope, so the widget **could not be created programmatically** during this work —
create it in the dashboard (or with a custom API token that has the scope).

> ⚠️ **Order matters (fail-closed).** Ship the **sitekey** in the Pages build first
> (step 3). Set the **secret on the Workers** second (step 4). If you ship the sitekey while
> the secret is absent, the widget renders and the server skips verify — harmless. If you
> set the secret while the sitekey is absent, the server requires a token the UI never
> sends, and legitimate requests 400/403. A coordinated deploy of both at once is also
> safe.

1. **Dashboard → Turnstile → Add widget** (account `fad09b83d3590eaeb803eca52d5bf1b7`).
   - **Name:** `cire-weddings`
   - **Domains:** `invite.cireweddings.com` (guest claim + RSVP),
     `host.cireweddings.com`, `vendor.cireweddings.com`, and — since the 2026-07-27
     identity move — **`musubi.social`** (the register/login forms, which is where the
     osn-api gates now fire) plus **`id.musubi.social`**. Add `localhost` if you want to
     exercise it locally. A hostname missing from this list fires `error-callback`
     (`110200`) and the gated form's submit never enables. [[turnstile]]
     A widget whose domains miss a gated origin rejects every request from it.
   - **Widget mode:** **Managed** (no pre-clearance — siteverify is the gate).
2. Copy the **Sitekey** (public, `0x…`) and the **Secret key** (private).
3. **Sitekey** → set as the repo **Variable** `PUBLIC_TURNSTILE_SITEKEY`. The
   `deploy-cire-invites`, `deploy-cire-host` and `deploy-cire-vendor` (and their `-dev` twins) build steps
   already read it. Astro bakes the sitekey in at build time, so **rebuild and redeploy**
   the three sites to activate the widget. (Done — the Variable is set; the frontends
   render a widget today.)
4. **Secret key** → set on **both** Workers (never commit it):
   ```bash
   # from osn/api (gates /register/begin + /login/passkey/begin)
   cd osn/api && echo "<secret>" | bunx wrangler secret put TURNSTILE_SECRET_KEY --env production
   # from cire/api (gates /api/claim + /api/rsvp)
   cd cire/api && echo "<secret>" | bunx wrangler secret put TURNSTILE_SECRET_KEY --env production
   ```
   Then `wrangler deploy` both Workers so the new isolate picks up the secret.
   **Confirm the secret and the shipped sitekey are the two halves of the same widget**
   and run one real end-to-end claim — a mismatch rejects every guest claim (2026-07-20
   incident, see [[free-tier-limits]]). To back it out:
   `bunx wrangler secret delete TURNSTILE_SECRET_KEY --env production`, which returns the
   gate to a no-op within a couple of minutes and needs no redeploy.

### 3.5 Register cire as an OIDC client (one-time, done 2026-07-27) 🔑

Organiser, vendor and guest-linking sign-in all run through the OSN OIDC redirect
(see [[cire-auth]]). That needs a row in osn's `oauth_clients`. `is_first_party` is
not a self-serve registration input, so this row is **seeded by hand** — the
self-serve `POST /oidc/clients` route can only mint third-party clients.

Generate the secret, hash it, seed the row, then set the secret on cire-api:

```bash
# 1. Mint a secret and its SHA-256. Keep the raw value out of shell history and
#    out of any file inside the repo.
SECRET=$(openssl rand -base64 32)
HASH=$(printf '%s' "$SECRET" | openssl dgst -sha256 -binary | xxd -p -c 64)

# 2. Seed the client row in osn's PRODUCTION D1 (write the SQL to a file outside
#    the repo; never inline the hash into a shared transcript).
cd osn/api && bunx wrangler d1 execute osn-db-prod --remote --env production \
  --file=/path/outside/repo/register-cire-client.sql

# 3. Set the secret on the cire-api production Worker.
cd cire/api
printf '%s' "$SECRET" | bunx wrangler secret put CIRE_OIDC_CLIENT_SECRET --env production
```

The row's shape — the columns that carry a trust decision are listed in
[[oidc-provider]] → "Registered clients":

| Column | Value |
|---|---|
| `id` / `client_id` | `oc_cire` / `cid_cire` (matches `CIRE_OIDC_CLIENT_ID`) |
| `redirect_uris` | JSON array: `https://api.cireweddings.com/api/auth/oidc/callback`. The seeded row also carries `https://api-preview.cireweddings.com/api/auth/oidc/callback`, which died with the preview tier on 2026-07-27 — a registered URI pointing at a hostname nobody serves. Prune it on the next authorised prod-D1 write |
| `sector_identifier` | `cireweddings.com` |
| `allowed_scopes` | `openid profile email` |
| `is_first_party` | `1` — this is what puts the `osn_profile_id` claim in the ID token, which cire **requires** |
| `owner_account_id` | `NULL` — a platform client, so no account erasure can disable it |

> ⚠️ **The secret and the hash are one credential in two places.** Rotating
> `CIRE_OIDC_CLIENT_SECRET` without updating `oauth_clients.client_secret_hash` (or the
> reverse) makes every token exchange fail `invalid_client`, and organiser sign-in stops
> dead — existing sessions survive their 7 days, so the break shows up gradually. Rotate
> both, then redeploy cire-api to cycle the warm isolates. A rotation also voids the
> one-click stop links in RSVP digest emails already sent ([[cire-rsvp-changes]]);
> the Overview switch keeps working.

**Local development** needs its own row in the **local** D1 with a
`http://localhost:8787/api/auth/oidc/callback` redirect URI, and the secret in
`cire/api/.dev.vars`. Without them `/api/auth/oidc/*` answers 503 and the portal shows
"sign-in unavailable" — which is the correct inert state, not a bug.

---

### 3.8 Stripe — gift contributions via Connect (cire-api)

The registry's card contributions. **Both this and §3.9 are needed**, and they are two different Stripe relationships with two different endpoints and two different signing secrets — the step-by-step for creating either, running them locally and verifying a tier is in `wiki/cire/stripe-webhooks.md` ([[stripe-webhooks]]), which is the page to work from. What belongs on this checklist:

**One-time, in the Stripe dashboard:**

1. Enable **Connect** on the platform account and complete the platform profile, or Stripe will not mint the Express accounts `POST …/registry/stripe/session` asks for.
2. Add a webhook endpoint at `https://api.cireweddings.com/api/stripe/webhook`, scoped to **connected accounts**, subscribed to the nine events [[stripe-webhooks]] lists (`account.updated`, `account.application.deauthorized`, and the seven gift events). An account-scoped endpoint here hears nothing a couple's account does.

**Then:**

```bash
cd cire/api
bunx wrangler secret put STRIPE_SECRET_KEY --env production      # shared with §3.9
bunx wrangler secret put STRIPE_WEBHOOK_SECRET --env production  # THIS endpoint's
```

`STRIPE_ACCOUNT_COUNTRY` is an ordinary var (default `AU` in code), in `wrangler.toml` under each tier's own `[env.<env>.vars]`. Stripe fixes an account's country at creation, so it is a per-deployment default rather than something a couple can change later.

**Fail-closed.** `STRIPE_SECRET_KEY` unset ⇒ neither the Connect routes nor the upgrade routes are mounted, so a deployment with no Stripe account has no payment surface rather than one that 500s. `STRIPE_WEBHOOK_SECRET` unset ⇒ `/api/stripe/webhook` does not exist, and a gift is written `pending` and never settles.

---

### 3.9 Stripe — self-serve upgrades (cire-api)

Separate from the Connect integration in §3.8, and the two must not be confused: gifts are DIRECT charges on a couple's connected account (they are the merchant), while an upgrade is a PLATFORM charge where **cire is the merchant of record**. Two Stripe endpoints, two signing secrets. See [[cire-upgrades]] for the system and [[stripe-webhooks]] for the dashboard steps, the local forwarders and the per-tier verification.

**One-time, in the Stripe dashboard:**

1. Create one product per paid plan tier — **Gold** and **Crimson** — each with a one-off **Price**, plus a **second Price on Crimson** for a wedding upgrading from Gold. Use **test-mode** Prices for the dev tier and **live-mode** ones for production: a test id in production fails at checkout.
2. Add a **second webhook endpoint** pointed at `https://api.cireweddings.com/api/stripe/platform-webhook`, scoped to the **platform account** (not Connect), subscribed to `checkout.session.completed`, `checkout.session.expired` and `checkout.session.async_payment_failed`. Copy its signing secret — it is **not** the same as the Connect endpoint's.

**Then:**

```bash
# From cire/api/. The Price ids are ordinary vars, not secrets — put them in
# wrangler.toml under [env.<env>.vars]; named envs inherit no vars, so each
# tier declares its own.
#   STRIPE_UPGRADE_PRICE_GOLD              = "price_..."
#   STRIPE_UPGRADE_PRICE_CRIMSON           = "price_..."
#   STRIPE_UPGRADE_PRICE_CRIMSON_FROM_GOLD = "price_..."

bunx wrangler secret put STRIPE_PLATFORM_WEBHOOK_SECRET --env production
```

> [!warning]
> Reusing the Connect endpoint's signing secret for the platform endpoint means **every** delivery to it is refused with a 400 and Stripe retries for days, while nothing grants. The two secrets come from two different dashboard endpoints.

**Fail-closed, per move.** A tier with no configured Price for the wedding's current tier is not for sale: absent from the catalogue and a 404 from checkout. With `STRIPE_UPGRADE_PRICE_CRIMSON_FROM_GOLD` unset a Gold wedding is not offered Crimson at all. Absent configuration never means free. The three vars sit commented out in every environment of `cire/api/wrangler.toml` until the Prices exist. With `STRIPE_PLATFORM_WEBHOOK_SECRET` unset the endpoint does not exist at all, so a purchase could be paid and never granted — nothing else moves a purchase off `pending`.

**Smoke check after deploy:** as the owner of an Ivory wedding, open a locked module's nav row → **Upgrade to Gold** → pay with a Stripe test card → confirm you land back in the portal told the wedding is on Gold, with the Gold modules open, and that the wedding's row reads `tier = 'gold'`, `tier_source = 'purchase'`. The full version — the mounted-vs-404 curl, the `wrangler tail`, and the three D1 queries that prove the webhook granted it rather than the browser — is in [[stripe-webhooks]] §Verify a deployed tier.

**Do dev first.** Both endpoints exist per tier and per mode; a sandbox secret will not verify a live delivery. Prove the flow on `api.dev.cireweddings.com` with test-mode Prices before creating anything in live mode.

---

## 4. Database migrations

### 4.1 Apply cire D1 migrations (remote)

Migrations live in `cire/db/migrations/`: one baseline file,
`0001_initial.sql`, holding the whole schema, plus anything numbered `0082` and
up. The baseline builds exactly what migrations `0001`–`0081` in
`cire/db/migrations-archive/` build; nothing applies the archive. Production
applied that chain file by file, so its `d1_migrations` ledger holds every
archived name, `0001_initial.sql` among them, and wrangler skips the baseline
there.

That skip is only right once production has applied **every** archived
migration. `bun run --cwd cire/db db:migrate:prod` runs
`scripts/cire-db-migrate.ts`, which reads production's ledger first and refuses
— before any migration runs or the Worker deploys — when an archived migration
of the chain it started is missing, or when it names a migration from outside
that chain. The refusal names the files. The script runs the wrangler
`cire/api` installs from the lockfile and gives up on a ledger read after two
minutes, so a stalled call fails the job instead of holding the production
concurrency group.

> [!warning] Bring production level with a deploy run, never by hand
> Approve the `deploy.yml` run of a commit from before those files were
> archived and let its "Deploy cire/api — production" job finish: it applies
> them and deploys the Worker that matches. Then re-run the refused job. Do
> not run `db:migrate:prod` from an old checkout instead — that applies the
> migrations under the Worker already serving, and a migration such as `0076`
> drops a column that Worker still reads. Approve the old run before re-running
> the new one: both wait in the `deploy-production-cire-api` concurrency group,
> and a newer pending job cancels an older one.

The `database_id` is already wired
(`6e835474-e0a7-4db9-8883-3247c3c891cd`, §2.1). **CI applies them** — the
`deploy-cire-api` job runs `bun run --cwd cire/db db:migrate:prod` before the
new Worker serves, so the command below is the manual equivalent.

> Production holds no `wed_bootstrap` demo wedding: archived migration
> `0015_drop_bootstrap_wedding.sql` deleted it and its children, and the
> baseline never creates it.

```bash
# from the repo root
bun run --cwd cire/db db:migrate:prod
```

> Never apply cire migrations with a bare `wrangler d1 migrations apply`. It
> skips the ledger check, so on a production database that is behind it reports
> "No migrations to apply!" and leaves the missing schema missing.

> `--env production` is not optional. Without it wrangler resolves `cire-db`
> against the top-level config, which is the local devloop's binding set. The
> `db:migrate:local|dev|prod` scripts each name their database **and** their
> env, and the wrapper refuses a call that names neither `--local` nor
> `--remote`. See `cire/db/README.md`.

> ✅ **No bootstrap-owner step.** cire-api needs **no** `BOOTSTRAP_OWNER_PROFILE_ID`
> and no seeded owner. **Every authenticated OSN user is a first-class
> organiser**: they sign in with their OSN passkey, see their own weddings (an
> empty list for a new account — never a 503), and create new ones via
> `POST /api/organiser/weddings`. Per-wedding access is scoped entirely by
> `weddingOwner()` / `weddingMember()` on the `/api/organiser/weddings/:weddingId/*`
> routes; there is no global boot gate. (Removed in `feat/cire-organiser-open-access`.)

### 4.3 Apply osn-api D1 migrations (remote)

osn-api's migrations live in `osn/db/drizzle/` (`0000_optimal_thunderbolt.sql` and
`0001_exotic_lady_vermin.sql` at the time of writing) and are wired into every
`[[env.<env>.d1_databases]]` via `migrations_dir = "../db/drizzle"`. Apply per env
(against the binding name in `osn/api/wrangler.toml`).

> ✅ **Prod migrations are automatic.** Since 2026-07-16 the `deploy-osn-api` job in
> `deploy.yml` runs `wrangler d1 migrations apply osn-db-prod --remote --env production`
> before it deploys the Worker, so `0001_exotic_lady_vermin.sql` (the `users_handle_idx`
> B-tree index on `users.handle` behind co-host handle prefix search) and everything after
> it land on merge. The commands below stay the manual reference and the only route for
> **dev and staging**, which no CI job touches.

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

The local equivalent (`bun run --cwd osn/db db:migrate:local`, miniflare) applies all
`0000`→latest cleanly after the `0002_add_user_handle` data-copy fix.

---

## 5. Deploy steps (CI + manual reference)

> The cire Worker + Pages sites deploy via `.github/workflows/deploy.yml` (PR #128).
> The commands below are the manual equivalents — they document what the pipeline runs.

> **Two tiers since 2026-08-13.** A merge to `main` no longer deploys production on its
> own. Each surface now has a **dev** job that runs unattended, and a **production** job
> that `needs:` its dev twin and sits behind the protected `production` GitHub
> Environment — the run pauses there until a human approves. Everything in §5.1–§5.3
> below still describes what the production jobs do; the dev tier, its hosts and its
> one-time setup live in [[dev-environment]].

### 5.0 Reading a red deploy run (triage before you conclude anything is stale)

A red **Deploy** run does not mean the merge did not ship, and a green one is not
per-surface proof either. `deploy.yml` fans out to one dev job and one production job
per surface, all `needs: build`, and since 2026-08-13 each pair is **path-filtered** by
the `changes` job: a surface whose files the push did not touch is skipped, not
redeployed. The filter fails open — if the base commit cannot be diffed, every surface
is treated as changed. So work out what is actually stale before acting on it:

1. **Find the last SUCCESSFUL run of the specific job**, not the last green run.
   `Deploy cire/invites — production` failing on the merge that changed `cire/invites` is a
   real problem, and **the next merge will not rescue it** — under path filtering, a later
   push that touches only `cire/landing` skips the invites job entirely. Before 2026-08-13
   every merge redeployed every surface and a failure self-healed on the next one; that is
   no longer true. Re-run the job.
2. **A skipped job is not a failure.** A grey `Skipped` on a surface the push did not
   touch is the filter working. Confirm with
   `git diff --name-only <last-good-sha> <sha> -- <package> <each package it bundles>`;
   empty means there was nothing to ship. A cire surface also redeploys when a
   `@cire/*` package it bundles changes — `cire/host` on `cire/ui` or
   `cire/dietary`, for instance — so the paths to diff are the ones its `emit` line
   in the `changes` job names, not only its own directory.
3. **A production job stuck on `Waiting` is the approval gate**, not a hang — its dev
   twin has already deployed and the run is waiting on a reviewer. See §5.5.
4. **`Set up job` failing with `Failed to resolve action download info` is GitHub
   infrastructure**, not this repo — the runner could not download the actions at all,
   so nothing in the job ever ran. Re-run the failed jobs; there is nothing to fix
   here. (Seen 2026-08-06, taking out four jobs across two consecutive runs.)

The gap worth knowing about: **nothing retries automatically, and nothing alerts.** A
surface whose job fails stays stale behind a red X on an old run until someone re-runs
it. Path filtering makes this sharper than it was: later merges no longer carry an
earlier failure over the line.

Which job owns which surface:

| Production job | Dev twin | Surface | Live at |
|---|---|---|---|
| `Deploy cire/invites — production` | `— dev` | guest invite site | `invite.cireweddings.com` |
| `Deploy cire/host — production` | `— dev` | host portal | `host.cireweddings.com` |
| `Deploy cire/vendor — production` | `— dev` | vendor portal | `vendor.cireweddings.com` |
| `Deploy cire/landing — production (apex)` | `— dev` | marketing site | `cireweddings.com` |
| `Deploy cire/api — production` | `— dev` | cire backend | `api.cireweddings.com` |
| `Deploy osn/api — production` | `— dev` | identity API | `id.musubi.social` |
| `Deploy musubi/social — production` | `— dev` | identity app | `musubi.social` |
| `Deploy zap/api — production` | **none** | messaging backend | (no public route yet) |

`zap/api` has no dev tier — out of scope for the 2026-08-13 split — so it deploys
straight to production once approved.

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
**`https://id.musubi.social`** via the custom-domain route in `osn/api/wrangler.toml`
`[env.production]` (`routes = [{ pattern = "id.musubi.social", custom_domain = true }]`).
`custom_domain = true` auto-provisions the DNS record + edge cert on first
`wrangler deploy --env production` because the `musubi.social` zone is in-account — confirm it
went green afterwards (§5.4). The zone carries a **proxied wildcard record**, which does
not get in the way: a wildcard only answers names with no record of their own, so the
explicit `id` record wins. Prod `OSN_ISSUER_URL` is set to that URL. (dev / staging stay on
their current `workers.dev` config; if/when they get hostnames, set their `OSN_ISSUER_URL`
to the served URL.)

> ⚠️ **The RP ID moved to `musubi.social` on 2026-07-27, and that killed every existing
> passkey.** A private key is bound to its RP ID inside the authenticator, so credentials
> enrolled under `cireweddings.com` can never be asserted again — the `passkeys` table only
> holds the public halves. The one passkey surface now is the identity app on the
> **`musubi.social` apex** (`OSN_ORIGIN`); the apex is the RP ID so it also covers any future
> `*.musubi.social` origin. The cireweddings.com portals **cannot run a ceremony at all**.
> Recovery-code login is the only way back into an account, and re-enrolment runs
> recovery → OTP step-up (`purpose: passkey_register`) → enroll → `POST /recovery/generate`.
> [[musubi-identity-migration]], [[recovery-codes]]

> ℹ️ **cire-api must point at the deployed osn-api URL.** cire-api's `OSN_JWKS_URL` =
> `https://id.musubi.social/.well-known/jwks.json` and `OSN_ISSUER_URL` =
> `https://id.musubi.social` (§3.2). Both must equal osn-api's own `OSN_ISSUER_URL`, or
> token verification fails **and** the OIDC code exchange dials the wrong host. The cire
> *frontends* no longer carry an issuer URL at all since the 2026-07-27 swap — sign-in is a
> redirect to cire-api, which holds the client credential (§3.5).

### 5.2 cire-api (Worker)

Set any conditional secrets first (`wrangler secret put …`, §6.2). Then deploy:

```bash
cd cire/api
bunx wrangler types          # regenerate binding types if bindings changed
bunx wrangler deploy --env production
```

Confirm the deploy picked up the prod vars from `[env.production.vars]` and the
top-level D1/R2 bindings (§3.2 nuance).

> [!warning]
> **Rolling cire-api back past soft delete un-deletes weddings.** Migration
> `0077` adds `weddings.deleted_at`; a Worker built before it keeps the column
> but ignores it, so every soft-deleted wedding becomes visible again to its
> guests, co-hosts and vendors, and nothing purges it. Before rolling back past
> that release, restore or purge every row with `deleted_at IS NOT NULL`
> (`bunx wrangler d1 execute cire-db --env production --remote --command
> "SELECT id, deleted_at FROM weddings WHERE deleted_at IS NOT NULL"` lists
> them), or do not roll back. See [[cire-auth#Soft-deleted weddings]].

### 5.3 cire/invites (guest SSR Worker) + cire/host, cire/vendor, cire/landing (Pages)

CI builds each site with the prod `PUBLIC_*` vars (§3.3) baked in, then publishes. The
guest site is a **Worker**, not Pages — `deploy-cire-invites` deploys `cire-invites` from the
adapter-generated config; the other three are Pages projects (`cire-organiser`,
`cire-vendor`, `cire-landing` — create each once before its first run). Manual
equivalents:

```bash
# guest site (Worker: cire-invites, custom domain invite.cireweddings.com)
PUBLIC_API_URL=https://api.cireweddings.com \
PUBLIC_SITE_URL=https://invite.cireweddings.com \
  bun run --cwd cire/invites build
# delete the adapter's `legacy_env` key first — see the §3.3 foot-gun note
bunx wrangler deploy --config cire/invites/dist/server/wrangler.json

# organiser portal (Pages project: cire-organiser, host.cireweddings.com)
PUBLIC_CIRE_API_URL=https://api.cireweddings.com \
PUBLIC_OSN_ACCOUNT_URL=https://musubi.social \
PUBLIC_CIRE_WEB_URL=https://invite.cireweddings.com \
  bun run --cwd cire/host build
bunx wrangler pages deploy cire/host/dist --project-name cire-organiser
```

`cire/vendor` (→ `cire-vendor`, `vendor.cireweddings.com`) and `cire/landing`
(→ `cire-landing`, the apex) follow the same Pages pattern; their build env lives in the
`deploy-cire-vendor` / `deploy-cire-landing` jobs.

Make sure the published guest, organiser and vendor origins are exactly the ones listed in
cire-api's `WEB_ORIGIN` allowlist (§3.2) and in osn-api's `OSN_CORS_ORIGIN` /
`OSN_ORIGIN` (organiser and vendor passkey sign-in talk to osn-api).

### 5.4 Attach custom domains (human / dashboard steps) 🌐

The Worker custom domains auto-provision from `wrangler.toml`. You attach the Pages custom
domains in the dashboard. Both zones — `cireweddings.com` and, since 2026-07-27,
`musubi.social` — are in-account, so Cloudflare issues the DNS records and certs
automatically once you attach them.

1. **Worker custom domains (auto, verify only).** After `wrangler deploy --env production`:
   - osn-api → **`id.musubi.social`** (route in `osn/api/wrangler.toml`).
   - cire-api → **`api.cireweddings.com`** (route in `cire/api/wrangler.toml`).
   - cire/invites → **`invite.cireweddings.com`** (route in `cire/invites/wrangler.jsonc`).
   Confirm each shows as an active custom domain for its Worker (dashboard → Workers →
   *worker* → Settings → Domains & Routes, or `https://id.musubi.social/health` /
   `https://api.cireweddings.com/` return 200). `custom_domain = true` provisions the DNS
   record + cert; no manual DNS entry needed. The **proxied wildcard record on
   `musubi.social`** does not block this — a wildcard only answers names that have no record
   of their own, so the explicit `id` record takes precedence.
2. **Pages custom domains (dashboard, one-time).** In each Pages project → Custom domains:
   - `cire-landing` (marketing site) → add the apex **`cireweddings.com`**.
   - `cire-organiser` (organiser portal) → add **`host.cireweddings.com`**.
   - `cire-vendor` (vendor portal) → add **`vendor.cireweddings.com`** (§8.2).
   - `osn-social` (identity app + OIDC consent screen) → add the apex **`musubi.social`**.
     **Done 2026-07-27.** Not optional: `OSN_AUTHORIZE_UI_URL` points at
     `https://musubi.social/authorize`, and on `osn-social.pages.dev` the `__Host-` session
     and binding cookies would not reach the app and a passkey ceremony would be illegal
     (RP ID `musubi.social`). There is no longer a companion preview project — the
     `osn-social-preview` workflow was removed on 2026-07-27 ([[social]]); if the
     stale project is still in the account it is orphaned and can be deleted.
   Cloudflare adds the CNAME/records in the in-account zone and issues the cert. After the
   `cireweddings.com` apex is attached to Pages, confirm it does not collide with the
   email/DNS records from §1.1 (SPF/DKIM/DMARC are TXT records, the apex Pages target is a
   separate record type — they coexist).
3. **Re-check the allowlists** once the domains resolve: the live guest, organiser,
   vendor and identity origins must exactly match cire-api `WEB_ORIGIN` and osn-api
   `OSN_CORS_ORIGIN`. `OSN_ORIGIN` is a shorter list on purpose — only `https://musubi.social`,
   the one origin that may run a WebAuthn ceremony under the `musubi.social` RP ID (§3.1).
   A trailing-slash or scheme mismatch fails the Origin guard.
4. **Turnstile widget domains (dashboard).** `musubi.social` was added on 2026-07-27
   (§3.4). Only hostnames that render a form need listing, so `id.musubi.social` does not —
   osn-api serves JSON and siteverifies server-side. The wrangler API token has no
   `challenge-widgets.write` scope, so this cannot be scripted. Only bites once Turnstile
   is armed — it is inert today. [[turnstile]]

### 5.5 Promoting a merge to production (the approval gate) 🔑

Since 2026-08-13 nothing reaches production unattended. A merge to `main` runs
`changes` → `build` → every changed surface's **dev** job, then stops. Each production
job declares `environment: production`, a GitHub Environment with a required reviewer,
so the run sits on `Waiting` until someone approves it.

1. Open the run in **Actions → Deploy**. Jobs waiting on the gate show `Waiting` with a
   **Review deployments** button.
2. **Check the dev tier first** — that is the point of the gate. The dev jobs for the same
   commit have already deployed to `*.dev.cireweddings.com` / `dev.musubi.social`; walk the
   smoke checks in [[dev-environment]] §6 before approving.
3. Click **Review deployments**, tick every environment you mean to release, approve.
   Approving releases *all* ticked production jobs in that run; there is no way to approve
   one surface and hold another other than approving them in separate reviews.
4. The approval, the approver and the timestamp are recorded on the run — that record is
   the deploy audit trail (SOC 2 CC8, [[compliance/soc2]]).

> [!warning] A green dev tier does not prove production has the secrets
> Secrets are per-Worker and per-GitHub-Environment: dev and production share a
> commit, never a value. So a change that needs a new fail-closed secret can pass
> every dev smoke check and still take production down on the first request after
> approval — which is what `OSN_TOTP_ENCRYPTION_KEY` did between the 2026-07-27
> cutover and 2026-09-13. The `Preflight — required prod secrets are set` step in
> `deploy.yml` guards against exactly this, but it only asserts the names in its
> own `required` list, which today holds `OSN_PAIRWISE_SALT` alone — **a new
> fail-closed secret is caught only if somebody adds its name there** (englishstventures/osn#1021
> is extending the list to the whole set). Until then, before approving a run that
> introduces one, diff the names yourself:
> `cd osn/api && bunx --bun wrangler secret list --env production` against §3.1,
> then run §7 smoke check 1 straight after the deploy.

Rejecting a deployment leaves production on the previous release with dev already
ahead — a normal state, not a broken one. The next approved merge reconciles them.

### 5.6 Approval order when a cire release changes what a plan tier opens

`deploy-cire-host` and `deploy-cire-api` are separate production jobs with no
`needs:` between them, and both wait on the gate. When a release changes the
contract between them — the plan tiers ([[cire-entitlements]]) are the case
that exists — approve them in **separate reviews, host first**:

1. Run the pre-flight queries below, before approving anything.
2. Approve **`deploy-cire-host`** alone, and wait for it to finish.
3. Approve **`deploy-cire-api`**. It applies the D1 migrations, then deploys the
   Worker.

The order matters because only one pairing breaks. The new portal reads either
wedding-list shape: `tier` when the API sends it, the legacy entitlement keys
otherwise (`tierOf` in `cire/host/src/lib/tiers.ts`). The old portal on the new
API does not: it has no lock on Checklist or Budget, so an Ivory wedding's
Overview requests `/tasks`, gets the new 402, and blanks the whole snapshot.
Host first means that pairing never serves.

**Pre-flight for the tier release (migration 0073).** Read-only; a human runs
them against `cire-db`:

```bash
cd cire/api
bunx wrangler d1 execute cire-db --env production --remote --command \
  "SELECT entitlement, status, count(*) FROM wedding_upgrade_purchases GROUP BY 1, 2"
bunx wrangler d1 execute cire-db --env production --remote --command \
  "SELECT entitlement, count(*) FROM wedding_entitlements GROUP BY 1"
```

| Query | Expect | Why it matters |
|---|---|---|
| Purchases by product and status | No `pending` rows | 0073 expires every pending per-module purchase. One paid in the meantime still settles — settle accepts an expired row and maps `vendors` to Crimson, `registry` to Gold — but a pending row means a checkout was live, which no deployment should have while its Prices are unset |
| Entitlements by key | The counts 0073 will lift | `vendors` or `capacity_1000` rows become Crimson weddings, then `registry` or `capacity_500` rows Gold ones |

**If the first query shows any `pending` row, close its Stripe session before
approving `deploy-cire-api`.** 0073 marks the row `expired` in D1, which does
not close the session at Stripe: it stays payable for a day after it opened,
and a payment there settles into the tier that replaced its product. The new
Worker closes such a page at Stripe before it opens a tier checkout for that
wedding ([[cire-upgrades]]), so the organiser cannot pay both; closing it here
as well means no old per-module page is payable once the tiers are live. List
the sessions:

```bash
bunx wrangler d1 execute cire-db --env production --remote --command \
  "SELECT id, wedding_id, entitlement, checkout_session_id, created_at FROM wedding_upgrade_purchases WHERE status = 'pending' AND checkout_session_id IS NOT NULL"
```

Expire each one with the platform account's live secret key — the value set as
`cire-api`'s `STRIPE_SECRET_KEY` — through the same endpoint the Worker uses
(`expirePlatformCheckoutSession` in `cire/api/src/services/stripe.ts`):

```bash
curl -sS -X POST "https://api.stripe.com/v1/checkout/sessions/<checkout_session_id>/expire" \
  -u "$STRIPE_SECRET_KEY:"
```

The answer carries `"status": "expired"`. A session Stripe refuses to expire
has completed: its webhook settles it, and nothing more is needed. A pending
row with no `checkout_session_id` never handed out a payment page and needs
nothing.

After `deploy-cire-api`, confirm the lift:

```bash
bunx wrangler d1 execute cire-db --env production --remote --command \
  "SELECT tier, tier_source, count(*) FROM weddings GROUP BY 1, 2"
```

Then the smoke check: an Ivory wedding's Overview shows its guest and event
counts with no Checklist or Budget card, its Checklist, Budget and Registry rows
say "Included with Gold" and Vendors "Included with Crimson"; a migrated Crimson
wedding opens every module.

The release that follows — englishstventures/osn#1315, which deletes the legacy
entitlement rows and drops the portal's fallback and the list's legacy keys —
ships only once this one is live on both jobs.

Two API tokens back the two tiers: `CLOUDFLARE_API_TOKEN_DEV` on the `dev`
Environment, the existing `CLOUDFLARE_API_TOKEN` only on `production`. A
push-triggered job can therefore no longer reach a production-scoped credential —
this is what closed finding **S-M (preview-ci-prod-token)**.

---

## 6. Optional: guest account-linking bridge (cire → osn)

Account-linking (`POST /api/account/link`) lets a guest attach their household to their
OSN account. It is **additive and opt-in**; skip this section for the minimal launch.

### 6.1 What it needs

- cire-api: `CIRE_API_ARC_PRIVATE_KEY` (ES256 JWK), `CIRE_API_ARC_KEY_ID`, `OSN_API_URL`
  (§3.2). All three absent ⇒ the linking POST answers 503 (`src/index.ts:78-85`).
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
> osn-api rejects old cire-api's `graph:read` on `/profile-account`. CI deploys both
> Workers from the same merge, and the `register-service` re-run is manual, so
> `POST /api/account/link` **401s from merge time until step 2 below is done**:
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
> The `org:read` scope (added in the Vendors PR A — migration 0040) lets cire-api's `vendorOrgMember()` middleware resolve OSN org membership over ARC. The registration endpoint upserts, so re-running it is safe. Until it runs **per env**, the `vendorOrgMember()` org resolver fails soft to null and `/api/vendor/*` writes return **503**. The organiser CRM (`/api/organiser/weddings/:weddingId/vendors`) and claim-link generation work either way — they use only `graph:read`/`graph:resolve-account`.

---

## 7. Post-deploy verification (smoke checks)

Run these in order. Each one maps to a startup requirement listed above.

1. **Health / readiness / JWKS.** `curl https://id.musubi.social/health`,
   `/` , and `/.well-known/jwks.json` (and the cire-api root `https://api.cireweddings.com/`).
   200s confirm the Worker booted: no startup throw fired and the edge returned no 503
   `Worker misconfigured`. That is the **whole** fail-closed set in one check — in a
   non-local tier the boot throws on a missing or malformed:

   | Secret / var | Thrown from |
   |---|---|
   | `OSN_JWT_PRIVATE_KEY` + `OSN_JWT_PUBLIC_KEY` | `osn/api/src/build-deps.ts` |
   | `OSN_SESSION_IP_PEPPER` (≥32 bytes) | `osn/api/src/build-deps.ts` |
   | `OSN_ORIGIN` | `osn/api/src/build-deps.ts` |
   | `OSN_PAIRWISE_SALT` (≥32 bytes) | `osn/api/src/build-deps.ts` |
   | `OSN_TOTP_ENCRYPTION_KEY` (exactly 32 bytes) | `osn/api/src/build-deps.ts` |
   | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | `osn/api/src/index.ts` |
   | `OSN_CORS_ORIGIN` | `osn/api/src/lib/cors-config.ts` |
   | an email provider | `osn/api/src/lib/email-layer.ts` — production carries `RESEND_API_KEY` and no `OSN_EMAIL_OPTIONAL`, so a missing provider fails the boot outright (§1.1) |

   Any one of them missing takes down **every** route, not the feature it belongs to.
   The deploy job's `Preflight — required prod secrets are set` step is meant to catch
   that first, but it checks only the names hard-coded in its own `required` list —
   `OSN_PAIRWISE_SALT` today — so a secret nobody added there sails past it, and
   `wrangler deploy` reports success while every route 503s. That is how production ran
   without `OSN_TOTP_ENCRYPTION_KEY` from the 2026-07-27 cutover to 2026-09-13.
   **Run this check after every deploy that adds a tier or a new fail-closed value**,
   and re-read §0 against `wrangler secret list --env <tier>` when the list above grows.
   Extending the preflight to the whole set is englishstventures/osn#1021.

   `/.well-known/jwks.json` must also return an ES256 (`alg:"ES256"`, P-256) JWK.
2. **No ephemeral-key warning in logs.** Search osn-api boot logs; you must **NOT** see
   `"Using ephemeral JWT key pair — tokens will be invalidated on restart"`
   (`osn/api/src/index.ts:272-275`). If you do, `OSN_ENV` and/or the JWT key vars are not
   set — stop and fix before letting users in.
3. **Upstash reachable.** Confirm the Worker booted (no 503 `Worker misconfigured`
   refusing to fall back to in-memory limiters) — in non-local both
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` must be set, or the Worker
   fails closed (`osn/api/src/index.ts:92-96`). Hit a rate-limited endpoint and confirm
   limits persist across isolates.
4. **OTP email arrives.** Trigger an OTP flow (e.g. organiser sign-up/step-up): a real
   email must land at the test address — this exercises §1.1 end-to-end. If nothing
   arrives, check `RESEND_API_KEY` and the Resend sender-domain verification, and watch
   `osn.email.send.attempts{outcome="sent"}`. **In a degraded env (`OSN_EMAIL_OPTIONAL`
   set and no provider, §1.1) skip this check** — no OTP/security-notice email is
   delivered by design; instead confirm the boot logs show the loud
   `EMAIL DEGRADED: … booting with a NO-OP email transport` warning, and rely on passkey
   login (step 5) as the primary, unaffected factor.
5. **Passkey sign-in works — on `https://musubi.social`, not on the organiser portal.**
   Register + sign in on the identity app. This validates `OSN_RP_ID`, `OSN_ORIGIN`,
   `OSN_ISSUER_URL`, `OSN_CORS_ORIGIN` (osn-api side) and `VITE_OSN_ISSUER_URL`
   (musubi/social build). **Do not smoke-test this on `host.cireweddings.com`** — since the
   2026-07-27 move that ceremony is illegal (wrong RP ID) and will fail no matter how the
   Worker is configured, so a failure there tells you nothing. The organiser portal signs
   in through the OIDC redirect instead — step 6. [[musubi-identity-migration]]
6. **Organiser sign-in redirects and lands.** From `host.cireweddings.com`, click sign in:
   the browser must leave for `https://musubi.social/authorize`, run the ceremony there,
   and come back to the page it started on with the portal signed in. A **503
   `sign_in_unavailable`** at `/api/auth/oidc/start` means one of the four OIDC values is
   missing on cire-api (§3.2); `?auth_error=sign_in_failed` on the callback means the
   exchange failed — check that `CIRE_OIDC_CLIENT_SECRET` still matches
   `oauth_clients.client_secret_hash` and that the callback URI is registered byte for
   byte (§3.5). Then confirm `GET /api/auth/session` answers `{signedIn: true}` and that
   sign-out clears it. [[cire-auth]]
7. **Organiser dashboard works for any OSN user.** A freshly signed-in account sees an
   **empty wedding list** (`GET /api/organiser/weddings` → `200 {weddings: []}`, never a
   404/503), and can **create their first wedding** via the portal's create form
   (`POST /api/organiser/weddings` → `201`). No bootstrap-owner config is involved.
   Confirm a created wedding then appears in the list and is owner-scoped (another
   account's list stays empty). Verify with:
   `bunx wrangler d1 execute cire-db --remote --command "SELECT count(*) FROM weddings;"`.
8. **RSVP write succeeds.** A guest claims their family code on the guest site and submits
   an RSVP (`POST /api/rsvp`). A 2xx + a persisted row confirms cire-api ↔ D1 writes and
   the guest-session cookie path. Verify with:
   `bunx wrangler d1 execute cire-db --remote --command "SELECT count(*) FROM rsvps;"`.
9. **(If enabled) account-linking returns non-503.** `POST /api/account/link` should not
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
| osn migrations | `osn/db/drizzle/`; scripts `osn/db/package.json` (`db:migrate:*`); prod applied by CI (`deploy-osn-api`) |
| cire D1 / R2 bindings + prod vars | `cire/api/wrangler.toml:12-43` |
| cire edge fail-closed + WEB_ORIGIN parse | `cire/api/src/index.ts` (`fetch`), rule in `cire/api/src/lib/web-origin.ts` |
| cire ARC bridge (account-linking) | `cire/api/src/services/osn-bridge.ts`, env `cire/api/src/index.ts:25-27,80-85` |
| Drop orphaned demo wedding (`wed_bootstrap`) | `cire/db/migrations-archive/0015_drop_bootstrap_wedding.sql` (applied; squashed out of the live set 2026-09-10) |
| Organiser open access (any OSN user; no boot gate) | list/create `cire/api/src/routes/organiser-weddings.ts`; per-wedding authz `cire/api/src/middleware/wedding-owner.ts`, `wedding-member.ts` |
| cire migrate scripts | `cire/db/package.json` (`db:migrate:local|dev|prod`) |
| cire dev seed / reset + their guard | `cire/db/seed/dev-seed.sql`, `dev-reset.sql`; `scripts/cire-db-seed.sh`, `cire-db-reset.sh`, `cire-dev-db-guard.ts` |
| Two-tier deploy pipeline (dev auto, prod gated) | `.github/workflows/deploy.yml` (`changes` → `deploy-<surface>-dev` → `deploy-<surface>`) |

## Related

- [[observability-setup]] — OTel/Grafana endpoint + header wiring
- [[cire-auth]] — guest/organiser two-auth model + cire→osn ARC bridge
- [[database-environments]] — local bun:sqlite vs dev/staging/prod D1
- [[redis]] — Redis-backed rate limiters + session stores
- [[email]] — transactional email transport (Resend; Cloudflare Email Service is the legacy fallback)
- [[cire-vendors]] — vendor portal screens, API surface, token-stripping, Referrer-Policy, ARC org:read scope


---

## 8. Vendor portal first-run (manual, one-time)

> **These steps are NOT automated.** A team member with Cloudflare account access must run them by hand, before or just after the first `deploy-cire-vendor` CI job runs. They are listed here so the person merging PR B knows to run them. See [[cire-vendors]] for the full vendor portal system doc; see [[cire-auth]] for the auth model the portal relies on.

### 8.1 Create the Pages project

⚠️ Run this **once**, before the CI deploy job references the project. If the project does not exist, the deploy job errors with "project not found."

```bash
bunx wrangler pages project create cire-vendor
```

### 8.2 Add the custom domain

In the Cloudflare dashboard (or via Wrangler if supported):

1. Open the `cire-vendor` Pages project.
2. Go to **Custom domains** → **Set up a custom domain**.
3. Enter `vendor.cireweddings.com`.
4. Cloudflare creates the DNS CNAME record on the `cireweddings.com` zone by itself, because this account manages the zone. Confirm the CNAME is present.

### 8.3 Confirm CORS allowlist changes are live

After the PR B merge deploy completes, check that both Workers now allow the new origin. The allowlist entries add `https://vendor.cireweddings.com` to `cire/api/wrangler.toml` `WEB_ORIGIN` and to `osn/api/wrangler.toml` `OSN_ORIGIN` / `OSN_CORS_ORIGIN`. They ship with the PR B merge through the normal CI deploy jobs — you need no separate `wrangler deploy`.

Quick smoke check (replace `<token>` with a real short-lived claim token from a test seed):

```bash
# CORS preflight to cire-api
curl -si -X OPTIONS https://api.cireweddings.com/api/vendor/listing \
  -H "Origin: https://vendor.cireweddings.com" \
  -H "Access-Control-Request-Method: GET" \
  | grep -i "access-control"

# CORS preflight to osn-api
curl -si -X OPTIONS https://id.musubi.social/organisations \
  -H "Origin: https://vendor.cireweddings.com" \
  -H "Access-Control-Request-Method: GET" \
  | grep -i "access-control"
```

Expected: `access-control-allow-origin: https://vendor.cireweddings.com` in both responses.

### 8.4 Secrets

No new secret is required for the vendor portal itself:

- `RESEND_API_KEY` — the `vendor-claim-invite` email needs it on **cire-api** (`cire/api/src/index.ts` picks the Resend layer only when it is present). Confirm with `bunx wrangler secret list --env production` from `cire/api` before the first vendor invite; without it the invite email is not sent. See §1.1 and §3.2.
- The vendor portal (`cire/vendor`) is a static Pages app with no server-side secrets. It reads from `cire-api` and `osn-api` via `authFetch` in the browser.

### 8.5 ARC re-registration (org:read scope)

The vendor portal uses `vendorOrgMember()` middleware, which needs the `org:read` scope on cire-api's ARC key registration. ⚠️ Until this step runs, `/api/vendor/*` writes return 503. The organiser CRM and claim-link generation keep working. After deploying, re-run the §6.2 `register-service` call per environment with `allowedScopes: "graph:read,graph:resolve-account,org:read"`.

### 8.6 Rollback

To roll the vendor portal back:

1. Remove the `https://vendor.cireweddings.com` entries from `cire/api/wrangler.toml` `WEB_ORIGIN` and `osn/api/wrangler.toml` `OSN_ORIGIN` / `OSN_CORS_ORIGIN`.
2. Merge the revert PR — CI redeploys both Workers with the narrowed allowlists.
3. Optionally disable the `cire-vendor` Pages project custom domain in the Cloudflare dashboard.

You need not delete the Pages project — leave it idle.

---

## 9. zap-api production bring-up (PR A follow-up)

> ⚠️ **Requires explicit authorization; prod writes.** Every step in this section changes production infrastructure or sets production secrets. Do NOT run any of these steps without explicit human authorisation from the team. They are a deploy-time checklist, not automated tasks.

These steps are manual follow-ups to the c2b chats PR (Zap PR A). The `deploy-zap-api` CI job exists in `.github/workflows/deploy.yml` but stays **dormant** until you finish step 9.1 — it does not fire on merges until the prod D1 id is filled in.

### 9.1 Create the zap-db-prod D1 database

> **Region:** use `--location oc` (Oceania / Sydney) to co-locate with the other D1 databases (osn-db-prod and cire-db, all `oc`) and Upstash (`ap-southeast-2`). AU-centric traffic, low write latency.

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

⚠️ Committing this change **activates the dormant `deploy-zap-api` CI job**. Later merges to `main` then build and deploy zap-api to production and apply D1 migrations on their own.

Commit and merge the change.

### 9.2 Set zap-api production secrets

```bash
# From zap/api/
cd zap/api

# REQUIRED: OSN JWKS URL for access-token verification (also set as a [vars] entry in
# wrangler.toml [env.production.vars]; confirm it is already OSN_JWKS_URL = "https://id.musubi.social/.well-known/jwks.json")
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
| `OSN_JWKS_URL` | Set as `[vars]` in wrangler.toml | Already in `zap/api/wrangler.toml [env.production.vars]` = `https://id.musubi.social/.well-known/jwks.json`. No separate secret needed. |
| `INTERNAL_SERVICE_SECRET` | **Yes (for §9.3)** | Guards `POST /internal/register-service`. Without it zap-api returns 501 on that endpoint. |
| `ZAP_CORS_ORIGIN` | Optional | Only needed once `@zap/app` client ships and calls user-facing routes. `c2b` uses only internal ARC routes. |

### 9.3 Register cire-api's ARC public key with zap-api

This mirrors the cire↔osn `org:read` registration in §6.2. cire-api needs the `chat:c2b` scope on zap-api to provision and message c2b chats.

> ⚠️ **Requires explicit authorization; prod writes.** A human runs this step at deploy time — not CI, and not this PR. Run it once per environment (dev / staging / prod), after zap-api is deployed and `INTERNAL_SERVICE_SECRET` is set.
>
> **Trigger condition:** if `POST https://zap.cireweddings.com/internal/register-service` returns 501, `INTERNAL_SERVICE_SECRET` is not yet set on zap-api. Finish §9.2 first, then try again.

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

(`POST /internal/register-service` returns 501 if `INTERNAL_SERVICE_SECRET` is unset on zap-api, 401 on a bad bearer. The registration is an upsert — safe to re-run.) Until this step runs per environment, cire-api's `/api/organiser/weddings/:id/enquiries` and vendor-enquiry flows return 503, because the zap-api bridge fails soft when the ARC key is absent.

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


---

## 10. Rotating `OSN_TOTP_ENCRYPTION_KEY`

This key decrypts **every enrolled second factor on every account**. A rotation
is two secret writes and two deploys, with an unattended wait between them; it
costs no downtime and no re-enrolment, provided the order below is kept. The
mechanism — the two-key ring, the lazy re-encryption — is in
[[totp#Rotating the encryption key]]. This section is the procedure.

> [!warning] You cannot rotate a key you do not have a copy of
> Cloudflare never returns a secret's value; `wrangler secret list` shows names
> only. Step 1 hands the **outgoing** value back to the Worker, so a key nobody
> escrowed cannot be rotated at all — only replaced, which makes every enrolled
> user re-enrol. Tiers whose key was generated in-job by an older version of
> `set-osn-api-secret.yml` are in that position. If you must replace such a key,
> do it by hand with `wrangler secret put` and tell users to re-enrol; the
> workflow deliberately will not do it for you.

### 10.0 Before you start

- The tier is running a build that includes the two-key ring. A Worker on an
  older bundle refuses any row stamped with a version it does not know, so
  staging a previous key while old isolates survive answers 500 on the recovery
  route for the length of the overlap. Wait for the deploy to complete.
- The current drain is finished — that is, **you are not already mid-rotation**.
  There are two key slots and no third: starting a second rotation while rows
  remain on the first outgoing key strands them, and the only recovery is to
  choose which group of users to lock out. §10.3 is how you know.
- You have the value currently live, and a way to keep the new one.

### 10.1 Step 1 — stage the outgoing key

Set `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS` to the value **currently live** in
`OSN_TOTP_ENCRYPTION_KEY`, then redeploy.

> [!warning] The by-hand line below skips every guard the workflow gives you
> Run straight from a laptop, `wrangler secret put` checks nothing: not the
> required 32-byte length, not the `production` GitHub Environment's reviewer
> (there is no Actions run here for one to gate), and it never lands on dev
> first. A bad value still goes in clean — osn-api only checks length at boot —
> so the tier looks fine until the next cold start, then every route on it
> 503s, with no canary to have caught it first. Use the workflow. Keep the
> by-hand line for when GitHub Actions itself will not run, and check the
> length yourself before you paste the value in:
> `printf '%s' "$OLD_KEY" | base64 -d | wc -c` must print `32`.

```bash
gh secret set OSN_TOTP_ENCRYPTION_KEY_PREVIOUS --repo englishstventures/osn --env production
# then run the `set-osn-api-secret` workflow: secret=OSN_TOTP_ENCRYPTION_KEY_PREVIOUS, tier=production
# or, by hand — read the warning above first:
cd osn/api && printf '%s' "$OLD_KEY" | bunx wrangler secret put OSN_TOTP_ENCRYPTION_KEY_PREVIOUS --env production
bunx --bun wrangler deploy --env production
```

Nothing changes for users: both slots hold the same key, so every credential
still verifies and none is rewritten.

> [!important] Redeploy, every time
> `wrangler secret put` does not cycle warm isolates. Until osn-api is
> redeployed, some requests are served by isolates that have never seen the new
> secret. This applies to every step below, including the deletion in §10.4.

### 10.2 Step 2 — install the new key

Generate the new key, **keep a copy**, set it, redeploy.

```bash
openssl rand -base64 32          # keep this value; you will need it to rotate again
gh secret set OSN_TOTP_ENCRYPTION_KEY --repo englishstventures/osn --env production
# then run the `set-osn-api-secret` workflow: secret=OSN_TOTP_ENCRYPTION_KEY, tier=production
```

The workflow **refuses** this step if `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS` is not
already set on that tier, because doing it first strands every enrolled
credential until step 1 lands. That check is on presence, not value: it cannot
tell whether the previous slot holds the outgoing key, a stale one from the last
rotation, or a typo. Getting that right is this procedure's job. The workflow
also refuses a value that does not decode to exactly 32 bytes — its `base64 -d`
is stricter than the Worker's own decoder, so a rejection there is the job being
fussy rather than a Worker bug.

From here, every successful TOTP check re-encrypts its own row under the new key.

### 10.3 Wait for the drain, and measure it

A credential moves onto the new key the next time its owner enters a code, so
the drain takes as long as your least active user takes to use their second
factor. **Do not guess, and do not use `key_version`** — slot numbers are reused
by the next rotation, so a stamp cannot tell a drained row from a stale one.
`last_used_at` can, because the statement that re-encrypts a row is the one that
sets it:

```bash
# Rows that have NOT been used since the rotation began, and so may still be
# under the outgoing key. Zero means the drain is complete.
# <started> is the unix time you completed §10.2.
cd osn/api && bunx wrangler d1 execute osn-db-prod --remote --env production --command \
  "SELECT count(*) FROM totp_credentials WHERE confirmed_at IS NOT NULL AND (last_used_at IS NULL OR last_used_at < <started>);"
```

Watch two dashboard signals alongside it:

- `osn.auth.totp.rekeyed{result="ok"}` climbing — rows are draining.
- `osn.auth.totp.rekeyed{result="failed"}` non-zero — those rows still verify
  but are **not** draining, and the count above will never reach zero while it
  persists. Investigate before continuing.

Users are unaffected throughout. If some accounts never drain, they are accounts
nobody is using; deleting the previous key costs those users their second factor
and nothing else, and they can re-enrol.

### 10.4 Step 3 — remove the outgoing key

Once the count is zero (or you have accepted the remainder):

```bash
cd osn/api && bunx wrangler secret delete OSN_TOTP_ENCRYPTION_KEY_PREVIOUS --env production
bunx --bun wrangler deploy --env production
```

Rows still stamped with the old slot number keep working — the stamp is a hint,
and the remaining key opens them by trial. Do not "tidy" those stamps.

### 10.5 When it goes wrong

| Symptom | What happened | What to do |
|---|---|---|
| `osn.auth.totp.verified{result="unreadable"}` climbing, TOTP step-up failing | No configured key opens those rows — the previous key is missing, or the wrong value | Set `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS` to the correct outgoing value and redeploy. Nothing was written; the rows are intact |
| Every route on the tier 503s after a secret change | A key is present but malformed. Both keys fail the boot on a bad value | Fix the **value** and redeploy. Deleting the secret alone leaves crashed warm isolates crashed |
| You want to undo the new key | A rollback is a rotation **back**, not a revert | Put the value you are rolling back **from** into `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS`, the old value into `OSN_TOTP_ENCRYPTION_KEY`, redeploy, and drain again. Simply restoring the old key strands every row already re-encrypted under the new one |
| Users report being locked out after you fixed the key | Failed checks during the outage spent their per-account lockout budget | Wait. The lockout expires on its own; do not reset counters by hand |

> [!note] Rotating because the key leaked
> Lazy re-encryption keeps the compromised key **live** until the drain
> finishes, because that is what lets un-drained users keep verifying. That is
> the trade this design makes. If the exposure will not tolerate it, delete
> `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS` early and accept that everyone not yet
> drained must re-enrol — the credential rows survive, they simply stop opening.
