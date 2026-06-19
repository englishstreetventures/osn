---
"@cire/web": patch
---

Fix the "Add to Calendar" button doing nothing.

`AddToCalendar` is only ever opened from inside the event details modal
(`AnimatedModal`, `z-100`), but its portalled popover menu was `z-90` — below
the modal — so the Google Calendar / `.ics` menu rendered behind the modal
backdrop and was invisible and unclickable. Raised the popover to `z-110` so it
paints above the modal it's launched from. Added a regression test asserting the
menu sits above the modal layer.
