---
"@osn/api": patch
---

ops: email is now required in prod (Resend delivery confirmed from hello@cireweddings.com) — removed the `OSN_EMAIL_OPTIONAL` degraded opt-in from osn-api's production vars, so osn-api fails closed at startup if `RESEND_API_KEY` is ever absent rather than silently dropping OTP/security mail. Also activated the Cloudflare Turnstile sitekey in the cire/web + cire/organiser Pages builds (`deploy.yml`), reading the `PUBLIC_TURNSTILE_SITEKEY` repo Variable; the matching `TURNSTILE_SECRET_KEY` is set on the osn-api + cire-api Workers (sitekey-first rollout so the gate never blocks before the widget is live).
