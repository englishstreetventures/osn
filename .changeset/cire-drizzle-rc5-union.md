---
"@cire/api": patch
"@cire/db": patch
"@tools/e2e": patch
---

Bump drizzle-orm to 1.0.0-rc.5. rc.5 qualifies the columns of a `UNION ALL`
that is ordered or limited, and those queries then failed on the gift log, gift
export and registry. The union members now alias each column by its database
name, so the wrapper refers to names it exposes.
