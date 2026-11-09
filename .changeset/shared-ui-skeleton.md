---
"@shared/ui": minor
"@tools/lab": patch
---

New `Skeleton` (`@shared/ui/ui/skeleton`): the block a list or panel shows in place of each line, row, card or chip while it loads.

- `standsFor` names what the block stands in for and sets its corner: `line` (`rounded-ui-sm`), `row` (`rounded-ui-md`, the default and the fallback for an unknown value), `card` (`rounded-ui-lg`) or `pill` (`rounded-ui-pill`).
- `width` and `height` are spacing steps (`48` is 12rem); no width fills the container. It never runs wider than its container, a numeric width does not shrink in a flex row, and a size that is not a finite number of at least 0 is refused (full width, or a 1rem height).
- Every block fills with `--ui-surface-sunk`, with no edge, and pulses on Tailwind's `--animate-pulse` behind `motion-safe:`, so it stands still for a reader who asked for reduced motion.
- One `aria-hidden` div with no role and no children; `class` carries placement only, and no other prop reaches it.

Nothing imports it yet. The lab's `shared/ui/feedback` group draws it as `Skeletons`, `SkeletonGrounds`, `SkeletonInPlace` and `SkeletonPlayground`, and the overview has an entry.
