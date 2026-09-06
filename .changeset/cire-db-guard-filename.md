---
"@cire/db": patch
---

Correct the dev-database guard's filename in `cire/db`'s README.

The two destructive dev scripts route through `scripts/cire-dev-db-guard.ts`.
The README still named it `cire-dev-db-guard.sh`, the name it had before the
hand-rolled awk TOML parser was replaced, so a reader checking what guards a
`db:reset:dev` found no such file.
