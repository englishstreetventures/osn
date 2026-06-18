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
  - "[[identity-model]]"
  - "[[step-up]]"
  - "[[passkey-primary]]"
  - "[[recovery-codes]]"
  - "[[observability/overview]]"
packages:
  - "@shared/email"
  - "@osn/api"
last-reviewed: 2026-06-18
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
`https://api.resend.com/emails`. Resend works on workerd over plain HTTP
(no paid Workers plan required), which is why it is preferred over the
Cloudflare Email Service transport. The Cloudflare transport
(`https://api.cloudflare.com/client/v4/accounts/{id}/email-service/send`)
is retained as a legacy fallback. Both render the **same** templates
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
| `recovery-generated`     | `{}`                                | `notifyRecovery("recovery_code_generate")` |
| `recovery-consumed`      | `{}`                                | `notifyRecovery("recovery_code_consume")` |
| `passkey-added`          | `{}`                                | `notifyPasskeyRegisteredByAccountId` |
| `passkey-removed`        | `{}`                                | `notifyPasskeyDeletedByAccountId` |

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
  "text":    "..."
}
```

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
  a URL, span/metric attribute, or `EmailError.cause`.
- `makeCloudflareEmailLive(config)` — legacy real dispatch. POSTs directly
  to Cloudflare's Email Service REST API via `instrumentedFetch` so the
  call becomes a child span.
- `makeLogEmailLive()` — dev + test. Renders the template in-process,
  records the payload into an in-memory ring buffer (exposed via
  `recorded()`), emits a single `Effect.logDebug` line with `template`
  + `subject` + `to` — **never** the OTP code. Tests that need to
  assert on captured content read the recorder directly. **Dev/test
  ONLY** — the ring buffer grows unbounded, so it is never used in
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
> `[dev-otp] … code=…` debug line for registration / step-up / email-change
> flows. It is gated strictly on `OSN_ENV` being unset or `"local"` (returns
> `Effect.void` otherwise), so the code is never logged in staging/production.
> This makes email-OTP dev flows testable without a real inbox. See
> `osn/api/src/services/auth.ts`.

Selection lives in `osn/api/src/lib/email-layer.ts` (`selectEmailLayer`,
shared by the Bun `local.ts` and the Workers `index.ts` entries), in
priority order:

1. `RESEND_API_KEY` present in a non-local env → `ResendEmailLive`
   (**preferred**; wins over Cloudflare creds and the opt-in). Locally the
   recorder is still preferred so dev/test never make a live API call.
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
never silent. **Once `RESEND_API_KEY` is set the opt-in is unnecessary**
and should be removed so email is required/fail-closed again. See
[[production-deploy]] §1.1 for the Resend setup steps.

> **Email is live again via Resend.** Setting `RESEND_API_KEY` on the
> deployed `id.cireweddings.com` osn-api Worker re-enables the full
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

Before deploying (Resend — the live path):

1. Resend dashboard → **Domains → Add Domain** → `cireweddings.com`. Add
   the SPF/DKIM/return-path DNS records Resend displays into the Cloudflare
   DNS zone (the zone is in-account, so this is quick). Wait for
   verification.
2. Create a Resend API key (Sending access).
3. `wrangler secret put RESEND_API_KEY --env production` on osn-api, and set
   `OSN_EMAIL_FROM=hello@cireweddings.com`.
4. Once delivery is confirmed, remove `OSN_EMAIL_OPTIONAL` so email is
   required/fail-closed again. See [[production-deploy]] §1.1.

The Cloudflare Email Service path remains available as a fallback (onboard
the sender domain in Cloudflare Email Sending, create an Email-Send token,
set the `CLOUDFLARE_*` vars) but is no longer the live transport.

## Security notes

- **Resend API key**: a bearer secret. Placed only in the `Authorization`
  header — never in the URL, span/metric attributes, or `EmailError.cause`.
  The hardcoded `https://api.resend.com/emails` endpoint means no
  request-controlled URL (no SSRF surface). SPF/DKIM/DMARC are configured on
  the verified Resend sender domain.
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
  - `osn.email.send.attempts` — counter, `{ template: 7 values,
    outcome: sent|failed|rate_limited|skipped }`. Cardinality: 28 series.
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
   `bun run test` stays offline (selection ignores a key when local).
2. **Staging / production**: verify the `cireweddings.com` sender domain in
   Resend (SPF/DKIM/return-path records into the Cloudflare DNS zone), create
   a Resend API key, `wrangler secret put RESEND_API_KEY`. Send real mail to a
   synthetic inbox. Watch `osn.email.send.attempts{outcome="sent"}` by
   template, then the `outcome="failed"` rate for 24h.
3. Once delivery is confirmed, **remove `OSN_EMAIL_OPTIONAL`** so email is
   required/fail-closed again.

## Deferred decisions

These live in `wiki/TODO.md > Deferred Decisions`; the defaults here
are the current code path, not a commitment.

- **Per-recipient rate limit** — defence in depth against OSN bugs
  that would flood a single inbox. Cloudflare Email Service does its
  own account-level enforcement but a per-recipient ceiling is still
  valuable. TBD once we have real send-rate telemetry.
- **Dry-run flag** — `OSN_EMAIL_DRY_RUN` env knob that short-circuits
  before API dispatch. Not implemented yet.
- **HTML vs text-only** — current templates send both. If downstream
  analysis shows HTML is unnecessary for auth flows, we can drop it.
