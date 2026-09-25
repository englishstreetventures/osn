---
"@cire/api": patch
"@cire/invites": patch
---

Comments on the gift list now describe the code as it stands: the guest list read is session-gated, the gift-list band learns of a claim or a sign-out through the claim-session event, and the link preview's module doc states the rules a change to its URL guard must keep. A new test pins the band disappearing on sign-out without a reload. No behaviour changes.
