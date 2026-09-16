---
"@tools/pr-metrics": minor
---

`card` gains two flags for the unattended `SessionEnd` fallback, which runs at the end of every session with no idea what pull request or issue it is describing.

`--if-absent` writes a card only where the branch has none, and exits before reading a single transcript where one already exists. Unguarded, that run overwrote the identity-bearing card with one whose pull request, issue and `complexity.declared` were all null, into a working tree nobody is watching. What counts as present is a card that parses and names this branch, not a file that exists: `JSON.parse` succeeds on a truncated `{"schema_version": 1}`, and the comparison below then read `existing.pr.generated_at` off `undefined` and killed the collector without writing anything.

`--resolve-issue` recovers what the fallback was never told — the branch's pull request, its first linked issue and that issue's `complexity:` label — so a card written before any pull request exists is not null for ever. Labels are read only from an issue in this same repository; one elsewhere records `not-fetched`, which is not `none`, because a rating may well exist there and nobody looked. Explicit `--pr`, `--issue`, `--issue-labels` or `--complexity` all win over the lookup.

`repoRoot` and `git` are memoised. The fallback paid two 8 ms process spawns to reach a guard that costs one file read.
