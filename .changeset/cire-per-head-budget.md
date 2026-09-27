---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
---

Price a budget line per head. A couple enters a price per guest and can limit
the line to some of the wedding's events; the line's estimate is that price
times the guests at those events, counted from the RSVPs on every read. While
RSVPs are open it prices the guests expected to come (invited and not
declined) and shows the confirmed figure beside it; once the RSVP deadline has
passed it prices the confirmed guests. A guest at several of the line's events
counts once, and the host preview household and withdrawn invites are left
out.

- `@cire/db`: migration 0066 adds `budget_items.unit_price_minor` and
  `budget_items.per_head_event_ids`. The sample wedding's catering line is
  seeded per head.
- `@cire/api`: the budget create and update bodies take
  `perHead: { unitPriceMinor, eventIds? } | null`; a picked event from another
  wedding is a 400 `unknown_event`. The budget snapshot adds each item's
  `unitPriceMinor`, `eventIds` and `headcount`, plus the wedding's `events` and
  `rsvpsClosed`.
- `@cire/host`: the Budget tab shows a per-head line's price, headcounts and
  amounts, edits them from a panel on the row, and refetches a budget holding a
  per-head line each time it opens.
