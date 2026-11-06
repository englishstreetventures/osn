---
"@cire/api": patch
"@cire/invites": patch
"@cire/ui": patch
"@tools/e2e": patch
---

Once a wedding's RSVP deadline has passed, a guest cannot add or change their own email address: `PUT /api/claim/member/email` answers 403 `rsvp_closed`, except for an address the same guest removed, which they can put back. The invite shows a stored address with its Remove button alone and no form, and offers a removed address back in one read-only form. Removing an address stays open, and the hosts' own import and change routes are not affected. The guest privacy notice says so.
