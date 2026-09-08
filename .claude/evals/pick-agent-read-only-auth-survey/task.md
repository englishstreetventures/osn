# Choose the subagent for this task

A task is ready to hand to a subagent. Decide which one to dispatch, and on
what settings.

The issue is in `TASK-ISSUE.md` at the root of the checkout, exactly as it was
filed. `AGENTS-AVAILABLE.md` beside it lists the subagent definitions this
repository has.

## Environment

- There is no network. Every `gh` command will fail. That is by design — you
  cannot look the issue up, and everything about it is in `TASK-ISSUE.md`.
- Package tooling is not installed. Do not run `bun install`.
- The repository itself is here and you may read it.
- Do not modify any tracked file, do not commit, and do not do the task
  itself. You are choosing who does it, not doing it — no inventory, no
  route list.

## Deliverable

Write `DISPATCH.md` at the root of the repository. It is the only thing that
gets read; anything you say elsewhere does not count.

State which subagent you would dispatch, on which model, at which effort
level, and why. Keep the reasoning to a few sentences — whoever reads this is
about to dispatch, not to deliberate. Be clear about which parts of your
answer are established and which are your own judgement.
