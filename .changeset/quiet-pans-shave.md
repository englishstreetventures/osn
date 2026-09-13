---
"@osn/api": patch
---

Stop the same-second passkey-provenance test from depending on the wall clock. It enrolled two credentials back to back and asserted they shared a unix second; when the second turned over between them the precondition failed in the test's own setup, before the guard it exists to check ever ran. Both rows are now stamped onto one named second.
