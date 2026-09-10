# Archived cire D1 migrations (0001–0057)

These 57 files built the cire schema between 2026-05 and 2026-08. They were
squashed into a single baseline — `../migrations/0001_initial.sql` — on
2026-09-10 (xchromo/osn#981), and moved here.

**Nothing applies them.** `wrangler d1 migrations apply` reads
`migrations_dir` from `cire/api/wrangler.toml`, which points at `../db/migrations`
and not at this directory. Production has all 57 in its `d1_migrations` ledger
already; dev and local build from the baseline.

## Why they are still on disk

Four test files replay them to prove what they did to *data*, not just to
schema — a back-fill that silently changed what a real guest sees is the bug
class they exist for:

| Test | Replays |
|---|---|
| `cire/api/tests/db/migration-0033.test.ts` | the `families` rebuild back to `NOT NULL` |
| `cire/api/tests/db/migration-0041.test.ts` | directory browse |
| `cire/api/tests/db/migration-0044.test.ts` | eight per-section colours → the five-seed scheme |
| `cire/api/tests/db/migration-0052.test.ts` | `event_id` foreign keys, `NO ACTION` → `CASCADE` |

plus the `0031` and `0037` data-migration blocks in `ddl-lockstep.test.ts`.
Each of those reads this directory, not `../migrations`.

## Rules

- **Never add a file here.** New migrations go in `../migrations`, numbered from
  `0058`.
- **Never edit one.** They ran against production; the record is what it is.
- Delete the lot only along with the tests that read it. At that point git
  history is the only copy, which is fine — but say so in the commit.

The drizzle-kit snapshots that used to sit in `../migrations/meta/` went with
them. There were six, for 57 entries, and the newest was missing, so they could
not regenerate anything. Git history has them if they are ever wanted.
