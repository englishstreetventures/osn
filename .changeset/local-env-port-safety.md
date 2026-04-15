---
"@shared/observability": minor
"@osn/core": patch
"@osn/app": patch
"@osn/ui": patch
"@pulse/api": patch
"@pulse/app": patch
"@zap/api": patch
---

Add four-tier environment model (local/dev/staging/production). Local env gets debug log level and OTP codes printed to terminal; all other environments default to info. Disable SO_REUSEPORT on all servers so stale processes cause EADDRINUSE errors instead of silently intercepting requests. Add email validation message to registration form. Remove Vite devtools plugin.
