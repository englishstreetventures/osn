---
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/ui": patch
"@cire/vendor": patch
---

Move `solid-js` from 1.9.15 to 1.9.18. The module shell test's stand-in for
the organiser app now writes the module and its sub in one batch, as the app's
single route write does. Unbatched, the shell briefly rendered the new module
on the old sub, and with 1.9.18's `lazy()` keeping the builder loaded that
stop mounted it synchronously.
