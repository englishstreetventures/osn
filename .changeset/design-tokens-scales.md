---
"@shared/design-tokens": minor
---

Add the four size scales and the migration table that carries the tree onto
them.

**Type — 7 steps** (`xs` 0.7 · `sm` 0.8 · `base` 0.9 · `md` 1.05 · `lg` 1.3 ·
`xl` 1.75 · `2xl` 2.5rem), clustered from 956 sites carrying **93 distinct
font sizes**, nine of them between 0.7rem and 0.95rem. Seven and not eleven
because a scale nobody can hold in their head is another way of having no
scale. 749 of 853 mappable sites move by a pixel or less.

**Tracking** 6 steps from 18 values (nothing moves more than 0.04em),
**leading** 5 from 12 (nothing more than 0.05), **measure** 7 content widths,
one unit — `max-w-[640px]` and `max-w-[40rem]` were the same number written
twice.

`SCALE_MIGRATION` is derived, not hand-written: every value goes to its nearest
step, an exact tie resolving up. The test re-derives it and fails if the table
and the rule disagree, which caught two hand-entered errors (`16.5px` and
`0.98rem` were both filed a step too low).

Documented exclusions the codemod must respect: computed values
(`calc`/`clamp`/`var` — cire's organiser-chosen heading scale is one),
`data-[…]`/`aria-[…]` variants that merely share the bracket syntax, and
one-off layout constants, which are not measures. Six sites at 8–9.5px sit
below the smallest step and move 2–3px; those want a designer rather than a
substitution.
