---
"@shared/observability": patch
"@osn/core": patch
---

Default log level to debug in dev environment so OTP codes and magic-link URLs are visible without manual OSN_LOG_LEVEL configuration. Tighten OTP/magic-link debug guard from NODE_ENV to OSN_ENV so staging is also excluded.
