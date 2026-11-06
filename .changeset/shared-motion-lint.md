---
"@shared/ui": patch
"@shared/toast": patch
"@pulse/web": patch
"@pulse/landing": patch
"@musubi/landing": patch
---

Every written motion value left in these packages states its reason, so `house/no-literal-motion` and `scripts/check-motion-literals.ts` pass: `Modal`'s keyword easings, the toast's curves and spinner, pulse's onboarding rings and pin, its live and brand pulses, and the landing sites' hovers and reveals, which have no motion tokens. Pulse's explore card animates `border-color`, `translate` and `box-shadow` by name rather than `transition-all`, and its onboarding step arrives on `--ui-ease-out`, the same curve it wrote out. Nothing moves differently.
