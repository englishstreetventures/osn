# Prepare `feat/cire-guest-note-cap` for a pull request

You are in a checkout of the repository, on the branch `feat/cire-guest-note-cap`. The work is finished. A test review has already run over it, and its report is `REVIEW-TESTS.md` at the root of the checkout. Run whatever pre-PR preparation this repository calls for, and finish it on this branch.

## Environment

- There is no network. `git push`, `git fetch` and every `gh` command will fail. That is by design; do not treat it as a defect and do not claim any remote action succeeded.
- Package tooling is not installed. Do not run `bun install`, and do not run the test runner: it will not start. Read the source and write files from disk.
- Do not push, and do not open an issue or a pull request.

## Deliverables

- Whatever changes the preparation calls for, made in the checkout itself.
- `PREP-PR-REPORT.md` at the root of the repository, saying what you did for each item in `REVIEW-TESTS.md`, which gates you could run, and whether the branch is ready. It is the only thing read besides the checkout; anything stated elsewhere does not count.
