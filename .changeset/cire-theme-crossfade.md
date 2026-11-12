---
"@cire/ui": minor
"@cire/host": patch
"@cire/vendor": patch
---

A theme chosen in a portal's account menu cross-fades the whole page through a view transition, on the app's `--dur-slow` and `--ease-in-out`, instead of flipping in one frame. `@cire/ui`'s `setThemePreference` takes `{ fade: true }` for this, and the account menu is the only caller that passes it. The open menu fades with the page and stays open: a press made during the fade lands on the page's snapshot, so `createPreferences` drops a `pointerdown` on `<html>` until the fade ends rather than letting the menu read it as a press outside; the press has to be made again. A second choice or a resize mid-fade skips it without an unhandled rejection. Under reduced motion, and in a browser without `document.startViewTransition`, the theme changes at once. The command palette's theme row, a theme set at boot, and one set by the OS while on "system" still change at once.
