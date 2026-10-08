---
"@cire/api": patch
---

cire-api reads `RESEND_API_URL` to send mail to a local Resend emulator, under the same loopback-only rule as osn-api. A deployed tier refuses the variable: the Worker keeps serving, sends no Resend mail, and logs `email disabled: Resend misconfigured` with the reason. In `fetch` that happens once per isolate build, and in the cron after the last sweep. The Bun dev server sends to the emulator only when `RESEND_API_KEY` and `RESEND_API_URL` are both set, and refuses to start with a bad override (`localResendConfig`). The production deploy refuses to run while `RESEND_API_URL` exists as a secret, and a test fails if `wrangler.toml` sets it in any tier. The four Resend call sites share one config helper, `lib/resend-email.ts`.
