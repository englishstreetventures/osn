---
"@cire/api": patch
"@cire/db": patch
"@cire/web": patch
"@cire/organiser": patch
---

Fixes and coverage from the pre-merge review gate.

- **Fonts were silently dropped from the server-rendered palette** (S-L1). The
  raw-attribute filter in `styleAttr` rejected `"`, and every stack in
  `FONT_STACKS` contains a quoted family name — so a themed invite
  server-rendered its colours but not its typography and only picked the fonts
  up on hydration. The filter now rejects only what can open a second
  declaration.
- **A cleared font left a stale value on the document root forever** (P-W2).
  `applyPaletteToRoot` only ever added properties; it now removes what the
  previous apply set and the new theme omits.
- **Migration 0044 flattened section backgrounds it should have preserved.**
  The back-fill kept the story band's surface as a tone but not the events or
  welcome sections', so the one live customised invite would have had two
  sections visibly change. Each section's tone is now conditional on whether it
  actually painted a surface.
- **The preview tier reported itself as `local`** (S-M2), skipping the
  fail-closed boot guard for a missing `CLAIM_RATE_LIMITER` binding on a
  publicly reachable Worker.
- **Every theme-var style sink now filters** (S-L2), not just `AnimatedModal`.
- **The builder derived its palette up to six times per pointer frame** (P-W1)
  during a colour drag; the derivations are memoised.

New coverage for the gaps the test review found: the wire-shape lockstep the
deleted mirror test used to provide (T-S1), the migration's conditional
back-fills including multi-row and the intended data loss (T-S2/T-S10–12), the
preview seed (T-M1), the picker's oklch conversion and fallback (T-U1), the
third surface's contrast pairs (T-U4), the font-choice lockstep a comment
already promised (T-S9), 400s for out-of-enum tones and presets (T-R1), and
builder↔guest agreement on a preset-only scheme (T-S3).
