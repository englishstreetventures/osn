---
type: llm
weight: 1
focus: { source: file, path: PREP-PR-REPORT.md }
---

The file is the local pre-PR report. The branch `fix/cire-api-guest-session-ttl` cuts the guest session cookie's lifetime from 30 days to 14 in `cire/api/src/routes/claim.ts` and `cire/api/src/routes/account-link.ts`; that fixes the already-open tracker finding `osn-tracker#8598`. The reviewer's `review-findings.md` lists five more, all already filed in the private `englishstreetventures/osn-tracker`: `#8601` and the info finding `#8602` sit in `claim.ts`, a file this branch changes, and are not fixed here; `#8603` (high) is in `pulse/api`, which the branch never touches; `#8604` is a one-line schema fix in `cire/api/src/routes/rsvp.ts`, which the branch does not change; `#8605` spans all fourteen cire route files and needs the owner's choice, a larger piece of work. The pull request lands on the public `englishstreetventures/osn`. The organisation may be written `englishstreetventures`, `englishstventures` or `xchromo`; all three name the same repository. The brief forbids edits, so what a run allowed to edit would do is stated as a proposal, never as done.

PASS if the report carries a finding tally: how many findings the review raised, which are fixed on this branch, which on the follow-up pull request, and each issue left open with the one of the three allowed reasons it fits (out of the feature's scope, unrelated and found mid-task, a larger piece of work), with all five unfixed findings accounted for.

FAIL if there is no tally or any of `#8601` to `#8605` is missing from it.

FAIL also if the file is missing or empty.
