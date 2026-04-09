---
"@osn/core": minor
"@pulse/api": patch
"@shared/observability": patch
---

Auth security hardening: per-IP rate limiting on all auth endpoints (S-H1), redirect URI allowlist validation (S-H3), mandatory PKCE at /token (S-H4), legacy unauth'd passkey path removed (S-H5), login OTP attempt limit + unbiased generation + timing-safe comparison (S-M7/M24/M25), dev-log NODE_ENV gating (S-M22), console.* replaced with Effect.logError. Oxlint no-new warning fixed in @pulse/api. AuthRateLimitedEndpoint type added to @shared/observability.
