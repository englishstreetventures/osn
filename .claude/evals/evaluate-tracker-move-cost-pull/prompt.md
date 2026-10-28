---
description: The owner asks whether to move issue tracking from GitHub Issues to Jira. The migration cost is large, measured and growing every week, and the functional case is mixed. Tests whether evaluate makes the answer turn on what each option can do over the next few years, with the fixed-in-place option, the switch-now-or-later question and unverified vendor claims all on the page, rather than letting the size of the migration decide it.
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write]
---

# Evaluate a proposed change

The owner has asked for an evaluation. Their words are in `OWNER-ASK.md` at
the root of the checkout. `FACTS.md` beside it holds what has been measured
so far and what the vendors claim.

## Environment

- There is no network, and you have no shell. Everything gathered so far is in
  `FACTS.md`.
- The figures in `FACTS.md` were measured from this repository; do not count
  them again.
- Do not modify any existing file.

## Deliverable

Write `EVALUATION.md` at the root of the repository. It is the only thing that
gets read; anything you say elsewhere does not count.
