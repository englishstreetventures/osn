---
"@pulse/api": patch
---

Every event status write states the state it expects. Automatic transitions leave a cancelled or finished event as it is. Organiser cancels stamp `cancelledAt` and `cancellationReason`, and a series cancel sends its two guarded statements as one D1 batch. The organiser cannot change an event the host-left flow owns, set `maybe_finished`, or edit a cancelled series, and a series edit takes a `this_and_following` cutoff only from its own instances. Hosted events that are already cancelled join the same 14-day hard delete when the host leaves Pulse, and cancelling the leave clears every hard-delete date it set. Concurrent RSVPs keep the first share source and both succeed. RSVPs and invites close on a cancelled event; replies given before the cancel are kept. An RSVP reads its event and the caller's reply in one statement.
