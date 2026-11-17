---
"@tools/e2e": patch
---

The E2E stack starts both osn-apis and pulse-api on `127.0.0.1` alone, as it starts both cire-apis and the stand-ins. `tests/stack.test.ts` holds every API the stack starts to loopback, and each package's `src/local.ts` to reading its address variable.
