---
"@shared/db-utils": patch
"@shared/osn-auth-client": patch
"@shared/rp-auth": patch
"@pulse/api": patch
---

Dependency review: drop unused `better-sqlite3`, align stale peer ranges, bump oxfmt

- `@shared/db-utils` no longer declares `better-sqlite3` or `@types/better-sqlite3`.
  Neither was imported by `src/` or `tests/` — the package has no drizzle-kit and no
  `db:*` scripts, so nothing there ever loaded the native module. The three `*/db`
  workspaces that do run drizzle-kit against a local SQLite file — `osn/db`,
  `pulse/db`, `zap/db` — keep theirs.
- `@shared/osn-auth-client` peer `elysia` `^1.4.28` → `^1.4.29`, matching the range
  every other workspace declares.
- `@shared/rp-auth` peer `solid-js` `^1.9.13` → `^1.9.14`, likewise. Both peers already
  resolved to the same version; this only stops the ranges drifting further apart.
- Root `oxfmt` `^0.59.0` → `^0.62.0`. 0.62.0 changes how a type-annotated arrow return
  is wrapped, which reformats one file in `@pulse/api`
  (`src/services/events.ts`) — whitespace only, no behaviour change.
- `fast-uri` dropped from `minimumReleaseAgeExcludes` in `bunfig.toml`. It was added
  for the GHSA-v2hh-gcrm-f6hx fix in 3.1.4, which shipped inside the 3-day install
  gate. The override now pins `^3.1.5` and 3.1.5 shipped 2026-07-31, so the entry
  had stopped protecting anything and was exempting every future 3.x publish.
