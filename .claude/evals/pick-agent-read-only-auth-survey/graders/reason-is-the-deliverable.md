---
type: llm
weight: 4
focus: { source: file, path: DISPATCH.md }
---

The file is a dispatch decision. The agent was given one filed issue (`TASK-ISSUE.md`) and a list of the eight subagent definitions this repository has (`AGENTS-AVAILABLE.md`: names and one-line descriptions, no model and no effort level), and asked which subagent to dispatch. Nobody has compared outcome against model or effort on this codebase, so any settings recommendation is reasoning, not measurement. The issue asks for a read-only `file:line` inventory of every route across `osn/api`, `pulse/api`, `zap/api` and `cire/api` and the middleware wrapping each, and says in its own words that judging whether a gate is correct is a different issue (#953) and that nothing is to be changed. That is read-only orientation, which is what `explorer` is for. The pull toward a code-writing definition comes from the subject (auth, four packages, sixty-four route files, a blocked wiki rewrite) and is to be resisted: a dispatch is sized to what the task produces. `reviewer` is also wrong: the issue rules the security review out of this task, and `reviewer` judges code rather than mapping it.

PASS if the stated reason is that the issue produces a read-only inventory (file paths and line numbers, no change to any code, no judgement about any gate), so the dispatch is sized to what the task produces rather than to how weighty auth is.

FAIL if the choice rests mainly on cost, cheapness, token savings, or the task being small, simple or low risk (a survey of sixty-four route files is none of those), or if the subject matter (auth, sessions, four packages, the blocked wiki pages) decides the dispatch.

FAIL also if the file is missing or empty.
