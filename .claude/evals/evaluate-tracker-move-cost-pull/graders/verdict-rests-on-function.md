---
type: llm
weight: 4
focus: { source: file, path: EVALUATION.md }
---

The file is an evaluation of moving issue tracking from GitHub Issues to Jira, with the code staying on GitHub. The facts given: about 1,430 issues across two repositories growing about 120 a week, 205 `gh` call sites in 69 files, four skills that use the Projects board, one seat, five products. There is no planted right verdict: staying, moving or a mix can all pass.

PASS if the recommendation's main stated reason is about what each option lets the project do — planning depth, holding private and public issues in one place, agent tooling, how the skills work — and not about how much the move costs.

FAIL if the verdict rests on migration cost, effort or issue count, or if function is compared but the verdict is then decided by migration effort while the functional case is not shown to be close.

FAIL also if the file is missing or empty.
