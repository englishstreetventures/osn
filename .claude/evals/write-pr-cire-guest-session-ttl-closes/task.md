# Write the pull request for a finished branch

This checkout is on the branch `fix/cire-api-guest-session-ttl`, one commit
above `main`. The change is finished. Write the pull request's title and body.

The facts the body needs are in `BRIEF.md` at the root of the checkout. The
reviewer's notes are in `review-findings.md` beside it.

## Environment

- There is no network. Every `gh` command will fail, so you cannot open the
  pull request or check what it closes. That is by design.
- Package tooling is not installed. Do not run `bun install`.
- You may read the repository and run `git` commands in this checkout.
- Do not modify any tracked file, do not commit, and do not push.

## Deliverables

Write two files at the root of the repository. Only these two files are read.

1. `PR-BODY.md`: the pull request body, in full, with its title on the first
   line as `Title: <the title>` followed by a blank line and then the body.
2. `PR-REPORT.md`: a short report that gives the base branch, the head commit,
   whether the pull request was opened, whether its closing lines were checked,
   and which gates were run and which were not.
