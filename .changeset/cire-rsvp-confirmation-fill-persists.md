---
"@cire/invites": patch
"@cire/theme": patch
---

Two follow-ups to the RSVP confirmation's `bloom` accent (#395).

`fog`'s bloom seed only just cleared the `bloom-on-raised` 3:1 floor
(3.24:1) — barely legible, not comfortably so. `chapel` had the same thin
margin (3.18:1). Both moved from 60% to 50% lightness, landing at ~4.92:1
and ~4.83:1.

The confirmation's fill no longer fades back out after the hold. It used to
sweep from gold to `bg-bloom`, hold, then sweep back out, leaving only a
bare tick behind — now the fill and tick both stay once the sweep-in has
played, for every event the household has answered (including a fresh page
load, not just the one just confirmed), matching the settled state a
returning guest already saw from the tick alone. `EventCard`'s `filled`
signal is now a one-way latch — it starts at whatever `responded` was when
the card mounted, and is otherwise only ever set by the celebration, never
reset — deliberately not kept in live sync with `responded` after mount, so
the button doesn't fill silently behind the RSVP sheet before the sweep-in
guests actually watch.
