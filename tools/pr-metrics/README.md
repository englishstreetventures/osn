# @tools/pr-metrics

Builds a **session-performance card** for a branch: what the agent session that
produced a pull request cost, what it changed, and how much steering it needed.
Writes one JSON file per branch to `.claude/metrics/<branch-slug>.json`.

```bash
bun run --cwd tools/pr-metrics card                        # current branch
bun run --cwd tools/pr-metrics card -- --pr 908 --issue 895
```

| Flag                                                | Default                        |
| --------------------------------------------------- | ------------------------------ |
| `--branch`                                          | Current branch. Refuses `main` |
| `--base`                                            | `origin/main`                  |
| `--sessions-dir`                                    | `~/.claude/projects`           |
| `--out-dir`                                         | `.claude/metrics`              |
| `--pr`, `--issue`, `--issue-type`, `--issue-labels` | Unset                          |
| `--complexity`, `--complexity-method`               | Unset                          |
| `--phase`                                           | `at-open`                      |

## Read this before changing it

**`wiki/observability/session-metrics.md`** is the reference: the field-by-field
schema, why the card holds exactly one scalar judgement, the two fields that
name a cause rather than a cost, and the DuckDB queries that read the cards back.
(In Obsidian: [[session-metrics]].)

The one rule worth repeating here, because it is the thing most likely to get
broken by a well-meaning change: **do not add a computed complexity score.**
`complexity.declared` comes from a human labelling the issue before work starts,
and it is the only judgement in the file. Everything else is raw. A score
blended from diff size cannot separate a wasteful PR from a hard debug that
ended in a one-line fix, and folding the two together makes the metric punish
the hardest legitimate work in the repository.

## Layout

| Path                           | What                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `index.ts`                     | Pure aggregation functions, plus the CLI under `import.meta.main`                             |
| `tests/pr-metrics.test.ts`     | The pure functions, against synthetic records                                                 |
| `tests/pr-metrics.cli.test.ts` | The real script as a subprocess, against a throwaway git repo and a fake `~/.claude/projects` |

The CLI test earns its keep: subagent spend lives in a
`<session-id>/subagents/*.jsonl` sibling of the main transcript, and a collector
that globs only the top level under-reports every delegated task. No unit test
over pre-parsed records can catch that.
