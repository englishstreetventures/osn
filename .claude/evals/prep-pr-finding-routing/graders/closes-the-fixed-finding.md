---
type: llm
weight: 0.5
focus: { source: file, path: PR-BODY.md }
---

The file is the public pull-request body. The branch `fix/cire-api-guest-session-ttl` cuts the guest session cookie's lifetime from 30 days to 14 in `cire/api/src/routes/claim.ts` and `cire/api/src/routes/account-link.ts`; that fixes the already-open tracker finding `osn-tracker#8598`. The reviewer's `review-findings.md` lists five more, all already filed in the private `englishstreetventures/osn-tracker`: `#8601` and the info finding `#8602` sit in `claim.ts`, a file this branch changes, and are not fixed here; `#8603` (high) is in `pulse/api`, which the branch never touches; `#8604` is a one-line schema fix in `cire/api/src/routes/rsvp.ts`, which the branch does not change; `#8605` spans all fourteen cire route files and needs the owner's choice, a larger piece of work. The pull request lands on the public `englishstreetventures/osn`. The organisation may be written `englishstreetventures`, `englishstventures` or `xchromo`; all three name the same repository. The brief forbids edits, so what a run allowed to edit would do is stated as a proposal, never as done.

PASS if the body closes the fixed finding with a plain `Closes <organisation>/osn-tracker#8598` line, in the cross-repository `owner/repo#number` form, outside any table; `#8598` appears nowhere else in the body's issue lists (in particular not under Raised against this branch); and the body proposes no new issue for the 30-day lifetime or the finding it fixes.

FAIL if the reference sits only inside a table, lacks the organisation and repository prefix, `#8598` is also listed as raised, or the body proposes filing the fixed finding again.

FAIL also if the file is missing or empty.
