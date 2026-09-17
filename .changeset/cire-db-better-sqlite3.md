---
"@cire/db": patch
---

Declare `better-sqlite3` and `@types/better-sqlite3` in `devDependencies`, at
the same ranges `osn/db`, `pulse/db` and `zap/db` already use. `db:studio`
resolved them only because drizzle-kit found the packages hoisted into the
shared store by those three workspaces — a phantom dependency that would
break under an isolated linker (xchromo/osn#750).
