---
"@musubi/social": minor
"@musubi/landing": minor
"@shared/dev-urls": patch
"@shared/toast": patch
"@osn/api": patch
"@osn/ui": patch
"@osn/client": patch
"@zap/api": patch
"@tools/lab": patch
"@tools/metrics": patch
---

Separate OSN, the system, from Musubi, our implementation of it.

OSN is now the headless core — identity, the social graph, authorisation and
the OpenID Connect issuer — with no user interface, runnable by anyone for
their own private social graph. Musubi is our implementation and the product
built on it: the social app, its marketing site, the brand, and the
`musubi.social` instance we host.

`@osn/social` becomes `@musubi/social` and `@osn/landing` becomes
`@musubi/landing`, both moving to a new top-level `musubi/` workspace
directory. The backend packages, `@osn/ui`, the shared packages and every
wire-level identifier — the `osn-access` and `osn-step-up` token audiences,
`/.well-known/jwks.json`, claim names, the pairwise subject derivation and the
ARC token format — keep the OSN name, because an independent implementation has
to match them to interoperate. That is the rule the split now runs on: if
another implementation must use the same string, it is OSN; otherwise it is
Musubi.

The remaining packages change only in the references they carry. Two of them
were resolving the moved package by filesystem path rather than by package name
— `tools/lab/src/lab.css` and `tools/metrics/src/metrics.css` both `@import`
the social app's stylesheet — and would have failed to build without the
update.

Two repository guards learned about the new directory: `fmt` and `fmt:check`
hardcode the list of workspace directories oxfmt walks, and
`scripts/validate-changesets.sh` builds its known-workspace-name set from a
hardcoded `find`. Neither would have reported anything unusual; the format
check would simply have stopped covering two packages.

Cloudflare Pages project names (`osn-social`, `osn-social-dev`, `osn-landing`)
are deliberately unchanged — renaming a Pages project attached to a live apex
is a deploy operation, not a rename.
