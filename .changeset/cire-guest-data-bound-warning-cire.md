---
"@cire/api": minor
"@cire/host": minor
---

The organiser portal warns a wedding's owners and editors when Cire is within 90 days of deleting its guest list three years after the wedding was created, or past that day: the wedding has an event whose date and time Cire cannot read, or no events. `GET /api/organiser/weddings` carries `guestDataBound` (state, reason, the first instant the sweep may delete, and up to three of the events it cannot date) on such a wedding for an owner or editor seat only, worked out in the list's own statement from the sweep's date test; a third statement reads the events' names only when one is warned for an unreadable date. The dashboard shows a `warn` banner before the day and a `danger` one after, with a button to Events → Edit, and reads the list again after each schedule save, so the banner goes as the fix lands. A sweep run on 29 February no longer takes a wedding created on the 1 March three years before ahead of its anniversary.
