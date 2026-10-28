---
type: llm
weight: 2
focus: { source: file, path: EVALUATION.md }
---

The file evaluates moving issue tracking from GitHub Issues to Jira. The facts say issues grow by about 120 a week and the `gh` call sites in the skills grow with them.

PASS if it addresses a one-to-three-year horizon, states that the cost of switching grows with time, and draws the consequence: move sooner if the move is right, or explain why the growth does not change the answer.

FAIL if it treats today's migration cost as fixed, or mentions the horizon without the growth point.
