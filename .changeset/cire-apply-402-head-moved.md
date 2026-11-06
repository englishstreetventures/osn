---
"@cire/host": patch
"@cire/api": patch
---

When the guest cap refuses a change while it is writing, the organiser portal drops the preview that can no longer apply, says some of the change may already be saved, and reads the guest list again, instead of offering the same Apply until it answers 409.

- `@cire/host`: on an apply's 402 with `reason: "head_moved"`, the spreadsheet import drops its preview and its cached events, guests and households, and keeps the sheet chosen for Preview; the guests editor closes its preview, drops its cached guests and households, marks the draft stale and offers **Reload and keep my edits**. Both show the capacity message, now with a sentence that part of the change may be saved. The guests editor shows that message on any 402 rather than `payment_required`, and keeps the preview open when nothing was written. The spreadsheet import also drops its preview on every apply 409 but `change_in_progress`, since none of those previews can apply again, and drops its cached rows on a 409 `head_moved`.
- `@cire/api`: a comment on the apply route's guest-cap refusal says what the portal does with the reason. No behaviour change.
