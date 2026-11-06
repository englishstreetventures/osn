---
"@cire/api": patch
"@cire/host": patch
"@tools/e2e": patch
---

An editor schedule save refuses an event name, Start, End or timezone it sets to a value the spreadsheet upload would not store: a blank name, a Start or End that is not a date and time ending in a UTC offset (`Z` or `±HH:MM`) with no space around it, or a zone the Worker does not resolve. A field the save leaves as stored passes as stored, so an event saved before these checks never keeps its wedding's editors from saving; a new event is held to every check, and a Start or End the save sets holds the zone as well. A guests save holds only the name of an event it adds. The checks run at preview and again at apply, and a refused preview stores nothing. `POST /api/rsvp` refuses a body with no reply in it. The time-zone lookup cache keys on the ASCII-lower-cased name, so every casing of a zone shares one entry. The organiser portal shows a stored value these checks refuse as a warning on the event and in its drawer, without keeping Save shut, and sends Start and End as held. The end-to-end event-details flow saves around, and fixes, an event saved before these checks.
