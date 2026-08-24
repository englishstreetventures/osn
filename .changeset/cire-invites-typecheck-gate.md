---
"@cire/invites": patch
---

Add `@cire/invites` to the typecheck gate (closes #689, #690).

`astro check` was never wired into `@cire/invites`, so 98 type errors across 20 files
had been accumulating unseen. Added the `check` script (matching `@cire/landing`,
`@cire/host`, `@cire/vendor`) and fixed every error to root cause, in five clusters:

- Test fixtures missing the `nickname` field `FamilyMember` requires (guest single-greeting
  logic) — added it to every fixture, never loosened the type.
- Bare `let ref: T` Solid refs assigned only inside JSX (`panelRef`, `backdropRef`,
  `eventsSectionRef`) — switched to the repo's existing `let ref!: T` definite-assignment
  pattern (already used in `cire/landing`'s `DemoModal`/`WaxSeal3D`/`VineCanvas`).
- Implicit-`any` params on `vi.fn()` test hooks and a `claimWith` test helper that took
  `never[]` and cast around it — gave both real signatures matching
  `unlockRevealSequence`/`RevealHooks`, and removed pre-existing `as never`/
  `as unknown as` casts in `gala/InvitePage.test.tsx` while at it.
- Two `.astro` syntax errors (ts1381/ts1005) in `classic/Document.astro` and
  `gala/Document.astro`: a developer comment sat between the `<InvitePage` tag and its
  attribute list, an invalid JSX-comment position. Moved the identical comment text above
  the tag — no rendered/guest-facing markup changed.
- `lib` bumped `ES2022` → `ES2023` in `cire/invites/tsconfig.json` for `toSorted`/
  `toReversed`, matching `cire/api`/`cire/host`/`pulse/web`/`osn/social` precedent; and an
  `Omit<...> & {...}` fix for a `requestIdleCallback` intersection-type conflict with DOM lib.

Pinned `typescript@^6.0.3` and `@astrojs/check@0.9.10` to match the three sibling Astro
packages exactly (TypeScript 7 crashes `@astrojs/language-server`). No `as any`,
`@ts-expect-error`, `@ts-nocheck`, or type-widening used anywhere in the fix.
