---
description: The organiser role gates and the entitlement gate that mounts behind them. The entitlement gate issues its own single-row lookup on a wedding the role gate in front of it has already queried, so a gated route pays three selects where two would do. Tests whether a performance review finds a point lookup behind a query that already reached the row — and whether it proposes a fix that does not tax the many routes mounting the role gate alone.
max_turns: 200
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

# Performance-review `feat/cire-wedding-gates`

You are in a checkout of the repository, on the branch `feat/cire-wedding-gates`. It adds the organiser role gates for `/api/organiser/weddings/:weddingId/*` — the member gate, the editor gate and the paid-feature entitlement gate — together with the host service they call.

Review the branch for performance to whatever standard this repository holds a branch to before it merges. Correctness, security and test coverage are somebody else's pass; what this one has to find is work the code pays for and does not need to.

## Environment

- There is no network. `git push`, `git fetch` and every `gh` command will fail. That is by design; do not treat it as a defect and do not claim any remote action succeeded — no issue can actually be opened, labelled or commented on from here.
- Package tooling is not installed. Do not run `bun install`, the test suite, or any other interactive CLI — read the code instead.
- Do not modify source files and do not commit anything. Review; don't fix.

## Deliverable

Write your review to `PERFORMANCE-REVIEW.md` at the root of the repository. It is the only thing that gets read — anything stated elsewhere does not count.
