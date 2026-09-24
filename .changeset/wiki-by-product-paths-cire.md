---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/ui": patch
"@tools/pr-metrics": patch
---

Point code comments at the wiki's new layout: one folder per product and
`shared/` for what applies to all of them. Cire's pages now live in
`wiki/cire/`, so `wiki/systems/cire-auth.md` now reads
`wiki/cire/cire-auth.md`, and the session-metrics page moved to
`wiki/conventions/`. Comments only; no behaviour changes.
