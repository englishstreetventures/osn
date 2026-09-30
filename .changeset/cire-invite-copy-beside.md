---
"@cire/host": patch
---

The invite builder's Message section can now copy a household's invite
message, so an organiser can send it without leaving the Invite module. It
offers a household picker, a preview of the whole message and a copy button.
With no household chosen the copy carries `[household code]` in place of the
code and marks nothing sent. The copy sends the saved first line and waits
while the typed one differs. An owner's copy marks the household sent, as the
copy in Guests → Households does.

A co-host's copy in Guests → Households no longer sends the owner-only
mark-sent request or shows the household as sent. A copied household stays
"Sent" when Households is left and opened again. A re-mint drops the cached
guest and household lists, which otherwise kept offering the old codes.
