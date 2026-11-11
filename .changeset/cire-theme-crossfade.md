---
"@cire/ui": minor
"@cire/host": patch
"@cire/vendor": patch
---

A theme chosen in a portal's account menu cross-fades the whole page through a view transition, on the app's `--dur-slow` and `--ease-in-out`, instead of flipping in one frame. The open menu fades with the page and stays open: a press made during the fade lands on the page's snapshot, so `@cire/ui`'s `createPreferences` holds it back until the fade ends rather than letting the menu read it as a press outside. Under reduced motion, and in a browser without `document.startViewTransition`, the theme changes at once. A theme set at boot or by the OS while on "system" still changes at once.
