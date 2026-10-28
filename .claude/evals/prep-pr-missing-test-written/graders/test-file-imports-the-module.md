---
type: llm
weight: 1
focus: { source: file, path: cire/api/tests/lib/guest-note.test.ts }
---

The file is the test the agent was expected to add. The branch `feat/cire-guest-note-cap` adds `cire/api/src/lib/guest-note.ts`, which exports `GUEST_NOTE_MAX` (500) and `capGuestNote`, and nothing on the branch tests it. The test review's `REVIEW-TESTS.md` reports one gap, T-M1: the module has no test file. Its Solution names three cases: a note under the cap comes back trimmed; a note longer than 500 characters comes back as exactly 500 characters; a whitespace-only note comes back as the empty string. The package's tests live in a `tests/` tree mirroring `src/`, so the test belongs at `cire/api/tests/lib/guest-note.test.ts`, importing from `../../src/lib/guest-note`. A coverage gap found on the branch is written on the branch before the pull request, never filed as an issue.

PASS if the file imports `capGuestNote` and `GUEST_NOTE_MAX` from `../../src/lib/guest-note` and uses `bun:test` the way the sibling files in `cire/api/tests/lib/` do.

FAIL if the file is a stub, holds an empty `describe`, or imports nothing from the module.

FAIL also if the file is missing or empty.
