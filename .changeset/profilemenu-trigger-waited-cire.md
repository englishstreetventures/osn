---
"@cire/host": patch
"@cire/vendor": patch
---

The host and vendor account-menu browser tests wait for the menu's trigger with `findByRole` after each render instead of reading it at once, so they still find it while a Kobalte menu holds `<body>` `aria-hidden` for a frame. Test files only; nothing ships.
