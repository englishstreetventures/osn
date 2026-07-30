---
"@cire/organiser": patch
---

Show the invite builder one section at a time.

The invite builder's eight section cards used to stack in one long vertical
page with a sticky pill row that scrolled to each one. The pill row is now a
real tab switcher — one section shown at a time — and a "Preview" button next
to it opens the composed live preview in a modal on mobile, where there's no
room for the sticky side pane. Also fixed the mobile preview's hero title
being disproportionately large: it scaled off the real browser viewport
(`vw`) instead of the small preview box it actually renders into.
