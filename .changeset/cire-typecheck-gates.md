---
"@cire/db": patch
"@cire/theme": patch
"@cire/landing": patch
"@cire/api": patch
---

Add `check` scripts to the cire packages that had none, and fix what they
caught.

`@cire/db`, `@cire/theme` and `@cire/landing` shipped with no type-check gate,
so nothing in CI read their types — `astro build` and the drizzle tooling both
strip types without checking them. All three now run `tsc --noEmit` (or
`astro check` for the Astro package) and all three pass.

`@cire/landing` caught a real bug on the way in.
`src/components/demo/Modal.motion.ts` passed `easing:` to all four of its
animations. That is the Motion **v10** key; the package is on `motion@^12.42.2`,
where it is `ease:`. Every animation had been silently running with default
easing. All four call sites now use `ease:` with v12 value names. Same v10 → v12
drift class as the invite-reveal fix in #296.

Two `TS2769`s in `@cire/theme` tests fixed without assertions: one `toEqual`
receiver flipped, one `readonly string[]` annotation added.

`cire/api/tsconfig.json` is fixed here too — it overrode the shared base's
`lib`/`types` with ES2022 and workers-types only, which made `bun:test` and
`bun:sqlite` unresolvable and `toSorted` undefined, on its own about 150 errors.
It now extends `@shared/typescript-config/node.json` and keeps `bun-types`
alongside the workers types. The `check` script itself is not added yet: the
package still has 608 errors behind an Elysia `.guard()` inference collapse,
tracked in #707. `@cire/invites` is deferred the same way with 103 errors, in
#708.

Part of #705.
