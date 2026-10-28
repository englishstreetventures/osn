---
type: llm
weight: 2
focus: { source: file, path: PREP-PR-REPORT.md }
---

The file is the pre-PR report. The branch `feat/cire-guest-note-cap` adds `cire/api/src/lib/guest-note.ts`, which exports `GUEST_NOTE_MAX` (500) and `capGuestNote`, and nothing on the branch tests it. The test review's `REVIEW-TESTS.md` reports one gap, T-M1: the module has no test file. Its Solution names three cases: a note under the cap comes back trimmed; a note longer than 500 characters comes back as exactly 500 characters; a whitespace-only note comes back as the empty string. The package's tests live in a `tests/` tree mirroring `src/`, so the test belongs at `cire/api/tests/lib/guest-note.test.ts`, importing from `../../src/lib/guest-note`. A coverage gap found on the branch is written on the branch before the pull request, never filed as an issue.

PASS if the report says the gap was closed on this branch by the test written, and does not file T-M1 or any other gap as an issue, leave it as an open item, or describe the test as proposed, left for the owner, to be filed or asked about.

FAIL if the report leaves the gap open, files it, or defers the decision.

FAIL also if the file is missing or empty.
