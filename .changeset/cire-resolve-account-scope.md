---
"@cire/api": patch
---

Account-link bridge now mints its `GET /graph/internal/profile-account` ARC token with the dedicated `graph:resolve-account` scope (S-M1 pulse-onboarding least-privilege change on osn-api). Requires the cire-api service registration to carry `allowedScopes: "graph:read,graph:resolve-account"` — see the production-deploy runbook §6.
