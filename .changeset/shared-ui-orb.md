---
"@shared/ui": minor
"@tools/lab": patch
---

Add `Orb` (`@shared/ui/ui/orb`): a dotted sphere drawn into a canvas that moves
while something is in progress, in one of nine states at 20 or 64px. Its ink
is the text colour it inherits, so it reads on whatever ground that text is set
for. It moves for five seconds at most, then holds one still frame; it holds
that frame from the start under `prefers-reduced-motion: reduce` and follows a
change of that preference. It stops drawing off screen and in a hidden tab,
keeps every orb on one animation loop and one clock, sizes its bitmap from the
box it measures, and caps it at two device pixels per CSS pixel. The canvas is `aria-hidden`; it
belongs inside a control whose own label says what is happening. `Button`'s
`busy` draws it.

The drawing engine is upstream's thinking-orbs engine (MIT), vendored byte for
byte into `shared/ui/vendor/thinking-orbs/` at a pinned commit. The export
points TypeScript at a types-only `src/ui/orb-api.ts`, so a consumer's type
check never reads the engine.

The lab gains `shared/ui/Orb` (`States`, `InButtons`, `Playground`) and an
`Orb` row on the `shared/ui` overview.

`scripts/verify-vendored-anti-slop.sh` becomes `scripts/verify-vendored.sh
<tree> [base-ref] [repo-root]`, which checks any vendored tree; CI's
`script-tests` job runs it on every tree `scripts/vendored-trees.txt` lists.
