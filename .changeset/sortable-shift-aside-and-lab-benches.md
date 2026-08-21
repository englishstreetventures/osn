---
"@shared/sortable": patch
"@shared/toast": patch
"@osn/social": patch
"@pulse/web": patch
---

Shift the rows between a dragged item and its target, and add lab benches for
both packages.

**The fix.** `transform` returned `null` for every non-dragged row, so only the
row under the pointer moved: the list gave no preview of where the row would
land, and `EventsEditor`'s "animate the OTHER rows shifting aside" styling
animated nothing. Displacement is now computed from the `SortableProvider`'s
`ids` and a stride **measured** from the first adjacent pair of rows — the gap
lives in the consumer's CSS, so a package that assumed it would open a hole of
the wrong size. Three tests pin it.

That regression was invisible to every tier we had: happy-dom computes no
layout, so a drag test can only assert numbers against stubbed rects, and all of
those stayed green. Hence the benches — `bun run dev:lab` now carries
**shared/sortable** (drag feel, the shift/settle animation, grip hover/focus,
multi-container isolation) and **shared/toast** (tones, positions, stacking,
actions and promises, overflow). Both are co-located `*.story.tsx` files with no
lab imports, so they stay ordinary files in their own package.

Two more things the benches surfaced immediately:

- **`warning` and `info` rendered identically** in `@osn/social` and
  `@pulse/web`, because neither ramp has a warning token and both were aliased
  onto `--muted-foreground`. Warning is now a real amber per ramp, clearing
  5.6:1 light and 9.1:1 dark on its own `--popover`.
- **The lab stepped to the next story on every attempted row move.** Its
  arrow-key navigation now bails on `event.defaultPrevented`, which the grip
  already sets — so the keyboard half of `@shared/sortable`, the half with no
  other way to be exercised by hand, is reachable there. Any story that owns the
  arrows gets the same protection.
