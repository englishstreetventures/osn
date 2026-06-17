---
"@cire/db": patch
"@cire/api": patch
---

Renumber the duplicate `0011` cire migration so each migration has a unique
numeric prefix.

`cire/db/migrations` had two files numbered `0011` — `0011_dietary_consent.sql`
(consent columns on `rsvps`) and `0011_wedding_code_style.sql` (the `code_style`
column on `weddings`) — authored off the same base and merged separately.
`wrangler d1 migrations apply` orders files lexically and tracks each by full
filename, so duplicate prefixes are a latent ordering/tooling hazard rather than
an outright failure. The dietary one is renumbered to
`0012_dietary_consent.sql`, keeping `0011_wedding_code_style.sql` (the one
already mirrored in the schema DDL) at `0011`.

Pure rename, safe pre-deploy: the prod `cire-db` D1 has never had migrations
applied, so no environment has recorded either filename yet. The two ALTERs are
independent (different tables, no interdependency), and a clean local apply from
scratch runs all migrations in order `0011_wedding_code_style` →
`0012_dietary_consent` with no conflict.
