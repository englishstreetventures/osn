---
"@shared/db-utils": minor
---

Add Effect-native drizzle layers: `@shared/db-utils/effect/d1` for D1 (prepared-statement cache off, so every read picks its session) and `@shared/db-utils/effect/sqlite` for bun:sqlite (foreign keys on, WAL off, and `changesAfterWrite` for the change count of a write). `driverErrorText` now also reads the errors inside an Effect `Cause`.
