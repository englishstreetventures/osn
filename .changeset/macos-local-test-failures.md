---
"@cire/invites": patch
"@cire/db": patch
---

Two test suites that failed only on macOS now pass there too. The guest sheet's browser test measures the root's scrollbar gutter in the engine it runs in, which is 0px where scrollbars overlay the page, instead of assuming the gutter narrows the page; the sheet's comments now say an overlay scrollbar has no gutter. `db:generate` resolves the package directory to its real path before making paths relative to the repository root git reports, so a package reached through a link, as under macOS's default temporary directory, no longer fails; cire/db's migration-flow suite gains a case that reaches a package through a link on every platform. No runtime change.
