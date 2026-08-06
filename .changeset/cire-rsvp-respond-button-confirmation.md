---
"@cire/web": patch
---

Move the recorded-RSVP confirmation from the RSVP sheet's Save button onto the
events section's Respond button.

The gold fill sweep + drawn tick landed on Save in #380, but that button is
gone the instant the sheet closes over it — a guest never had time to
register the confirmation. It now plays on Respond instead: a green fill
sweeps in with the tick drawing into it, holds, then fades back out while the
tick stays — settling into a permanent `text-success` mark that a household
already has an RSVP on file for this event, on this visit and every one
after. The RSVP sheet keeps a plain "Saved" label and its dwell before
auto-closing; the animated half moved to `EventCard` (`rsvp-responded.ts`).
The host preview plays the same flourish (via a new `RsvpModal` `onConfirmed`
callback, separate from the data-writing `onSubmitted`) but never leaves a
permanent tick, since nothing is actually saved.
