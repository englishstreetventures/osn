---
"@shared/ui": patch
---

`Modal`'s comment on its keyword curves says why its exit does not read the new `--ui-ease-exit`: its `ease-in` speeds up as the dialog goes, and the Kobalte overlays' exit curve slows down. Its stylesheet is unchanged. `overlay-motion.browser.test.tsx` holds `Dialog`, `Popover` and the default menu closing on `--ui-ease-exit`, apart from `--ui-ease-out`, and `dialog-default.browser.test.tsx` holds an unmapped `Dialog`'s entry and exit on `cubic-bezier(0.22, 1, 0.36, 1)`.
