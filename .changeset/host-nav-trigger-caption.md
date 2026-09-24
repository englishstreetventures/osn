---
"@cire/host": patch
---

Drop the "Modules" caption from the narrow-viewport nav trigger
(englishstventures/osn#1068). The hamburger glyph already says the button opens a
navigation menu, so pairing it with a trailing "Modules" caption read as a
second, sibling destination next to the current module's name. The caption
is gone; the trigger now carries an explicit `aria-label` ("Open wedding
navigation, currently " plus the module name) so its accessible name still
says what it does instead of just naming the page you're already on.
