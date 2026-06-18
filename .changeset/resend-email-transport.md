---
"@shared/email": minor
"@osn/api": minor
---

Add Resend as osn-api's preferred transactional-email transport.

`@shared/email` gains `ResendEmailLive` (`makeResendEmailLive`) — POSTs to Resend's HTTP API (`https://api.resend.com/emails`, bearer-authed), works on workerd with no paid Workers plan. It reuses the exact template/render path of `CloudflareEmailLive` and matches its instrumented-fetch, span, metric, and non-2xx → tagged-failure semantics (429 → `rate_limited`, other non-2xx → `dispatch_failed`, fetch reject → `api_unreachable`). The `RESEND_API_KEY` is placed only in the `Authorization` header — never in a URL, span/metric attribute, log, or `EmailError.cause`.

`osn/api`'s `selectEmailLayer` now prefers Resend: precedence is **Resend → Cloudflare (legacy fallback) → local Log → `OSN_EMAIL_OPTIONAL` Noop → throw**. `RESEND_API_KEY` is added to the Worker `Env` type. Key-optional / non-breaking: with no key, behaviour is exactly as before. With Resend configured, `OSN_EMAIL_OPTIONAL` is no longer needed (a future Resend outage then fails closed like any normal misconfig).
