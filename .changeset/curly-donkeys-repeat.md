---
"@pulse/api": patch
---

Stop the calendar export inventing an end time, and fold its lines by octet.

`buildIcs` gave every event with no `endTime` a `DTEND` two hours after the
start, so a guest's calendar showed a finish time the host never set. RFC 5545
§3.6.1 allows a `VEVENT` with `DTSTART` and no `DTEND`, which is what the row
actually says.

Folding also counted UTF-16 code units rather than octets, so a title with an
emoji both overran the 75-octet limit and could be sliced through a surrogate
pair, emitting invalid UTF-8. The export now carries `STATUS` and `CATEGORIES`
as well, and its `UID` matches the iOS client's so the same event saved from
web and from iOS is one calendar entry rather than two.
