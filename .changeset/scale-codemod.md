---
"@cire/host": patch
"@cire/invites": patch
"@cire/vendor": patch
"@cire/landing": patch
---

cire's arbitrary type values move onto the contract's scales

`scripts/codemod-scale.ts` applies `SCALE_MIGRATION` from
`@shared/design-tokens` to `text-[…]`, `tracking-[…]` and `leading-[…]`. Run
across the four cire apps it rewrote **957** values in 97 files, and it is
idempotent — a second run produces no diff.

It skipped 37 computed values and named every one of them. Those are the
per-wedding heading scales —
`text-[calc(clamp(2rem,5vw,3rem)*var(--invite-heading-scale,1))]` and relatives —
where the bracket body reads a custom property an organiser sets, so there is no
single size to snap to. Snapping one would delete a feature people are paying
for, which is why the skip report is printed rather than the difference between
the totals being something a reviewer has to notice.

Four values are left because the table has no entry for them, all `em` units.
`em` is relative to the parent's size, so it is a genuinely different thing from
the `rem` steps the scale is written in; an unmapped value is a gap in the table
and therefore a decision, not something a script should round.

Two drift guards named the old strings and now name the new ones. Neither
behaviour changed: `RsvpModal`'s dietary input still steps up to 16px on mobile
to stop iOS zooming on focus, and `FilterRail`'s category glyphs are still
there.
