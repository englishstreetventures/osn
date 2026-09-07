---
"@tools/pr-metrics": minor
---

Add session-performance cards: a per-branch record of what the agent session that produced a pull request cost, what it changed, and how much steering it needed.

`bun run --cwd tools/pr-metrics card` reads Claude Code's own session transcripts, joins them to a branch through the `gitBranch` field every assistant message carries, and writes `.claude/metrics/<branch-slug>.json` — token and cost totals split by model and by main thread versus subagent, active time, the diff bucketed into source, test, docs, config and generated lines, and the interaction shape: user turns, corrective turns, tokens spent before the first edit, edit churn, and the skills and subagents used.

The card holds exactly one scalar judgement, `complexity.declared`, which comes from a human labelling the issue before work starts. Everything else is stored raw, so that a wasteful pull request and a hard debug that ended in a one-line fix stay distinguishable. `wiki/observability/session-metrics.md` carries the schema and the DuckDB queries that read the cards back.
