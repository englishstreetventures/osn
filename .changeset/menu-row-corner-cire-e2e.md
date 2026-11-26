---
"@cire/host": patch
"@cire/vendor": patch
"@tools/e2e": patch
---

cire's radius test holds the new `--ui-radius-menu-row` role unmapped in all four cire stylesheets, so every cire menu row takes `--ui-radius-sm`, the 6px the test already holds; a stylesheet that mapped it fails there. The host portal's `DESIGN.md` §4 names the role behind its portal menu rows. `pulse-event-rsvp` reads a row of each of pulse's avatar menus at 6px under pulse's own stylesheet.
