---
"@pulse/web": patch
"@musubi/social": patch
---

Arbitrary type values move onto the contract's scales

`scripts/codemod-scale.ts` rewrote 64 values across the two Solid apps — 62 in
`@pulse/web`, 2 in `@musubi/social` — from `text-[…]`, `tracking-[…]` and
`leading-[…]` onto the contract's steps, driven by `SCALE_MIGRATION` in
`@shared/design-tokens`.

`FilterRail`'s drift guard named the old `text-[13px]` and now names
`text-ui-sm`, which is the same size on the scale; the glyphs it counts are
unchanged.
