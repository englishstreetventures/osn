---
"@osn/api": patch
"@osn/db": patch
"@pulse/api": patch
"@pulse/db": patch
"@zap/api": patch
"@zap/db": patch
---

Update Wrangler across Worker and D1 workspaces. Enable unredacted native traces in local and dev Worker tiers, and configure query-string redaction while production and staging trace rollout is gated on live URL checks.
