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
  │ @osn/api services    │        │  @shared/email       │        │ Cloudflare Email       │
  │ auth.ts call sites:  │ calls  │  EmailService (Tag)  │ Bearer │ Service REST API       │
  │  beginRegistration   ├───────▶│  CloudflareEmailLive ├───────▶│  /email-service/send   │
  │  beginStepUpOtp      │ Effect │  LogEmailLive (dev)  │  JSON  │                        │
  │  beginEmailChange    │        │                      │        │  Cloudflare DKIM-signs  │
  │  notifyRecovery      │        │  renderTemplate()    │        │  via verified domain    │
  │  notifyPasskey*      │        │                      │        │                        │
  └──────────────────────┘        └──────────────────────┘        └────────────────────────┘
```

Dispatch uses Cloudflare's **Email Service REST API** directly. No
intermediate Worker, no ARC tokens — a single bearer-authed HTTPS
call to `https://api.cloudflare.com/client/v4/accounts/{id}/email-service/send`.
Cloudflare handles DKIM-signing via the verified-domain configuration
in the dashboard.

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

### Cloudflare Email API wire format

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

`@shared/email` exposes three Layers + the `EmailService` Tag:

- `makeCloudflareEmailLive(config)` — real dispatch. POSTs directly to
  Cloudflare's Email Service REST API via `instrumentedFetch` so the
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
  WITHOUT Cloudflare email instead of failing closed.

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

1. `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` present →
   `CloudflareEmailLive` (**creds always win**, even if the opt-in is set).
2. Local env (`OSN_ENV` unset/`"local"`) → `LogEmailLive` recorder.
3. Non-local, creds absent, **`OSN_EMAIL_OPTIONAL` truthy** →
   `NoopEmailLive` (degraded boot; loud startup warning naming the mail
   classes that will not be delivered).
4. Non-local, creds absent, opt-in **unset** → **throws** at startup
   (fail-closed default; surfaced as a `503 Worker misconfigured` at the
   Workers edge).

`OSN_EMAIL_OPTIONAL` is a non-secret boolean `[vars]` entry (truthy =
`true`/`1`/`yes`/`on`). It is the *only* way to suppress the non-local
email requirement, so degradation is always explicit and observable —
never silent. See [[production-deploy]] §1.1 for the deploy-time caveats
(OTP step-up, email-change OTP, and security-notice emails are not
delivered while degraded; passkey login is primary and unaffected).

> **Live in prod (2026-06-18):** `OSN_EMAIL_OPTIONAL=true` is set on the
> deployed `id.cireweddings.com` osn-api Worker — no Cloudflare Email
> Service creds are provisioned yet, so the stack runs in degraded mode.
> Direct consequence for **cire**: organiser step-up is **passkey-only**
> (`StepUpDialog`'s `passkeyOnly` flag, the `PasskeysView` Security panel
> from #155) because the OTP step-up factor would mail a code that never
> arrives. Cire **guests** are unaffected — their auth is the opaque
> claim-code session ([[cire-auth]]), which never touches email. Re-enabling
> email (provision the `CLOUDFLARE_*` creds, then drop the opt-in) restores
> OTP step-up everywhere — see [[passkey-primary]], [[cire-auth]].

## Configuration

Environment variables for `@osn/api`:

| Variable | Required | Description |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | non-local | Cloudflare account ID |
| `CLOUDFLARE_EMAIL_API_TOKEN` | non-local | API token with Email Send permission |
| `OSN_EMAIL_FROM` | optional | Verified sender address (default: `noreply@osn.local`) |

Before deploying:

1. Cloudflare dashboard → **Email Sending → Onboard Domain**. Choose the
   domain that will appear in `From:`. Add the DNS records Cloudflare
   displays (MX for bounce handling, TXT for SPF/DMARC). Wait for
   verification.
2. Create an API token with Email Send permission for the account.
3. Set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN`, and
   `OSN_EMAIL_FROM` in the deployment environment.

## Security notes

- **No third-party API key**: uses Cloudflare's own API token (scoped
  to Email Send only). SPF/DKIM/DMARC auto-configured by Cloudflare.
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
  - `email.cloudflare.dispatch`
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

Feature-flagged via `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN`:

1. **Local / tests**: env unset → `LogEmailLive`. Zero behavioural
   change from today. `bun run test` stays offline.
2. **Staging**: onboard the sender domain in Cloudflare Email Sending,
   create an API token, set the env vars on staging pods only.
   Send real mail to a synthetic inbox. Watch the
   `osn.email.send.attempts{outcome="sent"}` panel by template.
3. **Production**: flip the env vars in prod secrets. No code change.
   Watch the `outcome="failed"` rate for 24h.

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
