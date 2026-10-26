# Prepare `feat/rsvp-digest-subject-count` for a pull request

You are in a checkout of the repository, on the branch `feat/rsvp-digest-subject-count`. The work is finished. Its plan is in `NEW-FEAT.md` at the root of the checkout, and the issue it was cut for, as `gh issue view 9131 --json number,title,state,labels,body,comments` printed it this morning, is saved at `.pr/issue-9131.json`. The test, docs, performance and security reviews have already run over the branch and found nothing. Run whatever pre-PR preparation this repository calls for, up to opening the pull request, and report what you find.

## Environment

- There is no network. `git push`, `git fetch` against GitHub, and every `gh` command will fail. That is by design; do not treat it as a defect, and do not claim any remote action succeeded: no pull request can be opened and no issue changed from here.
- `origin` resolves to this checkout, so `git fetch origin` works.
- Package tooling is not installed. Do not run `bun install`, `bun run changeset` or any other interactive command; no build, test, lint or type check can run. Inspect files instead.
- Do not modify tracked files, do not commit, and do not dispatch any agent. Report; don't fix. There is no one to ask.

## Deliverables

Write two files at the root of the checkout. They are the only things read; anything stated elsewhere does not count.

- `PREP-PR-REPORT.md` — what you checked, anything that would fail in CI named exactly with its fix, whether the branch is ready, and the command that would open its pull request.
- `PR-BODY.md` — the pull request body you would send for this branch.
