---
"@cire/db": patch
---

Run the dev asset seed's wrangler upload through `Bun.$` instead of a
hand-rolled `Bun.spawn`. Same command, same failure message; the stream
draining and exit-code plumbing go.

Repo-wide alongside it: `bun-types` moves to 1.4.0 to match the 1.4.0 runtime
`.bun-version` has pinned since the portless devloop, and the D1 placeholder
guard now parses `wrangler.toml` with `Bun.TOML` rather than grepping it —
which lets it catch a named environment with no `[[d1_databases]]` block, a
shape no grep could see.
