---
"@osn/api": patch
---

Make two flaky `@osn/api` tests deterministic. No runtime behaviour changes.

- `tests/lib/background.test.ts`, "is a no-op reference outside a request": the test waited a fixed 10 ms for the detached fiber and failed in CI when the scheduler was slower. The forked effect now resolves a promise and the test awaits it, so it passes whenever the work runs and fails on Vitest's timeout if `forkBackground` stops running work outside a request.
- `tests/services/recovery-session.test.ts`, "a rotation late in the window mints a token that dies with the row": the session's deadline came from the real clock and the test read the clock again afterwards, so a second boundary between the two reads left 29 seconds instead of 30. The test now freezes `Date` at a fixed base before issuing the session and moves it by a whole number of seconds.

Two doc comments in `src/lib/background.ts` now say what the no-op sink drops (the completion promise) and what still happens (the work runs).
