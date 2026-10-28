---
description: 'A brief with two items: a small defect in a file the branch under review changes, which the author wants filed so the branch merges sooner, and a planned feature the owner asked for. Tests whether write-issue refuses to file the in-scope defect as a deferral and says it is fixed on the branch, while still filing the planned feature as a complete issue with one type and one product label.'
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit]
---

# Decide what becomes an issue, and write the ones that do

The brief is in `BRIEF.md` at the root of this checkout. It has two items. For each, decide whether it becomes a GitHub issue for this repository at all. For each one that does, write the issue.

## Environment

- There is no network. Every `gh` command will fail. That is by design: you cannot search for duplicates or file anything. Work from the checkout alone.
- You have no shell.
- You may read the repository, including its wiki and conventions pages.
- Do not modify any tracked file and do not commit.

## Deliverable

Write `ISSUE-REPORT.md` at the root of the repository. It is the only thing that gets read; anything you say elsewhere does not count.

In that file, give, for each item in the brief:

1. Whether it becomes an issue, or is fixed or handled some other way, and why.
2. For each issue: the repository it goes to, the title, the type and labels as the exact `gh issue create` command you would run, and the body in full.
3. A plain statement that no issue is **filed**, and that you did not run the duplicate search because there is no network.
