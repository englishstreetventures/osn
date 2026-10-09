---
"@shared/email": minor
"@osn/api": minor
"@shared/observability": patch
---

The Resend transport can send to a local Resend emulator instead of Resend. `ResendEmailConfig.apiUrl` replaces `https://api.resend.com` with an emulator's origin. It accepts only a loopback origin with no credentials, path, query or fragment: `localhost`, `127.0.0.1` or `[::1]` over http or https, or a `*.localhost` name over https only, since a resolver decides where such a name goes. `makeResendEmailLive` throws on anything else. `resendApiUrlProblem` exports that check. Unset or blank keeps Resend's own origin.

osn-api reads it from `RESEND_API_URL`. Locally, with `RESEND_API_KEY` also set, mail goes through the Resend transport to that emulator instead of the in-memory recorder. In a non-local env, osn-api refuses to boot while the variable holds any non-blank value, and the production deploy refuses to run while it exists as a secret. The email sections of `.env.example` and `.dev.vars.example` now describe Resend first.

The log redaction deny-list gains `apiKey` and `apiToken`, the bearer fields of the Resend and Cloudflare email transport configs, so a logged transport config never shows its key.
