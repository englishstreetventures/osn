---
description: An orchestrator reads the prep-pr report for one task, which leaves three issues open with no pull request to close them, one of them for a reason that is none of the three allowed. Tests whether orchestrate checks each open issue against the three categories itself, sends the subagent back once naming the issue that fits none, leaves the two that fit open, and turns a small out-of-scope fix into a task of its own rather than an issue.
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit]
---

# Read a task's prep-pr report and decide the next step

You are the orchestrator of a feature run. Task 3, "cire RSVP: cap the dietary note at 500 characters", has come back from its subagent with the report `TASK-3-REPORT.md` at the root of this checkout. The subagent's branch is `feat/cire-note-cap`. Nothing has been merged.

Decide what happens next for task 3, and write your decisions in `ORCHESTRATE-STEP4.md` at the root of the checkout.

## Environment

- There is no network, and you have no shell.
- Do not dispatch any agent and do not change any tracked file. You write the decisions; you do not carry them out.

## Deliverable

`ORCHESTRATE-STEP4.md` is the only thing read; anything you say elsewhere does not count. It must give:

1. Each issue the report leaves open, with the category it fits (out of the feature's scope; unrelated and found mid-task; a larger piece of work), or none, and why.
2. The message you would send the subagent, if any, and how many times you would send one.
3. What becomes of the small fix outside task 3's files: what kind of item it is, and its branch name.
4. Whether task 3 is ready to merge on the subagent's report, and why.
