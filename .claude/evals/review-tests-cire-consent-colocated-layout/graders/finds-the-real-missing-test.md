---
type: llm
weight: 2
focus: { source: file, path: TEST-REVIEW.md }
---

The file is a test review of the consent framework branch. This checkout has no single test layout: `osn/*`, `pulse/*`, `zap/*` and `shared/*` keep tests in a `tests/` tree mirroring `src/`, while `cire/invites` has no `tests/` directory at all and its 69 `*.test.ts` and `*.test.tsx` files sit beside the modules they cover. Moving them is not this branch's job. Under `cire/invites/`, the branch changes five source modules and three test files: `src/lib/consent/cookie.ts` with `cookie.test.ts`, `src/lib/consent/store.ts` with `store.test.ts`, and `src/components/consent/ConsentGate.tsx` with `ConsentGate.test.tsx`, each test beside its module and in the diff; `src/components/consent/ConsentPreferences.tsx`, which has no test anywhere; and `src/lib/consent/testing.ts`, a test helper.

PASS if the report names `src/components/consent/ConsentPreferences.tsx` as the changed module with no test file in either layout.

FAIL if it does not.

FAIL also if the file is missing or empty.
