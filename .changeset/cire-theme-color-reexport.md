---
"@cire/theme": patch
---

`@cire/theme` now re-exports the colour maths from `@shared/color` instead of
owning it. `export * from "@shared/color"` replaces `export * from "./color"`
in `src/index.ts`, and `src/palette.ts` imports the same names from there.

No consumer changes: all 24 importers — `@cire/api`'s invite schema and
service, the guest site's `dress-code-render` and `invite-theme`, the
organiser's `ColorPicker` and `PaletteField`, and both `tokens.test.ts`
copies — keep importing from `@cire/theme` and see an identical surface.
`tests/index.test.ts`, which asserts that surface, passes unchanged.

Split from the `@shared/color` changeset because `@cire/*` packages are
version-less and must never share one with a versioned package.
