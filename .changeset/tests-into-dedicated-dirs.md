---
"@osn/api": patch
"@osn/db": patch
"@osn/landing": patch
"@pulse/api": patch
"@pulse/landing": patch
"@zap/api": patch
---

Move every remaining colocated test file into its package's `tests/` tree, the
layout `wiki/conventions/testing-patterns.md` has documented all along.

`osn/landing` and `pulse/landing` kept their suites beside the source in `src/`
(and `pulse/landing` a third under `functions/`); those now mirror `src/` under
`tests/`. The three API packages' Miniflare-backed D1 suites move from
`src/d1-integration.test.ts` to `tests/d1/d1-integration.test.ts` — they used to
sit outside the vitest `include` glob by accident of living in `src/`, and are
now excluded from it explicitly by path, so `bun run test:d1` stays the only
thing that runs them. `tsconfig.json` gains `tests/**/*` wherever the tests were
previously type-checked only because they lived under `src/`.

No test bodies changed; only their location and the relative paths inside them.
