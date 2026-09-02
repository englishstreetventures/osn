---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/vendor": patch
"@cire/landing": patch
"@cire/theme": patch
"@cire/invite-designs": patch
---

Move cire's tests out of `src/` and into each package's `tests/` tree, mirroring
the `src/` layout — the convention `wiki/conventions/testing-patterns.md` already
described and cire alone had never followed.

Test-only support code moves with them: `cire/host/src/test-support/` and
`cire/invites/src/test-support/` become `tests/test-support/`, and
`cire/api/src/test-helpers{.ts,/}` becomes `cire/api/tests/test-helpers{.ts,/}`,
so nothing test-shaped is left in the shipped source tree. `cire/db`'s seed test
moves from `seed/` to `tests/seed/`, and `cire/api`'s D1 suite from
`src/db/d1-integration.test.ts` to `tests/db/d1-integration.test.ts`.

The vitest `include`/`exclude` globs in `cire/host`, `cire/invites`,
`cire/vendor` and `cire/invite-designs` follow the move, as does the
`test-support/browser-commands.ts` import in the two browser-tier configs. Each
package's `tsconfig.json` gains `tests/**/*` so the suites stay type-checked.

No test bodies changed; only their location and the relative paths inside them.
