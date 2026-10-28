---
"@cire/host": patch
"@tools/e2e": patch
---

Host portal: one stuck stack. Every module with sub-tabs draws a compact view bar that sticks under the top bar — the sub-tabs, then the open view's controls — and on Guests each view's own layer sticks under it: the RSVP table's head row, the households' head strip and each household's bar, the editor's card header. The RSVP and household tables scroll with the page, and below the width their columns need their rows stack. A search, filter, sort or sub-tab change made deep in a list brings it back to the stack's foot. The section intro paragraphs on the Guests tabs are gone. The E2E seating flow checks the view bar holds under the top bar.
