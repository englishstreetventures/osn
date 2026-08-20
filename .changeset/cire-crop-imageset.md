---
"@cire/invites": patch
---

Stop the closing band fetching 1600w hero art on every phone (tracker #88). The crop layer now renders as two elements: narrow (`md:hidden`) uses `image-set(card 1x, hero 2x)` so a DPR-1 phone loads the 800w `card` variant instead of `hero`; wide (`hidden md:block`) keeps plain `hero`, unchanged, since the band renders near full viewport width there. `image-set()` only sees device-pixel-ratio, not viewport, so the viewport half of the split stays a breakpoint. A new `cropBackgroundImageSetDeclaration` in `image-crop.ts` returns a CSS declaration string (plain `url()` first, `image-set()` second, for the Safari < 17 fallback) rather than the style object `cropBackgroundStyle` returns — a style object can't repeat `background-image` — and is used only by `InviteClosing`; the three other crop-background call sites keep their unchanged object-returning helper.
