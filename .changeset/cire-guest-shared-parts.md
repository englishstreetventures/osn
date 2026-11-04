---
"@cire/host": patch
"@cire/vendor": patch
"@cire/invites": patch
"@cire/landing": patch
---

Both portals draw an enquiry thread with `@cire/ui`'s `MessageThread`: oldest first in timed segments, a phone tap for a message's time, a right-click or Shift+F10 for its info, and a one-line reply box whose send button appears once there is something to send. The guest site and the marketing site end on `@cire/ui`'s footer — the couple's names or the Cire logotype, the legal links in sentence case, the build's version on both — and render their legal pages through `@cire/ui`'s legal layout; the marketing build receives `PUBLIC_BUILD_SHA`. Both portals' account menus end on the build's version, and their deploy builds receive `PUBLIC_BUILD_SHA` too. The portals take their auto-size, theme and haptics helpers from `@cire/ui/lib/*` with their own storage keys, and reach `web-haptics` only through `@cire/ui`.
