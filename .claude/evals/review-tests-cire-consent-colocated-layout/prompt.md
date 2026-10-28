---
description: 'The consent framework as a branch, in a checkout with no single test layout: some packages keep tests in a `tests/` tree, and the package under review has no `tests/` directory at all, its tests sitting beside their source. Six of the changed modules have a test file next to them and two do not. Tests whether a test review resolves where a package''s tests actually are from what is on disk before judging any file missing — applying a convention without looking turns six covered modules into false missing-test findings and buries the real gaps.'
max_turns: 200
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

# Review the test surface of `feat/cire-consent-framework`

You are in a checkout of the repository, on the branch `feat/cire-consent-framework`. It adds the cookie and store layers of the guest site's consent framework, the gate component that withholds third-party content, and the preferences dialog a guest changes their mind in.

Check whether the branch is adequately tested, to whatever standard this repository holds a branch to before it merges.

## Environment

- There is no network. `git push`, `git fetch` and every `gh` command will fail. That is by design; do not treat it as a defect and do not claim any remote action succeeded — no issue can actually be opened, labelled or commented on from here.
- Package tooling is not installed. `bun install`, `bun run build` and the test runner will all fail. That is expected; read the source and the tests from disk instead.
- Do not modify source files, do not add or edit tests, and do not commit anything. Audit; don't fix.

## Deliverable

Write your report to `TEST-REVIEW.md` at the root of the repository. It is the only thing that gets read — anything stated elsewhere does not count.
