---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is a pull-request title and body. The branch `fix/cire-api-guest-session-ttl`, one commit above `main`, cuts the guest session cookie's lifetime from 30 days to 14 in `cire/api/src/routes/claim.ts` and `cire/api/src/routes/account-link.ts`. From the owner's `BRIEF.md`: it closes the public issue `englishstreetventures/osn#1402` and fixes the private tracker finding `englishstreetventures/osn-tracker#598`; `englishstreetventures/osn-tracker#601` is a second finding the review filed and the branch does not fix; the branch is one part of the epic `englishstreetventures/osn#1380`; the owner chose 14 days in #1402; and the production secret `GUEST_SESSION_SIGNING_KEY_V2` must be set on the production `cire-api` Worker before the production release. `englishstreetventures/osn` is public and the tracker is private. The secret is needed before the production release, not before the merge, so a `**Do not merge until**` line would hold a merge that does not need to wait.

PASS if the owner action for the secret sits under `**At deploy**` or a lead-in that says before the production release.

FAIL if it sits under `**Do not merge until**`, or there is no such owner action.

FAIL also if the file is missing or empty.
