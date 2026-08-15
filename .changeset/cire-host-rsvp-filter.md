---
"@cire/host": patch
---

Search and status filtering on the organiser RSVP list, over one merged list per
event.

The list used to show only the guests who had replied, with everyone still
silent tucked into an editor-only `<details>` disclosure below the table. Both
now render as rows in the same table: a guest who has not answered carries a
muted "No reply" badge, and — for an editor — a `Record` button in the same
column that `Edit` sits in. The disclosure is gone. A viewer now sees who owes a
reply too, read-only.

Above the events sits one control bar, not one per event: a search box and a set
of status chips (All / Attending / Declined / Maybe / No reply), each with a
count summed across every event. Search matches a name, the household name, the
household code and the dietary note, and every typed word must match, so "jones
cleo" and "sharma gluten" both work. Filtering never hides an event section — the
header and its tallies stay as the unfiltered truth, and a section with nothing
left says "No guests match this filter". A live region reports how many of the
total are showing.

The merge and the predicate live in a new pure `src/lib/rsvp-filter.ts`
(`mergeRows` / `filterRows` / `statusCounts`) with its own unit tests. No API
change: the RSVP payload already carried both lists.
