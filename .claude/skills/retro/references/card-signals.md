# Card signals — what each field can and cannot support

Read with Step 2 of `SKILL.md`. Each row is a field, the one question it
answers, and the shape of a finding it can justify. The last column is the trap
— the reading that looks obvious and is wrong.

`wiki/observability/session-metrics.md` holds the schema and the reasoning; this
file is only about what a **single** card licenses you to say.

## Spend

| Field | Answers | A finding it supports | The trap |
|---|---|---|---|
| `spend.usd_equivalent` | What the session cost, as a unit of effort comparable across models | Nothing on its own | It is not money. This work runs on a subscription; the figure is a normalised effort unit, and quoting it as a bill is wrong in both directions |
| `spend.usd_equivalent ÷ complexity.declared` | Whether cost and declared difficulty agree | "A `complexity:1` issue cost $40 — the brief or the map was missing something" | A `null` here means this card did not fetch a rating, not that none exists. Read the issue's `complexity:` label and use that. Only an issue carrying no such label is genuinely unrated, and only then does the ratio not exist |
| `spend.by_model` | Which model did the work | "A mechanical rename ran entirely on the expensive model" → `pick-agent` | Model choice is set by the agent definition's frontmatter, so the fix is a `.claude/agents/*.md` file, not an instruction in prose |
| `spend.by_actor` | Whether delegation happened and what it cost | "A cross-package task delegated nothing and hit a compaction" | `subagent: 0` also reads that way when the `TASK-BRANCH:` marker was missing from a dispatch — check `orchestrate`'s Step 3 before concluding no delegation happened |
| `spend.tokens.cache_read` as a share | How wide the loaded context was | Nothing from one card | A share rising *across* cards is the real signal, and that is `analyse-sessions` |
| `spend.unpriced_models` | Whether a model priced at zero | "The rate table is missing `<model>`" → an issue against `tools/pr-metrics` | A non-empty list means the spend figure is an **under**-count; do not compare that card to others until it is fixed |

## Interaction

| Field | Answers | A finding it supports | The trap |
|---|---|---|---|
| `corrective_turns` | How much steering the brief needed after work started | "The task did not say which of the two config readers to change; three turns went on that" — a **prompt** finding | This measures the person who wrote the brief. It is the one number here that is not about the model, and it is worthless if softened |
| `user_turns` | Total human turns | Context for the above | A long collaborative session is not a badly briefed one. The ratio of corrective to total is what carries meaning |
| `tokens_before_first_edit` | Exploration before the first change | "No wiki page exists for the surface this touched" | `null` means **no edit was observed**, not that everything was exploration. A card with `sessions_with_observed_edit: 0` supports nothing here and must be dropped, not rounded to 100% |
| `edit_churn.max_edits_one_file` | Building, or lost | "Eleven edits to one file — its shape does not fit in one reading" | A file under active TDD churns legitimately. Check what the edits were before calling it confusion |
| `edit_churn.files_edited_3plus` | How wide the rework was | Same as above, across files | — |
| `tool_calls` | What the session actually did | "Forty `Grep` calls and four `Read`s — the thing being looked for had no obvious home" | Shell writes count as edits here by design; a low `Edit` count does not mean little was changed |
| `skills` | Which skills ran | "`stress-plan` never ran on a plan that touched a Worker binding" → a `new-feat` gap | An empty map is also what a session that predates a skill looks like |
| `subagents` | Which agents ran | "`review-tests` ran and the gap it exists to catch shipped anyway" → that `SKILL.md` | — |

## Window

| Field | Answers | A finding it supports | The trap |
|---|---|---|---|
| `window.compactions` | Whether the context ran out | "A one-package task compacted — something loaded that the task did not need" | Compaction on a genuinely cross-cutting task is the system working, not a defect |
| `window.sessions` | How many restarts | Nothing on its own | Session count tracks cost almost perfectly, and harder work legitimately takes more sessions. The discriminator is whether the restarts were *forced* — cross it with `compactions` |
| `active_seconds` vs `span_seconds` | How much of the wall clock was work | Rarely actionable | A long span with little active time is usually a person's lunch |

## Diff

| Field | Answers | A finding it supports | The trap |
|---|---|---|---|
| `diff.files` / `diff.loc` by bucket | Where the change landed | "Source changed, `test` bucket is zero" → a `review-tests` gap that got through | Buckets are separated precisely so they are never averaged together. A docs-heavy PR is not a large PR |
| `diff.packages` | Which surfaces were touched | "Three packages for what the issue called a one-file change" → the issue's rating, or its scope | — |
| `touches_migration` | Whether schema moved | Raises the bar on everything else — a migration PR with no D1 tier test is a finding | — |

## Identity

| Field | Answers | A finding it supports | The trap |
|---|---|---|---|
| `complexity.declared` + `.method` | What was declared, and by whom | `method: "unconfirmed"` on work that turned out to be an 8 → get the rating confirmed next time | `"not-fetched"` is **not** a missing rating. It means the issue lives in the private tracker and its labels were deliberately not fetched into a public card. Never file that as a gap |
| `pr.phase` | `at-open` or `at-merge` | Nothing | An `at-open` card has not seen review-cycle cost. Do not conclude a session was cheap from one |
| `pr.number: null` | The `SessionEnd` fallback wrote this card, before a pull request existed | Step 1 fills the identity in | Only the identity is missing. The spend and interaction numbers are as trustworthy as any other card's, and stay usable when Step 1 cannot run |
