# @tools/pr-metrics

Builds a **session-performance card** for a branch: what the agent session that
produced a pull request cost, what it changed, and how much steering it needed.
Writes one JSON file per branch to `.claude/metrics/<branch-slug>.json`.

```bash
bun run --cwd tools/pr-metrics card                          # current branch
bun run --cwd tools/pr-metrics card -- --pr 908 --issue 895
bun run --cwd tools/pr-metrics card -- --format markdown     # the PR-body block
bun run --cwd tools/pr-metrics backfill -- --dry-run         # merged PRs, retroactively
bun run --cwd tools/pr-metrics report                        # read the cards back
bun run --cwd tools/pr-metrics report -- --waste             # just one analysis
bun run --cwd tools/pr-metrics report -- --json              # structured, for an agent
```

`report` needs nothing installed and runs in every environment, including a
remote session — which `queries.sql` cannot, since no `duckdb` npm package
ships a binary and a cloud container has no `brew`. SQL stays for ad-hoc local
questions.

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

## Two rules the metrics depend on

**An edit is not only an `Edit` call.** Agents here are told to change files
with `sed`, heredocs and short scripts, so `isFileWritingCommand` counts shell
writes too — conservatively, because a false positive moves the first-edit
boundary too early and under-reports exploration.

**An unobserved boundary is `null`.** A session that never shows an edit banks
nothing and every ranking drops it. Reporting 100% instead once made
`cire/host` look like the worst-mapped package in the repository at 62%; it
reads 5% correctly. "We did not see the boundary" and "all of it was
exploration" are different claims.

And in the reports: **median, never mean.** These distributions are severely
right-skewed — median 3.6M tokens against a mean of 15.4M and a maximum of
92.7M across the first 34 cards.

## Layout

| Path                           | What                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `index.ts`                     | Pure aggregation functions, the `<details>` renderer, and the CLI under `import.meta.main`    |
| `backfill.ts`                  | Cards for pull requests that merged before cards existed                                      |
| `queries.sql`                  | The seven DuckDB queries worth having                                                         |
| `tests/render.test.ts`         | The `<details>` block — including that it contributes no `##` heading                         |
| `tests/pr-metrics.test.ts`     | The pure functions, against synthetic records                                                 |
| `tests/pr-metrics.cli.test.ts` | The real script as a subprocess, against a throwaway git repo and a fake `~/.claude/projects` |

The CLI test earns its keep: subagent spend lives in a
`<session-id>/subagents/*.jsonl` sibling of the main transcript, and a collector
that globs only the top level under-reports every delegated task. No unit test
over pre-parsed records can catch that.
