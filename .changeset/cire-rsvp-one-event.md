---
"@cire/host": minor
---

The RSVP page shows one event at a time

The host portal's RSVPs page now shows one event at a time, picked from a row
of tabs that scrolls sideways when a wedding has many events. The page address
names the event (`#/w/<wedding>/guests/rsvps/<event>`), so a reload or a shared
link opens the same one; without an event, or with one that no longer exists,
the page opens on the first.

- **The event's panel** holds its tally, the search box, the reply chips and
  the table, and names the event it shows ("Showing 3 of 120 guests for
  Reception."). Each tab counts the guests its list would show under the
  current search and reply chip, and says "New" while it holds a reply changed
  since the host last looked — opening the page marks every event's changes
  seen.
- **Sorting.** The Guest and Household heads sort the list: Guest by surname,
  then first name, with a guest who has no surname last either way; Household
  by household name, keeping each household's rows in the order they came in —
  replies first, then the guests still to answer. Click again to reverse.
- **The table keeps its heads in view.** It scrolls in its own box, sized to
  fit on screen under the top bar, and holds its head row in place while the
  rows scroll, and its Guest column while a narrow screen scrolls sideways.
  Keyboard focus is kept clear of both.

The CSV export still covers every event, and the Overview card is unchanged.
