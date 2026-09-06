# Review the test surface of `feat/pulse-account-routes`

You are in a checkout of the repository, on the branch `feat/pulse-account-routes`. It adds the `/account` route group — account deletion, restore, and deletion status — with its route tests.

Check whether the branch is adequately tested, to whatever standard this repository holds a branch to before it merges.

## Environment

- There is no network. `git push`, `git fetch` and every `gh` command will fail. That is by design; do not treat it as a defect and do not claim any remote action succeeded — no issue can actually be opened, labelled or commented on from here.
- Package tooling is not installed. `bun install`, `bun run build` and the test runner will all fail. That is expected; read the source and the tests from disk instead.
- Do not modify source files, do not add or edit tests, and do not commit anything. Audit; don't fix.

## Deliverable

Write your report to `TEST-REVIEW.md` at the root of the repository. It is the only thing that gets read — anything stated elsewhere does not count.
