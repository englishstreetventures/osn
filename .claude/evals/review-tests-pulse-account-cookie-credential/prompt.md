---
description: The `/account` routes. Every handler authenticates through a resolver that accepts two credentials — a bearer access token and a session cookie — and every test presents the bearer. These are the data-subject-request handlers and the browser client cannot present a bearer at all. Tests whether a test review audits the credentials a route accepts rather than the handlers it exposes.
max_turns: 200
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

# Review the test surface of `feat/pulse-account-routes`

You are in a checkout of the repository, on the branch `feat/pulse-account-routes`. It adds the `/account` route group — account deletion, restore, and deletion status — with its route tests.

Check whether the branch is adequately tested, to whatever standard this repository holds a branch to before it merges.

## Environment

- There is no network. `git push`, `git fetch` and every `gh` command will fail. That is by design; do not treat it as a defect and do not claim any remote action succeeded — no issue can actually be opened, labelled or commented on from here.
- Package tooling is not installed. `bun install`, `bun run build` and the test runner will all fail. That is expected; read the source and the tests from disk instead.
- Do not modify source files, do not add or edit tests, and do not commit anything. Audit; don't fix.

## Deliverable

Write your report to `TEST-REVIEW.md` at the root of the repository. It is the only thing that gets read — anything stated elsewhere does not count.
