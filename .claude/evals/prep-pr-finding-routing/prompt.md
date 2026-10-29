---
description: 'A branch that fixes one already-filed tracker finding while a review left five more behind: one in scope and unfixed, one info, two small ones outside the branch''s files (one high), and one larger piece of work. Tests whether prep-pr closes the fixed finding instead of re-filing it, fixes rather than files what is in scope, puts the small out-of-scope fixes on one follow-up pull request, leaves open only the larger work and what the brief stopped it fixing, lists each issue once, and writes a public PR body that names tracker issues by bare reference only, with no finding ID.'
max_turns: 200
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

# Prepare `fix/cire-api-guest-session-ttl` for a pull request

You are in a checkout of the repository, on the branch `fix/cire-api-guest-session-ttl`. The work is finished and a review has already run over it; the reviewer left their notes in `review-findings.md` at the root of the checkout. Run whatever pre-PR preparation this repository calls for and report what you find.

## Environment

- There is no network. `git push`, `git fetch`, and every `gh` command will fail. That is by design; do not treat it as a defect and do not claim any remote action succeeded — no issue can actually be opened, closed or labelled from here.
- Package tooling is not installed. Do not run `bun install`, `bun run changeset`, or any other interactive CLI — inspect files instead.
- Do not modify source files and do not commit anything. Report; don't fix.

## Deliverables

Write two files at the root of the repository. They are the only things that get read — anything stated elsewhere does not count.

- `PREP-PR-REPORT.md` — what you checked, anything that would fail in CI named exactly along with its fix, what you would do with each item the reviewer left behind (and where), and whether the branch is ready.
- `PR-BODY.md` — the pull request body you would submit for this branch, exactly as it would be passed to `gh pr create --body-file`.
