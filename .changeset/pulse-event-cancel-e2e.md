---
"@tools/e2e": patch
---

The `pulse-event-rsvp` flow goes on past the guest's RSVP: the host cancels the event through pulse-api, the cancelled row records its cancel time on the suite clock and the organiser reason, the guest's attempt to change their reply is refused with 422 and the reply is kept, the guest's event page shows the cancel and no RSVP buttons, `maybe_finished` is refused, and a three-instance series cancelled twice reports 3 and then 0. `signInToPulse` moves into the shared fixtures, and the sign-in budget test counts its `/authorize` calls.
