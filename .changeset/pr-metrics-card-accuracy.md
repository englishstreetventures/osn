---
"@tools/pr-metrics": patch
---

Session-metrics cards read the right issue, transcripts and diff. A card takes
the issue a pull request links in this repository, and records none when the
pull request links only another repository's issue or several issues it cannot
tell apart. A `Part of` link is rated only when the pull request closes nothing.
It reads transcripts from `CLAUDE_CONFIG_DIR` as well as
`~/.claude/projects`, counts Workflow-tool agents as subagent spend, and diffs a
stacked branch against its parent. A bare "continue" no longer counts as a
corrective turn, and a subagent hand-back that opens with prose is not a human
turn. Renamed directories and top-level files no longer invent packages, and
`musubi/` counts as a workspace.
