# Prepare `fix/osn-api-refresh-window` for a pull request

You are in a checkout of the repository, on the branch `fix/osn-api-refresh-window`. The work is finished and the security, performance and test reviews have already run over it, finding nothing that blocks a merge. Run the rest of the pre-PR preparation this repository calls for and report what you find.

## Environment

- There is no network. `git push`, `git fetch`, and every `gh` command will fail. That is by design; do not treat it as a defect and do not claim any remote action succeeded.
- Package tooling is not installed. Do not run `bun install`, `bun run changeset`, or any other interactive CLI — inspect files instead.
- Do not modify source files and do not commit anything. Report; don't fix.
- The reviews are done. Do not run them again, and do not dispatch agents to run them — there is
  nothing left for them to find here, and this task is not scored on their output. That the reviews
  ran says nothing about the build, the type check, the test suite or any other gate: none of those
  has been executed, and none of them can be, in this checkout.

## Deliverables

Write two files at the root of the repository. They are the only things that get read — anything stated elsewhere does not count.

- `PREP-PR-REPORT.md` — what you checked, anything that would fail in CI named exactly along with its fix, and whether the branch is ready.
- `PR-BODY.md` — the pull request body you would submit for this branch, exactly as it would be passed to `gh pr create --body-file`.
