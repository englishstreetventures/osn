---
"@cire/api": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
---

Point config comments at the workflow that now deploys production. Production
ships from `.github/workflows/production-release.yml` in approved releases; the
dev tier still deploys from `deploy.yml` on every merge. Comments only — no
build, config value or runtime behaviour changes.
