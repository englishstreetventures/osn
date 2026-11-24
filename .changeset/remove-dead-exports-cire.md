---
"@cire/api": patch
---

The organiser auth middleware imports `OsnAuthOptions` from the root of `@shared/osn-auth-client`, which no longer publishes the `./middleware/elysia` path it came from. No behaviour changes.
