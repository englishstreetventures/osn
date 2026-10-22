---
"@tools/pr-metrics": patch
---

Session-metrics cards name the issue their branch was cut for and divide by everything the pull request closes. `card --resolve-issue` takes the issue from the branch's `NEW-FEAT.md` when the pull request links it, else from the first `Closes` line of the body, else from the first `Part of` line, and never from GitHub's list order. `complexity.declared` is now the sum of the ratings of every issue in this repository the pull request closes, with `complexity.issues` counting them; `schema_version` is 2. A pull request that only says `Part of` records `part-of` instead of its issue's rating, and one that closes only a tracker issue records `not-fetched`. Closing keywords in code, comments and tables are not read.

`backfill` compares repositories by the canonical name `gh repo view` gives, so `--repo` under an old owner or another case still reads this repository's issues, and it never replaces a rating already on disk with a missing one. A session that moved into a worktree with `EnterWorktree` now has its earlier records on that branch's card, and the rendered card no longer says "Subagents: none" over subagent spend.
