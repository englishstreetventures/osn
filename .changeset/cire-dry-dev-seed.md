---
"@cire/db": patch
"@cire/api": patch
---

DRY the cire dev seed: a single canonical source replaces the hand-mirrored
JSON fixtures + hand-written SQL.

Previously the local-D1 dev seed (`cire/db/seed/dev-seed.sql`) and the test
fixtures (`cire/api/src/data/{events,guests}.json`) were two hand-maintained
copies of the same sample-wedding data that could silently drift.

- `@cire/db`: new canonical seed data under `cire/db/seed/data/` (`events.ts`,
  `guests.ts`, `wedding.ts`), re-exported as `@cire/db/seed` — the single source
  of truth. `cire/db/seed/generate.ts` (`bun run --cwd cire/db seed:generate`)
  **derives** `dev-seed.sql` from it, and `cire/db/seed/seed.test.ts`
  regenerates in memory and fails CI if the committed SQL drifts.
- `@cire/api`: `src/db/setup.ts#seedDb` now imports the canonical data from
  `@cire/db/seed` (and re-exports `DEV_OWNER_PROFILE_ID` from there); the five
  route/service tests that read `../data/events.json` now import `@cire/db/seed`.
  The old JSON fixtures are deleted.

Seed VALUES are byte-identical to before — the seeded test state is unchanged.
