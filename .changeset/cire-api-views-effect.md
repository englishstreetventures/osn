---
"@cire/api": patch
---

The guest and event CSV exports and the dashboard RSVP view now read through the Effect database handle. A failed read answers the same 500 as before, and the RSVP view now logs the failure by name like the exports do.
