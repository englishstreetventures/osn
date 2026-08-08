---
"@cire/invites": patch
---

Close the RSVP sheet faster after Save.

The confirmed state held for a flat `SAVED_DWELL_MS = 900`, measured from the
moment the server's 200 landed — so a guest waited `round-trip + 900ms`, and the
two costs stacked. `POST /api/rsvp` is six sequential D1 round-trips behind a
Worker, so half a second of "Saving…" followed by nine tenths of a second of
"Saved" was the ordinary case.

The dwell is now a budget measured from the click: `savedDwellMs(requestMs)`
returns `max(SAVED_DWELL_MIN_MS, SAVED_DWELL_MS - requestMs)`, so the request
time comes out of the dwell rather than being added to it. `SAVED_DWELL_MS`
drops 900 → 600 and becomes the ceiling rather than a fixed hold;
`SAVED_DWELL_MIN_MS` (500) is the floor, so a reply slower than the whole budget
still gets a readable "Saved" — "Saving…" is not a confirmation, and a sheet
that vanishes on the reply is the original bug this dwell exists to prevent.

Up to the knee (a reply of `SAVED_DWELL_MS - SAVED_DWELL_MIN_MS`) the budget is
spent exactly and click-to-close is flat at ~600ms; past it the floor takes over
and the total is `request + 500`. The floor is sized by the sheet's screen-reader
`role="status"` region rather than by the visible label — the region is destroyed
on the same tick the dwell expires, while focus returns to the Respond button —
so the knee is small and most real saves get the floor: 900 → 500 of dwell, a
flat ~400ms off every save. The remaining ~200ms is recoverable by hoisting the
live region to the page root, filed as C-L1.

Nothing downstream needed retuning: the Respond-button celebration is measured
from the moment the sheet uncovers that button, and the toast fires immediately
and outlives the close. The elapsed time is measured with `performance.now()`, which is monotonic —
a duration should not be able to go backwards under an NTP correction.

Added tests driving a controllable reply (slow reply gets the floor and nothing
more; fast reply closes out at the budget), the knee derived from the constants,
a two-sided assertion on the host-preview hold, and the two guards that keep the
budget a true ceiling — a non-finite measurement returns the floor rather than
handing `setTimeout` a NaN delay, and a backwards clock step can't lengthen the
dwell.
