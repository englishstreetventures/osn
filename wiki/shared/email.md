---
title: Email Transport (transactional auth emails)
aliases:
  - email
  - email service
  - outbound email
  - cloudflare email
tags:
  - systems
  - auth
  - email
  - resend
  - cloudflare
  - observability
status: current
related:
  - "[[cire-rsvp-changes]]"
  - "[[identity-model]]"
  - "[[step-up]]"
  - "[[passkey-primary]]"
  - "[[recovery-codes]]"
  - "[[shared/observability/overview]]"
packages:
  - "@shared/email"
  - "@osn/api"
  - "@cire/api"
last-reviewed: 2026-10-09
---

# Email Transport

OSN's transactional-email surface. Dispatches OTP codes (registration,
step-up, email-change) and security-event notifications
(recovery-code generate/consume, passkey added/removed) to users. No
marketing mail, no product updates — only auth-critical transactional
email.

## Architecture

```
  ┌──────────────────────┐        ┌──────────────────────┐        ┌────────────────────────┐
  │ @osn/api services    │        │  @shared/email       │        │ Resend HTTP API        │
  │ auth.ts call sites:  │ calls  │  EmailService (Tag)  │ Bearer │  POST /emails          │
  │  beginRegistration   ├───────▶│  ResendEmailLive     ├───────▶│                        │
  │  beginStepUpOtp      │ Effect │  CloudflareEmailLive │  JSON  │  (or Cloudflare Email   │
  │  beginEmailChange    │        │  LogEmailLive (dev)  │        │   Service REST API as   │
  │  notifyRecovery      │        │                      │        │   legacy fallback)      │
  │  notifyPasskey*      │        │  renderTemplate()    │        │  DKIM-signs via         │
  │                      │        │                      │        │  verified sender domain │
  └──────────────────────┘        └──────────────────────┘        └────────────────────────┘
```

The **live transport is Resend** — a single bearer-authed HTTPS POST to
`https://api.resend.com/emails` (locally, optionally to a Resend emulator: see
[[#Local emulation]]). Resend works on workerd over plain HTTP
(no paid Workers plan required), so we prefer it over the Cloudflare
Email Service transport. The Cloudflare transport
(`https://api.cloudflare.com/client/v4/accounts/{id}/email-service/send`)
stays as a legacy fallback. Both render the **same** templates
in-process and DKIM-sign via the verified sender domain
(`cireweddings.com` in prod) — no intermediate Worker, no ARC tokens.

## Packages

- **`@shared/email`** — the Effect service + template renderers + both
  transport Layers. Imported by any OSN service that needs to send mail.

## Contract

### Call site (inside `@osn/api`)

```ts
import { EmailService } from "@shared/email";

const email = yield* EmailService;
yield* email.send({
  template: "otp-registration",
  to: normalisedEmail,
  data: { code, ttlMinutes: otpTtl / 60 },
});
```

The template catalogue is the complete list of emails OSN sends:

| Template                 | Data shape                          | Call site |
|--------------------------|-------------------------------------|-----------|
| `otp-registration`       | `{ code, ttlMinutes }`              | `beginRegistration` |
| `otp-step-up`            | `{ code, ttlMinutes }`              | `beginStepUpOtp` |
| `otp-email-change`       | `{ code, ttlMinutes }`              | `beginEmailChange` |
| `otp-recovery`           | `{ code, ttlMinutes }`              | `beginEmailRecovery` |
| `recovery-generated`     | `{}`                                | `notifyRecovery("recovery_code_generate")` |
| `recovery-consumed`      | `{}`                                | `notifyRecovery("recovery_code_consume")` |
| `recovery-used`          | `{}`                                | `completeRecoveryFactor` (email + TOTP) |
| `passkey-added`          | `{}`                                | `notifyPasskeyRegisteredByAccountId` |
| `passkey-removed`        | `{}`                                | `notifyPasskeyDeletedByAccountId` |
| `totp-enrolled`          | `{}`                                | `completeTotpEnrollment` |
| `totp-disabled`          | `{}`                                | `disableTotp` |

cire-api sends from the same catalogue:

| Template | Data shape | Call site |
|---|---|---|
| `enquiry-new`, `enquiry-reply`, `enquiry-quote` | `EnquiryNewData` / `EnquiryReplyData` / `EnquiryQuoteData` | the vendor-enquiry service |
| `vendor-claim-invite` | `{ claimUrl, vendorName }` | the vendor directory's claim invite |
| `registry-gift-summary` | `RegistryGiftSummaryData` (aggregates only) | the retention sweep, as it deletes a wedding's guest data |
| `rsvp-change-digest` | `{ weddingName, households, counts, rsvpUrl }` — counts per kind of change, no guest name | the daily RSVP digest cron — see [[cire-rsvp-changes]] |
| `wedding-owner-change` | `WeddingOwnerChangeData` — wedding name, who acted, whose seat changed, the change (`added`, `promoted`, `removed`, `demoted`), the new role, which copy this is (`subject`, `actor`, `owner`) | a change of owner, to the actor and every other owner, and for a removal or demotion to the person affected — see [[cire-auth]] |
| `wedding-delete-started` | `WeddingDeleteStartedData` — wedding name, who deleted it, the restore deadline, which copy this is (`actor`, `owner`) | an owner deleting a wedding, to every owner — see [[cire-auth]] |
| `vendor-claim-review-pending` | `{ pending, oldestWaitingDays, env }` — counts only, no listing or claimant | the daily cron, to the operator address in `CIRE_OPS_EMAIL` — see [[cire-vendors]] |

`otp-recovery` is the only OTP template sent from an **unauthenticated**
endpoint, which shapes its copy: anyone who knows the address can cause it to
arrive (capped at 3 per 24 h per account), so it reads as something a stranger
may have triggered, says plainly that ignoring it is safe, and names no handle
or display name — the address is the only thing the sender proved they know.

`recovery-used` is the loudest notice in the catalogue: every session on the
account has just been revoked and somebody who is not holding a passkey is
signed in. It deliberately does not say *which* factor was used, so a mailbox an
attacker is reading discloses nothing about the account's other factors.

Adding a template requires three edits in the same PR:
`shared/email/src/templates/index.ts` (union + data map + dispatcher),
a renderer file under `shared/email/src/templates/`, and a branch in
`renderTemplate()`. The compile-time exhaustive-switch check fails
otherwise.

### Resend API wire format (live transport)

```
POST https://api.resend.com/emails
Authorization: Bearer <RESEND_API_KEY>
Content-Type: application/json
{
  "from":    "hello@cireweddings.com",
  "to":      ["user@example.com"],
  "subject": "Verify your OSN email",
  "html":    "...",
  "text":    "...",
  "headers": { "List-Unsubscribe": "<https://…>" }
}
```

`headers` is present only when the template returns some.

### Cloudflare Email API wire format (legacy fallback)

```
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email-service/send
Authorization: Bearer <CLOUDFLARE_EMAIL_API_TOKEN>
Content-Type: application/json
{
  "to":      [{ "email": "user@example.com" }],
  "from":    { "email": "noreply@osn.app" },
  "subject": "Verify your OSN email",
  "text":    "...",
  "html":    "..."
}
```

## Transports

`@shared/email` exposes four Layers + the `EmailService` Tag:

- `makeResendEmailLive(config)` — **preferred** real dispatch. POSTs to
  Resend's HTTP API (`https://api.resend.com/emails`) via
  `instrumentedFetch` so the call becomes a child span. Same render path,
  timeout, metrics, and non-2xx → tagged-failure semantics as the
  Cloudflare transport (429 → `rate_limited`, other non-2xx →
  `dispatch_failed`, fetch reject → `api_unreachable`). The
  `RESEND_API_KEY` is placed only in the `Authorization` header — never in
  a URL, span/metric attribute, or `EmailError.cause`. `config.apiUrl`
  swaps `https://api.resend.com` for a local emulator's origin; anything but
  a loopback origin makes `makeResendEmailLive` throw. A loopback origin is
  `localhost`, `127.0.0.1` or `[::1]` over http or https, or a `*.localhost`
  name over https only, with no credentials, path, query or fragment.
  `resendApiUrlProblem` is that check, exported for callers that want the
  reason instead of a throw.
- `makeCloudflareEmailLive(config)` — legacy real dispatch. POSTs directly
  to Cloudflare's Email Service REST API via `instrumentedFetch` so the
  call becomes a child span.
- `EmailService.sendBatch` (optional) — several emails in as few provider
  calls as the transport allows. Resend implements it as `POST
  https://api.resend.com/emails/batch`, up to 100 emails per call, all or
  nothing; the other transports leave it out and callers loop over `send`.
  cire's RSVP digest uses it so a cron run mails up to 100 organisers for one
  outbound request ([[cire-rsvp-changes]]).
- **Headers.** A renderer may return `headers` beside the subject and bodies;
  the Resend transport sends them on `send` and `sendBatch`, and the
  Cloudflare and log transports drop them. The RSVP digest uses this for
  `List-Unsubscribe` / `List-Unsubscribe-Post`. A renderer strips line breaks
  from any value it puts there, as it does from the subject.
- `makeLogEmailLive()` — dev + test. Renders the template in-process,
  records the payload into an in-memory ring buffer (exposed via
  `recorded()`), emits a single `Effect.logDebug` line with `template`
  + `subject` + `to` — **never** the OTP code. Tests that need to
  assert on captured content read the recorder directly. **Dev/test
  ONLY** — the ring buffer grows unbounded, so it never runs in
  production.
- `makeNoopEmailLive()` — degraded-mode production transport. Renders
  the template (so template bugs still surface as `render_failed`) but
  **DISCARDS** every send — no ring buffer, no network call. Emits one
  redacted `Effect.logWarning` line `email suppressed (degraded mode):
  <template>` containing **only** the bounded `template` literal — never
  the recipient address or OTP code. Selected only via the explicit
  `OSN_EMAIL_OPTIONAL` opt-in (below) so a non-local deploy can run
  WITHOUT a real email provider instead of failing closed. **With Resend
  configured this opt-in is no longer needed** — a future Resend outage
  then fails closed like any normal misconfig.

> Dev-only OTP visibility: the email transport never logs the code, but
> `osn/api`'s auth service has a **separate** `logDevOtp` helper that emits a
> `[dev-otp] <purpose> code=…` debug line for registration / step-up /
> email-change flows. It is gated strictly on `OSN_ENV` being unset or
> `"local"` (returns `Effect.void` otherwise), so the code is never logged in
> staging/production. This makes email-OTP dev flows testable without a real
> inbox. See `osn/api/src/services/auth/helpers.ts`.
>
> **S-L4, fixed 2026-07-30:** the line used to interpolate the **recipient
> address** too. A free-text message is not annotation-shaped, so the
> key-based deny-list in `@shared/observability` never saw it — the env gate
> was the only thing between an OTP recipient and the log sink, and the
> deny-list's own guidance is that it is the second line of defence, not the
> first. The address is dropped rather than annotated, and the `to` parameter
> is gone from the signature so it cannot be reintroduced by accident.

Selection lives in `osn/api/src/lib/email-layer.ts` (`selectEmailLayer`,
shared by the Bun `local.ts` and the Workers `index.ts` entries), in
priority order:

1. `RESEND_API_KEY` present in a non-local env → `ResendEmailLive`
   (**preferred**; wins over Cloudflare creds and the opt-in). Locally the
   recorder is still preferred so dev/test never make a live API call —
   unless `RESEND_API_URL` is set too, which sends to that local emulator
   ([[#Local emulation]]). `RESEND_API_URL` in a non-local env **throws** at
   startup, whatever its value.
2. `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` present →
   `CloudflareEmailLive` (legacy fallback; creds win over the opt-in).
3. Local env (`OSN_ENV` unset/`"local"`) → `LogEmailLive` recorder.
4. Non-local, no real provider, **`OSN_EMAIL_OPTIONAL` truthy** →
   `NoopEmailLive` (degraded boot; loud startup warning naming the mail
   classes that will not be delivered).
5. Non-local, no real provider, opt-in **unset** → **throws** at startup
   (fail-closed default; surfaced as a `503 Worker misconfigured` at the
   Workers edge).

`OSN_EMAIL_OPTIONAL` is a non-secret boolean `[vars]` entry (truthy =
`true`/`1`/`yes`/`on`). It is the *only* way to suppress the non-local
email requirement, so degradation is always explicit and observable —
never silent. It is **not set in any tier's `wrangler.toml`**: `RESEND_API_KEY` is
set on the production osn-api Worker, and the opt-in was removed from
`osn/api/wrangler.toml` in #160 once delivery was confirmed, so email is
required and fails closed again. The escape valve stays in the code for a
future degraded deploy. See [[production-deploy]] §1.1 for the Resend
setup steps.

> **Email is live via Resend** — confirmed delivering from
> `hello@cireweddings.com` on 2026-06-18. `RESEND_API_KEY` on the
> deployed osn-api Worker (`id.musubi.social` since the 2026-07-27 identity
> move — [[musubi-identity-migration]]) carries the full
> transactional surface: OTP step-up codes, email-change OTPs, and
> security-notice emails (recovery codes, passkey added/removed,
> cross-device login) are all delivered again. This **supersedes** the
> earlier degraded-mode note. Direct consequence for **cire**: organiser
> step-up can use the **OTP factor** again (a code mailed via Resend now
> arrives), though **passkey step-up remains preferred** — `StepUpDialog`'s
> `passkeyOnly` flag and the `PasskeysView` Security panel (#155) are the
> primary UX. Cire **guests** are unaffected — their auth is the opaque
> claim-code session ([[cire-auth]]), which never touches email. See
> [[passkey-primary]], [[cire-auth]].

## Configuration

Environment variables for `@osn/api`:

| Variable | Required | Description |
|---|---|---|
| `RESEND_API_KEY` | non-local (preferred) | Resend API key (bearer). Selects `ResendEmailLive`; wins over the Cloudflare vars. `wrangler secret put RESEND_API_KEY`. |
| `CLOUDFLARE_ACCOUNT_ID` | optional / legacy | Cloudflare account ID (fallback transport) |
| `CLOUDFLARE_EMAIL_API_TOKEN` | optional / legacy | API token with Email Send permission (fallback transport) |
| `OSN_EMAIL_FROM` | optional | Verified sender address (default: `noreply@osn.local`; prod: `hello@cireweddings.com`) |
| `RESEND_API_URL` | local only | Origin of a local Resend emulator, e.g. `http://localhost:4008`. Unset ⇒ `https://api.resend.com`. Loopback origins only (a `*.localhost` name needs https). **Never set in a deployed tier**: osn-api refuses to boot with it, the production deploy refuses to run while it exists as a secret, and a test fails if `wrangler.toml` sets it. |

cire-api reads `RESEND_API_KEY` and `RESEND_API_URL` under the same names and
rules (`cire/api/src/lib/resend-email.ts`), but fail-soft, as all its email is:
a refused override leaves no Resend transport and logs `email disabled: Resend
misconfigured` with the reason, and the Worker keeps serving. Its production
deploy refuses to run while `RESEND_API_URL` exists as a secret.

> **The sender stayed on `cireweddings.com` through the identity move.** osn-api
> now serves `id.musubi.social`, but `cireweddings.com` is the only domain verified
> in Resend, and Resend refuses to send from a domain it cannot authenticate — a
> premature switch would fail closed and take **OTP step-up** with it. That is
> exactly the wrong thing to lose right now: after the RP-ID flip invalidated
> every passkey, the way back into an account is recovery-code login **followed
> by an OTP step-up** to enroll a new passkey. Move `OSN_EMAIL_FROM` only after
> verifying a musubi.social sender in Resend (steps 1–2 below, against the new
> domain). See [[musubi-identity-migration]].

Before you deploy (Resend — the live path):

1. Resend dashboard → **Domains → Add Domain** → `cireweddings.com`. Add
   the SPF/DKIM/return-path DNS records Resend displays into the Cloudflare
   DNS zone (the zone is in-account, so this is quick). Wait for
   verification.
2. Create a Resend API key (Sending access).
3. `wrangler secret put RESEND_API_KEY --env production` on osn-api, and set
   `OSN_EMAIL_FROM=hello@cireweddings.com`.
4. Once you have confirmed delivery, remove `OSN_EMAIL_OPTIONAL` so email is
   required/fail-closed again. Done for production in #160. See
   [[production-deploy]] §1.1.

The Cloudflare Email Service path remains available as a fallback (onboard
the sender domain in Cloudflare Email Sending, create an Email-Send token,
set the `CLOUDFLARE_*` vars) but is no longer the live transport.

## Local emulation

Locally, mail can go through the real Resend code path to an emulator you can
read, instead of the in-memory recorder: the Resend service in
[`emulate`](https://github.com/vercel-labs/emulate). It implements
`POST /emails` and `POST /emails/batch` and checks no API key.

1. Start it. It needs Node 24 or later and runs as its own process, not as a
   workspace dependency:

   ```bash
   npx emulate@0.12.1 --service resend --port 4008
   ```

   Keep `--port`: emulate numbers ports from 4000 in the order of the services
   it runs, so `--service resend` alone takes 4000, which is osn-api's port.
2. Give the API both values. The key can be any non-empty string.

   ```bash
   RESEND_API_KEY=re_local
   RESEND_API_URL=http://localhost:4008
   ```

   | API, run as | File |
   |---|---|
   | osn-api, `bun run dev` or `dev:app` | `osn/api/.env` |
   | osn-api, `wrangler dev` | `osn/api/.dev.vars` (`KEY = "value"`) |
   | cire-api, `bun run dev` or `dev:app` | `cire/api/.env` |
   | cire-api, `wrangler dev` | `cire/api/.dev.vars` (`KEY = "value"`) |

   Shell variables do not reach the API under `bun run dev`: turbo hands each
   task only the variables `turbo.json` passes through
   ([[devloop-urls#Running without the proxy]]). Bun reads the package's own
   `.env`, and wrangler its `.dev.vars`; all four files are gitignored.
3. Send something, and read it at `http://localhost:4008/inbox`. In osn-api, a
   registration (`POST /register/begin`) sends its OTP. Every cire mail needs a
   signed-in organiser or osn-api's account lookups, so cire needs the whole
   local stack running.

Under `wrangler dev`, osn-api's per-IP limiters see no client address and
refuse the auth routes: add `TRUSTED_PROXY_COUNT = "1"` to `.dev.vars` and send
an `X-Forwarded-For` header.

Without `RESEND_API_URL`, local osn-api and cire's Bun dev server keep the
in-memory recorder even when a key is set. cire under `wrangler dev` sends
through Resend itself whenever the key is set.

## Security notes

- **Resend API key**: a bearer secret. Placed only in the `Authorization`
  header — never in the URL, span/metric attributes, or `EmailError.cause`.
  The endpoint comes from deployment config, never from request input (no
  SSRF surface): `https://api.resend.com`, or locally an emulator's origin.
  `resendApiUrlProblem` refuses any override that is not a loopback origin,
  and both Workers refuse an override in a deployed tier, so the key and the
  mail never go to another host. A `*.localhost` name must use https: a
  resolver decides where that name goes, and only the certificate check stops
  a wrong answer from receiving the key. The deny-list in `@shared/observability`
  carries `apiKey` and `apiToken`, so a logged transport config shows neither. SPF/DKIM/DMARC are configured on the
  verified Resend sender domain.
- **Cloudflare token (legacy)**: Cloudflare's own API token (scoped to
  Email Send only). SPF/DKIM/DMARC auto-configured by Cloudflare.
- **OTP bodies**: the rendered `text` / `html` contains the OTP digit
  string. The service layer only logs `template`, `subject`, `to` —
  never the rendered body, never `data`. The redaction deny-list
  backstops accidental annotations of the `accessToken` / `cookie` /
  `email` keys, but the primary protection is the call-site contract.
- **Phishing resistance**: email-change uses the "somebody asked for
  this on your account" framing (S-L5) so a misdirected message is
  clearly junk and useless as a phishing template. Live in
  `shared/email/src/templates/otp.ts → renderEmailChangeOtp`.

## Observability

- **Spans** (set on every `send()` invocation):
  - `email.send` (top-level, attrs `{ template }`)
  - `email.render`
  - `email.resend.dispatch` (live transport) / `email.cloudflare.dispatch`
    (legacy fallback)
  - Outbound HTTP becomes a child `HTTP POST` span via
    `@shared/observability/fetch → instrumentedFetch`.
- **Logs**: `Effect.logError("email.dispatch_failed", { template, outcome })`
  on CF failures; `Effect.logWarning("email.rate_limited", { template })`
  on 429. Dev log `[email:log] template=... subject="..." to=...` from
  `LogEmailLive` only (guarded by log level).
- **Metrics** (in `shared/email/src/metrics.ts`):
  - `osn.email.send.attempts` — counter, `{ template: 18 values,
    outcome: sent|failed|rate_limited|skipped }`. Cardinality: 76 series.
  - `osn.email.send.duration` — histogram, same attrs.
  - `osn.email.render.duration` — histogram,
    `{ template, outcome: ok|error }`.
  - `osn.email.dispatch.http_status` — counter,
    `{ template, status_class: 2xx|4xx|5xx|network }`.

No recipient address, no account id, no request id on metric
attributes — bounded literal unions only.

## Rollout

Feature-flagged via `RESEND_API_KEY` (key-optional — absent ⇒ behaviour is
exactly as before this transport landed):

1. **Local / tests**: no key → `LogEmailLive`. Zero behavioural change.
   `bun run test` stays offline (selection ignores a key when local, unless
   `RESEND_API_URL` names a local emulator — [[#Local emulation]]).
2. **Staging / production**: verify the `cireweddings.com` sender domain in
   Resend (SPF/DKIM/return-path records into the Cloudflare DNS zone), create
   a Resend API key, `wrangler secret put RESEND_API_KEY`. Send real mail to a
   synthetic inbox. Watch `osn.email.send.attempts{outcome="sent"}` by
   template, then the `outcome="failed"` rate for 24h.
3. Once you have confirmed delivery, **remove `OSN_EMAIL_OPTIONAL`** so email is
   required/fail-closed again. Done for production in #160.

## Deferred decisions

These are open decision issues in `englishstventures/osn`; the defaults here
are the current code path, not a commitment.

- **Per-recipient rate limit** — defence in depth against OSN bugs
  that would flood a single inbox. Cloudflare Email Service does its
  own account-level enforcement but a per-recipient ceiling is still
  valuable. TBD once we have real send-rate telemetry.
- **Dry-run flag** — `OSN_EMAIL_DRY_RUN` env knob that short-circuits
  before API dispatch. Not implemented yet.
- **HTML vs text-only** — current templates send both. If later
  analysis shows auth flows do not need HTML, we can drop it.
