---
"@cire/api": patch
"@cire/host": patch
---

An editor save that writes the schedule refuses an event whose name is blank, whose Start or End is not a date and time ending in a UTC offset (`Z` or `±HH:MM`) with no space around it, or whose timezone is not an IANA zone the Worker resolves, as a spreadsheet upload does before it stamps the offset. A guests-only save checks its events' names only, at preview and at apply. `POST /api/rsvp` refuses a body with no reply in it. The time-zone lookup cache keys on the ASCII-lower-cased name, so every casing of a zone shares one entry. The organiser portal flags a timezone it cannot resolve and a stored time with no offset, sends Start and End trimmed, and the guest list editor no longer waits on errors only a schedule save is refused for.
