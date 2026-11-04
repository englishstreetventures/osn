---
description: 'A new `@pulse/api` service function, `closeEvent`, that lets an organiser end an ongoing event early. It reads the row, checks ownership and the derived status in code, then writes `status: "finished"` with only the row id in its WHERE, so a cancel committed between the read and the write by another writer of `events.status` — the account-erasure flow, the organiser update path, a series cancel — is overwritten. Every one of those writers is outside the diff. Tests whether a review finds the race by listing the writers repo-wide, says what the overwrite leaves behind, proposes the guard and the test that fails without it, and leaves the deliberately correct parts alone.'
max_turns: 200
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

# Review `feat/pulse-close-event` for state-transition defects

You are in a checkout of the repository, on the branch `feat/pulse-close-event`. The branch adds `closeEvent` to `@pulse/api`'s events service: an event's organiser can end an ongoing event now, which sets its end time to now and its status to finished.

Review this branch's diff against its base for defects in how it changes the event's state, and report your findings in this repository's review conventions.

## Environment

- There is no network. `git push` and every `gh` command will fail. Say where a finding would be filed rather than claiming to have filed it.
- Package tooling is not installed. Do not run `bun install` or the test suite — read the code instead.
- This is a review, not a fix. Do not modify source files.

## Deliverable

Write your findings to `STATE-REVIEW.md` at the root of the repository. That file is the only thing that gets read — a finding stated anywhere else does not count as found.
