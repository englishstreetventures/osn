---
"@shared/ui": patch
---

Wait on the condition, not on one macrotask, in the `Modal` browser tests.

`tells the caller when the element closes itself` awaited a single
`setTimeout(0)` before asserting that `open` had cleared. The dialog's `close`
event is queued rather than synchronous — the test's own comment says so — but
one `setTimeout(0)` yields exactly one macrotask, and on a loaded CI runner the
handler had sometimes not run by then. It failed as `expected true to be false`:
a scheduling race wearing the costume of the desync the test exists to catch,
reddening a pull request that touched nothing in this package.

Both that test and the reduced-motion exit case now use `vi.waitFor`, which
polls until the assertion holds. A slow runner costs milliseconds instead of a
false failure, and a genuine desync still fails — verified by removing the
component's `close` listener and watching it go red.

The two remaining fixed waits in the file are deliberate and now say so: each
asserts that something does **not** happen over an interval, where a condition
wait would return on its first tick and prove nothing.
