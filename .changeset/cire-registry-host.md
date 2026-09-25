---
"@cire/api": patch
"@cire/host": patch
---

Two organisers editing the gift registry settings at once no longer undo each
other. The settings tab now saves only the fields the couple changed, each with
the value they saw before changing it. A tab left open can no longer re-publish a
list or restore an address a co-host withdrew. When someone else has saved the
same field in the meantime, the API refuses with 409 `settings_changed` and
returns the current row, and the tab shows their change while keeping what was
typed.

The registry snapshot and the settings save no longer send the Stripe account id
or the payouts flag to every co-host. They send `stripeConnected` in place of the
id. "Check again" now also notices an account Stripe no longer knows.

The gift list, the checklist and the budget reorder the same way the schedule
does: drag a grip, or use the arrow keys or the screen-reader move buttons.
Focus stays on the moved row, each move is announced, and a failed save
withdraws the announcement.
