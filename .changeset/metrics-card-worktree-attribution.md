---
"@tools/pr-metrics": patch
---

Fix session-metrics cards missing spend for a `new-feat`/`stress-plan`/`prep-pr`
session run from the `main` worktree (#1156). Two gaps: `stress-plan` and
`prep-pr`'s dispatch prompts never carried the `TASK-BRANCH:` marker
`orchestrate`'s does, so their subagents' spend went to no card; and the
dispatching session's own main-thread spend stayed stamped `main` forever,
because it plans and delegates without ever `cd`-ing into the task worktree
itself, so `record.cwd` never moves either.

`stress-plan`, `prep-pr` and `new-feat`'s `Plan`-subagent dispatch now write
the marker. A new `resolveSessionBranch` in `tools/pr-metrics/index.ts` scans
a session file's own `worktree add … -b <branch>` / `checkout -B <branch>`
Bash commands and resolves to the single branch it cut (`null` on more than
one — an `orchestrate` session driving several tasks). Both readers use it as
a fallback for any record whose own `gitBranch` is absent, `main` or `HEAD`,
and `resolveDispatchBranch` uses the same signal to resolve an unmarked
subagent dispatch whose parent is the session file itself — closing the gap
retroactively for transcripts already on disk, not just new ones.

Verified against the real transcripts behind PR #1155's card
(`.claude/metrics/chore-pinterest-fallback-on-failure.json`, previously $0.78 /
12 messages / 0 subagent spend): the fix recovers 793 of that branch's session
records, up from 12.
