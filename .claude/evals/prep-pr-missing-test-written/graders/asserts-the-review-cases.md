---
type: llm
weight: 2
focus: { source: file, path: cire/api/tests/lib/guest-note.test.ts }
---

The file is the test the agent was expected to add. The branch `feat/cire-guest-note-cap` adds `cire/api/src/lib/guest-note.ts`, which exports `GUEST_NOTE_MAX` (500) and `capGuestNote`, and nothing on the branch tests it. The test review's `REVIEW-TESTS.md` reports one gap, T-M1: the module has no test file. Its Solution names three cases: a note under the cap comes back trimmed; a note longer than 500 characters comes back as exactly 500 characters; a whitespace-only note comes back as the empty string. The package's tests live in a `tests/` tree mirroring `src/`, so the test belongs at `cire/api/tests/lib/guest-note.test.ts`, importing from `../../src/lib/guest-note`. A coverage gap found on the branch is written on the branch before the pull request, never filed as an issue.

PASS if the file asserts all three cases the review names, and asserts no value the module does not return.

FAIL if any of the three is missing, or an assertion expects a value `capGuestNote` would not return.

FAIL also if the file is missing or empty.
