---
type: llm
weight: 1
focus: { source: file, path: PR-BODY.md }
---

The file is a pull-request title and body. The branch `fix/cire-api-guest-session-ttl`, one commit above `main`, cuts the guest session cookie's lifetime from 30 days to 14 in `cire/api/src/routes/claim.ts` and `cire/api/src/routes/account-link.ts`. From the owner's `BRIEF.md`: it closes the public issue `englishstreetventures/osn#1402` and fixes the private tracker finding `englishstreetventures/osn-tracker#598`; `englishstreetventures/osn-tracker#601` is a second finding the review filed and the branch does not fix; the branch is one part of the epic `englishstreetventures/osn#1380`; the owner chose 14 days in #1402; and the production secret `GUEST_SESSION_SIGNING_KEY_V2` must be set on the production `cire-api` Worker before the production release. `englishstreetventures/osn` is public and the tracker is private.

PASS if `## Issues` holds `Closes englishstreetventures/osn-tracker#598` on a line of its own, after the public closing lines, outside any table, code span or code block, with nothing more on the line.

FAIL if it is missing, in a table or code span, before the public lines, or carries extra words.

FAIL also if the file is missing or empty.
