---
"@cire/invites": patch
"@cire/ui": patch
"@cire/landing": patch
---

A hero with no couple title now holds "You're Invited" and "Welcome back to your invite" in one grid cell from its first paint, with the one not shown hidden from sight and from screen readers, so turning to the welcome-back title changes only which string is painted. A first visit's title-less hero is up to one line taller. On the RSVP sheet and the landing page's demo sheet, the dietary picker's pills now wrap into rows from the `md:` breakpoint instead of scrolling sideways; the sheet keeps its 480px width and phones keep the sideways track. `DietaryPresets` takes `wrap="md"` for that.
