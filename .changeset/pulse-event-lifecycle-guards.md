---
"@pulse/api": patch
---

Guard every event status write against the state it expects. Automatic transitions no longer overwrite a cancelled or finished event. Organiser cancels stamp `cancelledAt` and `cancellationReason`, and a series cancel runs as two idempotent guarded statements. The organiser can no longer change an event the host-left flow owns, set `maybe_finished`, or edit a cancelled series. A departing host's own cancelled events now get the same 14-day hard delete. Concurrent RSVPs keep the first share source and no longer fail on the pair index. RSVPs close on a cancelled event; replies given before the cancel are kept.
