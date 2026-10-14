---
"@cire/api": patch
"@cire/db": patch
---

Log each organiser status-only RSVP save in the change log, naming the organiser.

Migration 0084 adds `rsvp_changes.actor_osn_profile_id` and a partial index on
the household's rows. A status-only save writes a `host_status_set` row in the
same D1 batch as the status. The overview card, the "New" badges and the daily
digest read only household rows. The RSVP CSV's "Recorded By" says
"Guest (status by organiser)" or "Household (status by organiser)" when an
organiser set a reply's status after the household answered.
