---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
---

Organiser RSVPs record which host wrote them. Every organiser save stores the
host's OSN profile id on the reply, and an organiser's dietary consent record
names the host who attested it (migration 0080). A plus-one's attested name is
now checked inside the write, so a household rename between loading and saving
refuses the save. The RSVP table badges a host's status change on a guest's
reply as "Host-updated", and a save updates its row and tallies from the
response instead of reloading the whole list.
