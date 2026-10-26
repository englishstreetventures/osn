---
"@shared/db-utils": minor
---

Add an Effect-native drizzle layer: `@shared/db-utils/effect/d1` for D1 (prepared-statement cache off, so every read picks its session). `@shared/db-utils/effect/batch` adds `commitEffectWrites`, an atomic write set on D1 that takes the database handle and goes out as one `D1Client.batch`. `driverErrorText` now also reads the errors inside an Effect `Cause`.
