---
"@tools/lab": patch
---

Bench `@shared/toast` and `@shared/sortable` in the component lab, and stop the
lab swallowing a story's arrow keys.

Drag feel, the shift/settle animation, grip hover/focus and painted toast colour
are invisible to every test tier we have — happy-dom computes no layout, so a
drag test can only assert numbers against stubbed rects. `bun run dev:lab` now
carries **shared/sortable** (drag feel, multi-container isolation, the keyboard
path) and **shared/toast** (tones, positions, stacking, actions and promises,
overflow). Both are co-located `*.story.tsx` with no lab imports, so they stay
ordinary files in their own package.

The lab's arrow-key story navigation now bails on `event.defaultPrevented`, which
`@shared/sortable`'s grip already sets. Without that the lab stepped to the next
story on every attempted row move, which made the keyboard half of that package —
the half with no other way to be exercised by hand — untestable there. Any story
that owns the arrows gets the same protection.
