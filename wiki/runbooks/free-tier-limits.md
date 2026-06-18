---
title: Free-Tier Limits & Unavailability Runbook
description: Our provider free-tier ceilings (Upstash, Cloudflare Workers / D1 / Pages / Turnstile / WAF), what breaks when each is exceeded, how to detect it, the immediate mitigation, and the upgrade trigger/cost. Plus a per-dependency unavailability playbook keyed to the actual fail-open/fail-closed posture in code.
tags: [runbook, ops, free-tier, limits, cloudflare, upstash, d1, redis, observability, incident]
severity: high
related:
  - "[[production-deploy]]"
  - "[[rate-limit-incident]]"
  - "[[rate-limiting]]"
  - "[[redis]]"
  - "[[database-environments]]"
  - "[[observability-setup]]"
  - "[[cire-auth]]"
last-reviewed: 2026-06-18
---

# Free-Tier Limits & Unavailability Runbook

> Scope: we run **exclusively on provider free tiers** — Cloudflare Free zone +
> Workers Free, Cloudflare D1, Cloudflare Pages, Upstash Redis Free, and
> (incoming) Cloudflare Turnstile. This runbook records every ceiling, what
> breaks when we hit it, how to detect it, the immediate mitigation, and the
> upgrade trigger + cost.
>
> **All numbers below are the documented limits as of `last-reviewed` and
> WILL drift — re-verify against the provider's own pricing page before
> acting on a quota decision.** Each section links its source page.

## Dependency → service map (who depends on what)

| Dependency | Used by | NOT used by |
|---|---|---|
| **Upstash Redis** | `@osn/api` (rate limiters + the stateful auth stores: step-up JTI, rotated-session, recovery lockout, ceremonies) when `REDIS_URL` / `UPSTASH_*` is set | **cire-api** (no Redis at all — see below), Pulse/Zap client apps |
| **Cloudflare Workers** | `osn-api`, **cire-api** (both are Workers) | static Pages sites |
| **Cloudflare D1** | `osn-db-prod` (osn-api), `cire-db` (cire-api) | — |
| **Cloudflare Pages** | `cire/web` (guest), `cire/organiser`, `@osn/social`, `@osn/landing` | the Worker APIs |
| **Cloudflare Rate Limiting binding** (Workers, not WAF) | **cire-api** `CLAIM_RATE_LIMITER` (the pre-auth `/api/claim` edge limiter) | osn-api (uses Upstash) |
| **Turnstile** (incoming) | guest/auth forms once it lands | — |

> **Key accuracy note:** **cire-api does NOT use Upstash/Redis.** Its only
> rate limiter is the native Cloudflare Workers Rate Limiting binding
> (`CLAIM_RATE_LIMITER` in `cire/api/wrangler.toml`), and its state lives in
> D1. So an **Upstash outage does not touch cire** — it degrades **osn-api**
> auth + (via osn-api) any downstream that needs an osn access token. Don't
> conflate the two.

---

## Upstash Redis (Free)

**Source:** [upstash.com/docs/redis/overall/pricing](https://upstash.com/docs/redis/overall/pricing) · [pricing](https://upstash.com/pricing/redis) — re-verify.

| Limit | Free value (re-verify) |
|---|---|
| Commands | **500K / month** (~16.6K / day; Upstash also throttles per-second within a window) |
| Max data size | **256 MB** |
| Max request size | **10 MB** |
| Max record size | **100 MB** |
| Monthly bandwidth | **10 GB** |
| Databases | **1** free DB |
| Concurrent connections | Not published for Free — we use the **REST/Upstash** client (`@shared/redis/upstash`), which is stateless HTTP, so classic connection caps don't apply the way they do for `ioredis`. |
| Inactivity | Free DB **archived after ~14 days idle** (warning emails first) — keep at least one health-check command flowing so prod is never archived. |

**What breaks when we exceed it.** Every Redis-backed subsystem in `@osn/api`
fails on backend error per its documented posture (see the Unavailability
Playbook below for the exact fail-open vs fail-closed split — **do not assume
uniform fail-closed**). Hitting the command cap looks identical to "Redis
down": commands start rejecting/throttling, and:

- **Rate limiters (auth per-IP, graph/org-write per-user) → fail CLOSED.**
  `createRedisRateLimiter().check()` returns `false` on any Redis error
  (`shared/redis/src/rate-limiter.ts`, S-M36), so auth + graph/org writes
  degrade to **HTTP 429**.
- **Step-up JTI store → fails CLOSED** (`osn/api/src/lib/step-up-jti-store.ts`,
  default `failClosedOnError = true`, S-H1): step-up-gated actions (recovery
  generate, email change complete, security-event ack, passkey rename/delete)
  start **rejecting** the ceremony.
- **Ceremony store → conservative → ceremony fails CLOSED at complete**
  (`osn/api/src/lib/ceremony-store.ts`): login/registration ceremonies can't
  read back their state, so `complete` fails — users **can't finish sign-in**.
- **Rotated-session store → fails OPEN** (`osn/api/src/lib/rotated-session-store.ts`):
  reuse detection silently no-ops, so a refresh **still works** but the
  reuse-revocation safety net is temporarily off.
- **Recovery lockout store → fails OPEN** (`osn/api/src/lib/recovery-lockout-store.ts`,
  S-H1): the per-account recovery brute-force ceiling stops enforcing — the
  per-IP limiter is the only remaining brake.

**User-visible symptom:** users can't log in / register (ceremony complete
fails); existing sessions that hit a rate-limited or step-up path get 429 / a
"please try again" error; password-reset-style recovery flows lose their
per-account lockout (security regression, not an outage the user sees).

**How to detect:**
- **Upstash console** → database → usage graphs: command count approaching
  500K/month, or the throttle indicator.
- **Workers Logs** (now enabled — see Monitoring): a burst of `Effect.logError`
  from the stores + the `osn.auth.rate_limited` metric spiking with no traffic
  spike to justify it; ceremony-store / step-up-store error logs.
- Metrics: `osn.auth.rate_limited`, `osn.auth.ceremony_store.operations`,
  `osn.auth.step_up.verified` dropping, `osn.auth.recovery.lockout`.

**Immediate mitigation:**
- If it's the **monthly command cap** (not an outage): the fastest unblock is to
  upgrade Upstash to Pay-as-you-go (see trigger). There is no safe "fail-open"
  flip for the rate limiters / step-up — that's a deliberate security posture.
- For a transient Upstash **outage** (not quota): osn-api falls back to the
  in-memory client only when `REDIS_URL`/`UPSTASH_*` is **unset** — you cannot
  hot-swap to in-memory in prod without a redeploy, and in-memory is
  per-isolate (not cluster-safe). Prefer waiting out a short blip; the stores
  degrade per the posture above.

**Upgrade trigger / cost:** when monthly commands trend toward ~500K, or the
single free DB's 256 MB fills, move to **Upstash Pay-as-you-go** (pay per
command + bandwidth; first 200 GB bandwidth free). This also lifts the
1-DB and archive-on-idle constraints. Re-verify current pricing before pulling
the trigger.

---

## Cloudflare Workers (Free)

**Source:** [workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [limits](https://developers.cloudflare.com/workers/platform/limits/) — re-verify.

| Limit | Free value (re-verify) |
|---|---|
| Requests | **100,000 / day** (per account, across all Workers) |
| CPU time | **10 ms / invocation** |
| External subrequests | **50 / invocation** |
| Subrequests to CF services (D1/R2/KV) | **1,000 / invocation** |

**What happens at the cap.** Past 100K requests/day the account's Workers
(osn-api **and** cire-api together) start returning **HTTP 429 from
Cloudflare's edge** — before our handler runs. CPU overruns terminate the
single invocation (`exceededCpu`); subrequest overruns throw "Too many
subrequests" (`exceededResources`).

**User-visible symptom:** site-wide 429s once the daily cap is hit (resets at
UTC midnight); sporadic 5xx/`exceededResources` on unusually heavy single
requests (e.g. a large spreadsheet import making many D1 calls).

**How to detect:** CF dashboard → Workers & Pages → account-level **Requests**
metric vs the 100K line; per-Worker invocation statuses showing
`exceededResources` / `exceededCpu`; Workers Logs invocation records.

**Upgrade path:** **Workers Paid** ($5/mo) — 10M requests/mo included, 30s CPU
default, far higher subrequest ceilings. This is the most likely first upgrade
once both APIs are in production. Re-verify pricing.

---

## Cloudflare D1 (Free)

**Source:** [d1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [limits](https://developers.cloudflare.com/d1/platform/limits/) — re-verify. Applies to **both** `osn-db-prod` and `cire-db`.

| Limit | Free value (re-verify) |
|---|---|
| Rows read | **5,000,000 / day** |
| Rows written | **100,000 / day** |
| Storage | **5 GB / account total** |
| Max DB size | **500 MB** |
| Databases | **10 / account** |
| Queries per Worker invocation | **50** |
| Max row size | **2 MB** |

**What breaks.** When the daily rows-read or rows-written ceiling is hit, D1
queries start **failing** (the binding returns errors). Because both cire-api
and osn-api **fail closed** on a missing/erroring DB (cire-api: `index.ts`
returns **503** if `env.DB` is absent/erroring), the symptom is **503s on any
DB-touching route** — i.e. effectively the whole app, since auth, claims, RSVP,
graph all read D1. Note the daily counters are **shared across both DBs on the
one account** (5 GB storage and the day's read/write counts are account-wide).

**User-visible symptom:** 503 / "service unavailable" across the app until the
daily counter resets at **UTC midnight**, or storage is freed.

**How to detect:** CF dashboard → Workers & Pages → D1 → database → metrics
(rows read/written vs the daily line, storage vs 5 GB); Workers Logs error
lines from the D1 query path.

**Upgrade path:** **Workers Paid** unlocks the D1 paid tier — 25B rows
read/mo + 50M rows written/mo included, 10 GB max DB size, 50K databases, 1 TB
storage; overage is cheap ($0.001/M read, $1/M written, $0.75/GB-mo). Re-verify.

---

## Cloudflare Pages (Free)

**Source:** [pages limits](https://developers.cloudflare.com/pages/platform/limits/) — re-verify. Hosts `cire/web`, `cire/organiser`, `@osn/social`, `@osn/landing`.

| Limit | Free value (re-verify) |
|---|---|
| Builds | **500 / month** |
| Concurrent builds | **1** |
| Bandwidth | **Unmetered** (static asset serving is free/unlimited) |
| Custom domains | **100 / project** |
| Files per site | **20,000** |
| Max file size | **25 MiB** |

**Low risk.** Bandwidth being unmetered is the headline — the guest site can go
viral without a bandwidth bill. The realistic ceiling is **500 builds/month**
(a busy CI day with many pushes) and **20,000 files** (large asset bundles).
Symptom of a build cap: new deploys queue/fail until the month resets — the
**already-deployed** site keeps serving. No app-level fail-closed here.

**Upgrade path:** Pages Pro raises builds to 5,000/mo + 5 concurrent. Rarely
needed for our volume.

---

## Turnstile (Free) — for when it lands

**Source:** Cloudflare Turnstile pricing — re-verify when integrating (`/turnstile-spin`).

Turnstile is **free with effectively unlimited `siteverify` volume** for the
standard widget — there is no per-verification charge on the free product, so
it is **not a capacity risk** for us. The only operational concern is keeping
the secret key in a Worker secret and the sitekey in `[vars]`. When Turnstile
lands, add its widget + the managed `siteverify` Worker per the
[[production-deploy]] secret checklist. Re-verify that the free tier is still
unlimited at integration time.

---

## WAF / Rate Limiting rules (Free)

**Source:** [waf custom-rules](https://developers.cloudflare.com/waf/custom-rules/) · [waf rate-limiting-rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) — re-verify.

| Capability | Free value (re-verify) |
|---|---|
| **Rate Limiting rules** (WAF) | **1 rule**, **10-second window only** |
| **Custom rules** | **5 rules** |
| **Managed ruleset** | **Cloudflare Free Managed Ruleset** (auto-on, no config; subset of the full managed rules) |

**Implication for our design:** with only **1 WAF rate-limiting rule** capped at
a **10-second window**, **we cannot lean on the WAF for application rate
limiting.** That's exactly why rate limiting lives in the app:

- osn-api → Upstash-backed per-IP / per-user limiters ([[rate-limiting]],
  [[redis]]).
- cire-api → the native **Workers** Rate Limiting binding `CLAIM_RATE_LIMITER`
  (5 attempts / 60 s) for the pre-auth claim surface — a *Workers* feature,
  distinct from the *WAF* rate-limiting rule counted above.

Reserve the single WAF rate-limit rule + the 5 custom rules for **coarse edge
defence** (e.g. the `/internal/*` block in the hardening TODO below), not for
per-endpoint app limits. Cross-ref [[rate-limiting]] for the full design.

---

## Unavailability response playbook

Per dependency: expected degradation (**verified against code, with file
refs**), the detection signal, and the escalation/upgrade action. **The
fail-open vs fail-closed split is NOT uniform — read this table, don't guess.**

| Dependency down / over-quota | Subsystem | Posture (verified) | Effect | Detect | Action |
|---|---|---|---|---|---|
| **Upstash** (osn-api) | Auth + graph/org rate limiters | **fail-CLOSED** — `rate-limiter.ts` `check()` returns `false` on error (S-M36) | 429 on auth + graph/org writes | `osn.auth.rate_limited` spike, store error logs | Wait out blip; if quota → upgrade Upstash. **Do not** flip to fail-open. |
| **Upstash** (osn-api) | Step-up JTI store | **fail-CLOSED** — `step-up-jti-store.ts` `failClosedOnError ?? true` (S-H1) | Step-up-gated actions rejected | step-up error logs, `osn.auth.step_up.verified` drop | Same — security posture is intentional. |
| **Upstash** (osn-api) | Ceremony store | **conservative → ceremony fails CLOSED at complete** — `ceremony-store.ts` (`get`→null) | Login/registration `complete` fails | `osn.auth.ceremony_store.operations`, error logs | Restore Redis / upgrade; this is the user-facing one. |
| **Upstash** (osn-api) | Rotated-session store | **fail-OPEN** — `rotated-session-store.ts` (`check`→null, `track` logs+continues) | Refresh still works; **reuse-revocation off** | reuse-store error logs, `osn.auth.session.reuse_detected` flat | Restore promptly — a safety net is down, but no user breakage. |
| **Upstash** (osn-api) | Recovery lockout store | **fail-OPEN** — `recovery-lockout-store.ts` (`isLocked`→false, `recordFailure`→0) (S-H1) | Per-account recovery brute-force ceiling off; per-IP limiter still applies | `osn.auth.recovery.lockout` flat, error logs | Restore promptly — brute-force ceiling is the protection that's down. |
| **D1** down / over daily rows quota | cire-api + osn-api | **fail-CLOSED** — cire `index.ts` returns **503** on absent/erroring `env.DB` | App-wide 503 on DB routes | CF D1 metrics vs daily line; 503 in Workers Logs | Wait for UTC reset, free storage, or upgrade to Workers Paid (D1 paid tier). |
| **A Worker** over daily request quota | osn-api / cire-api | CF edge **429** before handler runs | Site-wide 429 (resets UTC midnight) | account Requests metric vs 100K | Upgrade to **Workers Paid** ($5/mo). |
| **Pages** build cap | static sites | already-deployed site keeps serving; new deploys queue/fail | stale deploys, build failures | Pages build history | Wait for month reset or Pages Pro. |

> The Upstash split above is load-bearing: **rate limiters + step-up JTI +
> ceremonies fail closed; rotated-session + recovery lockout fail OPEN.** If you
> change any store's posture, update this table and its file ref.

---

## Monitoring

With **Workers observability now enabled** on cire-api (`[observability]` +
`[env.production.observability]` in `cire/api/wrangler.toml`, this PR) and on
osn-api (sibling PR), Workers Logs + invocation records persist for **7 days**
and are viewable in the CF dashboard.

- **Where to watch:** CF dashboard → **Workers & Pages → cire-api / osn-api →
  Observability / Logs** (and the Query Builder). D1 + Workers request metrics
  live on each resource's **Metrics** tab. App-level OTel traces/metrics still
  go to Grafana Cloud ([[observability-setup]]) when the OTEL endpoint is set.
- **What to alert on:**
  - **Workers requests** approaching **100K/day** (account-wide) → upgrade soon.
  - **D1 rows-read / rows-written** approaching the daily lines (5M / 100K) →
    investigate a hot query path or upgrade.
  - **`osn.auth.rate_limited`** spiking without a traffic spike → likely an
    Upstash command-cap / outage failing the limiters closed (see playbook).
  - **Ceremony/step-up store error logs** → Upstash degraded; expect login
    failures.
  - Recurring `exceededResources` / `exceededCpu` invocation statuses → a heavy
    request path (e.g. spreadsheet import) bumping the Free CPU/subrequest caps.

---

## Cloudflare security hardening (free, dashboard) — TODO

These are **manual dashboard steps** the maintainer must do — they can't be
applied from code/wrangler with current tooling. All are free on the Cloudflare
Free plan. Defence-in-depth on top of the app-level guards (ARC, origin guard,
auth middleware).

1. **Enable the free WAF Managed Ruleset.** Dashboard → the `cireweddings.com`
   zone → **Security → WAF → Managed rules** → confirm **Cloudflare Free Managed
   Ruleset** is deployed/active (it's on by default, but verify per zone).
2. **Add a free custom rule blocking public `/internal/*` and
   `/graph/internal/*`.** Dashboard → zone → **Security → WAF → Custom rules →
   Create rule**. Expression: `(http.request.uri.path contains "/internal/" or
   starts_with(http.request.uri.path, "/graph/internal/"))` → **Action: Block**.
   This is belt-and-suspenders on top of ARC — those routes are S2S-only and
   should never be reachable from the public internet. (Costs 1 of the 5 free
   custom rules.)
3. **Enable Page Shield (basic)** on the guest Pages site. Dashboard → zone →
   **Security → Page Shield** → turn on script monitoring — catches unexpected
   third-party scripts on `cire/web` (the guest invite).
4. **Confirm DDoS protection is on.** Dashboard → zone → **Security → DDoS** →
   verify the automatic L7 HTTP DDoS managed ruleset is enabled (on by default;
   confirm it wasn't disabled).

> When these are done, tick them off here and note the date. Until then they are
> open hardening items — track in `wiki/TODO.md` (Security Backlog) if they
> should be visible there.

## Related

- [[production-deploy]] — first prod cut-over, secret/var checklist
- [[rate-limit-incident]] — rate-limiter false-positives + Redis health
- [[rate-limiting]] / [[redis]] — app rate-limiting design + Redis stores
- [[database-environments]] — the four DB environments (D1 in dev/staging/prod)
- [[observability-setup]] — Grafana Cloud + OTEL wiring
- [[cire-auth]] — cire's two-system auth (what degrades when D1 is down)
</content>
</invoke>
