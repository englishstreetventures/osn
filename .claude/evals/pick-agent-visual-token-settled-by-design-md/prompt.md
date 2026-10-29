---
description: 'A one-line visual change to a Musubi Social screen, sized like a mechanical edit, whose answer the surface''s DESIGN.md already holds: secondary text takes the muted-ink token. Tests whether pick-agent keeps a small visual change away from mechanic, which does not load the design system, and sends it to the design tier that reads DESIGN.md, without promoting it to the designer tier that makes design decisions.'
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit]
---

# Choose the subagent for this task

A task is ready to hand to a subagent. Decide which one to dispatch, and on
what settings.

The issue is in `TASK-ISSUE.md` at the root of the checkout, exactly as it was
filed. `AGENTS-AVAILABLE.md` beside it lists the subagent definitions this
repository has.

## Environment

- There is no network, and you have no shell. You cannot look the issue up;
  everything about it is in `TASK-ISSUE.md`.
- The repository itself is here and you may read it.
- Do not modify any tracked file, do not commit, and do not do the task
  itself. You are choosing who does it, not doing it — no edits to the screen.

## Deliverable

Write `DISPATCH.md` at the root of the repository. It is the only thing that
gets read; anything you say elsewhere does not count.

State which subagent you would dispatch, on which model, at which effort
level, and why. Keep the reasoning to a few sentences — whoever reads this is
about to dispatch, not to deliberate. Be clear about which parts of your
answer are established and which are your own judgement.
