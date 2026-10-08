---
"@shared/email": minor
"@osn/api": minor
---

The Resend transport can send to a local Resend emulator instead of Resend. `ResendEmailConfig.apiUrl` replaces `https://api.resend.com` with an emulator's origin. It accepts only a loopback origin (`localhost`, `*.localhost`, `127.0.0.1` or `[::1]`, with no credentials, path, query or fragment), and `makeResendEmailLive` throws on anything else. `resendApiUrlProblem` exports that check. Unset or blank keeps Resend's own origin.

osn-api reads it from `RESEND_API_URL`. Locally, with `RESEND_API_KEY` also set, mail goes through the Resend transport to that emulator instead of the in-memory recorder. In a non-local env, osn-api refuses to boot while the variable is set, whatever its value, and the production deploy refuses to run while it exists as a secret. The email sections of `.env.example` and `.dev.vars.example` now describe Resend first.
