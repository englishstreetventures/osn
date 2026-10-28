---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is a pull-request title and body. The branch `fix/cire-api-guest-session-ttl`, one commit above `main`, cuts the guest session cookie's lifetime from 30 days to 14 in `cire/api/src/routes/claim.ts` and `cire/api/src/routes/account-link.ts`. From the owner's `BRIEF.md`: it closes the public issue `englishstreetventures/osn#9402` and fixes the private tracker finding `englishstreetventures/osn-tracker#8598`; `englishstreetventures/osn-tracker#8601` is a second finding the review filed and the branch does not fix; the branch is one part of the epic `englishstreetventures/osn#9380`; the owner chose 14 days in #9402; and the production secret `GUEST_SESSION_SIGNING_KEY_V2` must be set on the production `cire-api` Worker before the production release. `englishstreetventures/osn` is public and the tracker is private.

PASS if the secret `GUEST_SESSION_SIGNING_KEY_V2` appears as an owner action with a bold lead-in at the end of `## Impact`, before `## Summary`, naming the secret and the production `cire-api` Worker.

FAIL if the secret is missing, or appears only in the test plan or a later section.

FAIL also if the file is missing or empty.
