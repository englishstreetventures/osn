---
"@cire/api": patch
"@cire/db": patch
---

Move every Effect dependency to 4.0.0-rc.112 and convert the service keys.

`DbService`, `AssetsR2Service` and `R2Service` move from `Context.Tag` to
`Context.Service<Self, Shape>()(id)`, keeping their identifier strings. Call
sites are untouched — a v4 service key still extends `Effect`.

First phase of the Effect v4 migration; the tree does not type-check until the
`Schema` work lands.
