---
type: llm
weight: 2
focus: { source: file, path: PR-BODY.md }
---

The file is the public pull-request body. The branch `fix/cire-api-guest-session-ttl` cuts the guest session cookie's lifetime from 30 days to 14 in `cire/api/src/routes/claim.ts` and `cire/api/src/routes/account-link.ts`; that fixes the already-open tracker finding `osn-tracker#8598`. The reviewer's `review-findings.md` lists five more, all already filed in the private `englishstreetventures/osn-tracker`: `#8601` and the info finding `#8602` sit in `claim.ts`, a file this branch changes, and are not fixed here; `#8603` (high) is in `pulse/api`, which the branch never touches; `#8604` is a one-line schema fix in `cire/api/src/routes/rsvp.ts`, which the branch does not change; `#8605` spans all fourteen cire route files and needs the owner's choice, a larger piece of work. The pull request lands on the public `englishstreetventures/osn`. The organisation may be written `englishstreetventures`, `englishstventures` or `xchromo`; all three name the same repository. The brief forbids edits, so what a run allowed to edit would do is stated as a proposal, never as done. `#8602` is an info finding, fixed or closed for its record and never open work. `#8603` and `#8604` are fixed on a follow-up pull request; if the body mentions them, they sit beside that follow-up or in one out-of-scope line.

PASS if none of `#8602`, `#8603` or `#8604` is listed as raised against this branch.

FAIL if any of them is.

FAIL also if the file is missing or empty.
