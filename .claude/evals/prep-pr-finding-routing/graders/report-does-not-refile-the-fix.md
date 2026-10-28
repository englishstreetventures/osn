---
type: llm
weight: 0.5
focus: { source: file, path: PREP-PR-REPORT.md }
---

The file is the local pre-PR report. The branch `fix/cire-api-guest-session-ttl` cuts the guest session cookie's lifetime from 30 days to 14 in `cire/api/src/routes/claim.ts` and `cire/api/src/routes/account-link.ts`; that fixes the already-open tracker finding `osn-tracker#598`. The reviewer's `review-findings.md` lists five more, all already filed in the private `englishstreetventures/osn-tracker`: `#601` and the info finding `#602` sit in `claim.ts`, a file this branch changes, and are not fixed here; `#603` (high) is in `pulse/api`, which the branch never touches; `#604` is a one-line schema fix in `cire/api/src/routes/rsvp.ts`, which the branch does not change; `#605` spans all fourteen cire route files and needs the owner's choice, a larger piece of work. The pull request lands on the public `englishstreetventures/osn`. The organisation may be written `englishstreetventures`, `englishstventures` or `xchromo`; all three name the same repository. The brief forbids edits, so what a run allowed to edit would do is stated as a proposal, never as done.

PASS if the report treats `osn-tracker#598` as closed by this branch and proposes no new issue for the 30-day lifetime or for the finding the branch fixes.

FAIL if the report proposes opening a new issue for the fixed finding or for the lifetime change.

FAIL also if the file is missing or empty.
