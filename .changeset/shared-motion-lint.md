---
"@shared/ui": patch
"@shared/toast": patch
"@pulse/web": patch
"@pulse/landing": patch
"@musubi/landing": patch
---

Every written motion value left in these packages states its reason, so `house/no-literal-motion` and `scripts/check-motion-literals.ts` pass: `Modal`'s keyword easings, the toast's curves and spinner, pulse's onboarding rings, pin and their staggers, its live and brand pulses, and the landing sites' hovers and reveals, which have no motion tokens. Pulse's own motion now reads the token of its job: the calendar's reminder buttons, the onboarding chips and the explore card lift on `--ui-dur-fast` (120ms), the onboarding step and the header's "Create new event" button and label on `--ui-dur-base` (200ms), and the onboarding progress fill on `--ui-dur-slow`, all on `--ui-ease-out`. The explore card animates `border-color`, `translate` and `box-shadow` by name rather than `transition-all`.
