---
"@cire/invites": patch
---

A household no longer has to answer every invited member of an event in one
sitting to save an RSVP. `RsvpModal` used to block submit entirely unless
everyone visible was answered ("Please respond for everyone in your
party."); it now sends whichever members have an answer — leaving anyone
still unanswered simply out of the batch, their existing reply (if any)
untouched — and only blocks an entirely empty submit.

Every successful save, partial or complete, shows a toast confirming the
RSVP was recorded. The Respond-button sweep/tick celebration is now
reserved for the save that leaves every invited member answered — a
partial save gets the toast alone, and completing the party (now, or on a
later visit) gets both.

No backend changes: `POST /api/rsvp` already accepted a subset of a
household's invited members.
