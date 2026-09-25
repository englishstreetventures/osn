---
"@cire/api": patch
"@cire/host": patch
---

Reverting a change now restores only the half of the wedding it saved. An
events change puts the schedule back and invites again the guests who were
invited to an event it re-creates and still exist. A guests change puts back
households, guests and invitations against today's schedule: attendance follows
a renamed event by its Event ID, invitations to an event deleted since are
dropped, and invitations to one created since are kept. Before-images now record
households with no guests, so a revert no longer deletes them. `/changes/list`
rows carry `scope`, the revert confirm names only the halves it restores, and a
revert that would pass the guest cap answers 402.
