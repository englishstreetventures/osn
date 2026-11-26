---
"@osn/api": patch
---

osn-api's account-deletion laws and the model they are proved about move into `laws/account-deletion/`, beside the code; the agreement tests in `tests/laws/` import the model from there and run in the ordinary `test`, as a vitest project of their own. No production code changes.
