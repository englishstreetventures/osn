---
"@tools/pr-metrics": minor
---

Make cards work from remote sessions: a `report` command that needs nothing installed, a `SessionEnd` hook that writes the card in any environment, and a `merged` view that no longer excludes remote work.

`bun run --cwd tools/pr-metrics report` computes the seven analyses over the committed cards in TypeScript. DuckDB does not exist in a remote session — none of the `duckdb` npm packages ship a binary, and a cloud container has no `brew` — so a report that only ran under `queries.sql` could only ever describe one laptop. The SQL stays as the optional local tool for questions nobody anticipated; both carry the same ratio definitions.

A `SessionEnd` hook in `.claude/settings.json` writes the card at the end of every session. A remote container is destroyed when its session ends and takes its transcripts with it, so a card that was never written is gone for good; the hook removes the dependency on anyone reaching `prep-pr`. It is idempotent, already refuses `main`, and ends in `|| true` so it can never fail a session.

The `merged` view now filters on merge status rather than `phase = 'at-merge'`. A remote card can never be refreshed past `at-open`, so the old filter would have silently dropped every pull request not worked on a machine you still own — biasing every trend toward local work while looking like caution. `phase` is a visible column instead, and the coverage query reports the split.
