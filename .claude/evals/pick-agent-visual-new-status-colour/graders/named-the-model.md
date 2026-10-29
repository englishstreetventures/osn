---
type: llm
weight: 1
focus: { source: file, path: DISPATCH.md }
---

The file is a dispatch decision. The agent was given one filed issue (`TASK-ISSUE.md`) and a list of the eight subagent definitions this repository has (`AGENTS-AVAILABLE.md`: names and one-line descriptions, no model and no effort level), and asked which subagent to dispatch. Nobody has compared outcome against model or effort on this codebase, so any settings recommendation is reasoning, not measurement. `designer` runs on `opus` at `xhigh` effort.

PASS if the file names a model for the chosen subagent, and it is `opus`.

FAIL if no model is named, or it is another model.

FAIL also if the file is missing or empty.
