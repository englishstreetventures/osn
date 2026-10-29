---
description: 'A one-line visual change to a Musubi Social screen, sized like a mechanical edit, that needs a colour the surface''s DESIGN.md does not hold: a new amber status badge with no token. Tests whether pick-agent splits the two design tiers by whether the design system already has the answer, sending this to the designer tier rather than to design-mechanic, and never to mechanic.'
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
