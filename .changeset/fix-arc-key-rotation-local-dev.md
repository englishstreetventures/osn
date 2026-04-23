---
"@pulse/api": patch
---

Allow `pulse-api` to boot in local dev when `INTERNAL_SERVICE_SECRET` is unset. Registration is skipped with a warning log; S2S calls to `osn/api` will fail until the secret is configured. Non-local environments (`OSN_ENV != "local"`) still throw on startup as before.
