---
type: llm
weight: 4
focus: { source: file, path: DISPATCH.md }
---

The file is a dispatch decision. The agent was given one filed issue (`TASK-ISSUE.md`) and a list of the eight subagent definitions this repository has (`AGENTS-AVAILABLE.md`: names and one-line descriptions, no model and no effort level), and asked which subagent to dispatch. Nobody has compared outcome against model or effort on this codebase, so any settings recommendation is reasoning, not measurement.

PASS if the file names `explorer` as the subagent to dispatch, and names exactly one subagent.

FAIL if it names `implementer`, `designer`, `design-mechanic`, `mechanic`, `reviewer`, `attacker` or `shepherd` instead, declines to choose, or hands back two names for the caller to pick between.

FAIL also if the file is missing or empty.
