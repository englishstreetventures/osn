---
"@tools/e2e": patch
---

The E2E stack starts both osn-apis and pulse-api on `127.0.0.1` alone, as it starts both cire-apis and the stand-ins. Once the stack is up, the launcher stops the run if any API accepts a connection at the machine's network address, and skips that check, saying so, on a machine with none. `tests/stack.test.ts` holds every API spec to loopback and each package's `src/local.ts` to reading its address variable.
