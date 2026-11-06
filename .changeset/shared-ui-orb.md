---
"@shared/ui": minor
"@tools/lab": patch
---

Add `Orb` (`@shared/ui/ui/orb`): a dotted sphere drawn into a canvas that moves
while something is in progress, in one of nine states at 20 or 64px, with dark
or light ink. It holds one still frame under `prefers-reduced-motion: reduce`
and follows a change of that preference, stops drawing off screen and in a
hidden tab, keeps every orb on one animation loop and one clock, and caps its
bitmap at two device pixels per CSS pixel. The canvas is `aria-hidden`; it
belongs inside a control whose own label says what is happening. Nothing
imports it yet.

The drawing engine is upstream's thinking-orbs engine (MIT), vendored byte for
byte into `shared/ui/vendor/thinking-orbs/` at a pinned commit. The export
points TypeScript at a types-only `src/ui/orb-api.ts`, so a consumer's type
check never reads the engine.

The lab gains `shared/ui/Orb` (`States`, `OnAccent`, `Playground`) and an
`Orb` row on the `shared/ui` overview.

`scripts/verify-vendored-anti-slop.sh` becomes `scripts/verify-vendored.sh
<tree> [base-ref] [repo-root]`, which checks any vendored tree; CI's
`script-tests` job runs it on every tree that has a `SHA256SUMS`.
