---
"@shared/db-utils": patch
"@shared/crypto": patch
"@osn/api": patch
"@osn/db": patch
"@pulse/api": patch
"@pulse/db": patch
"@zap/api": patch
"@zap/db": patch
---

Move the monorepo's drizzle-orm from 1.0.0-rc.4 to 1.0.0-rc.5 and drizzle-kit to
1.0.0-rc.5 in the db packages. The repository patch that keeps bound values out
of drizzle's errors and logs is ported to rc.5 and now also drops `params` from
the Effect query error's JSON.
