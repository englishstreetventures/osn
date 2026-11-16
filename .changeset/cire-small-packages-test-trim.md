---
"@cire/build-tools": patch
"@cire/db": patch
"@cire/dietary": patch
"@cire/envelope": patch
"@cire/guest-email": patch
"@cire/landing": patch
"@cire/theme": patch
---

Tests only: 22 test cases that another test in the repository already checks are gone from seven small cire packages. Each remaining cover was seen failing with the deleted case's behaviour broken. `@cire/landing`'s mutation run now completes: its Stryker-only Vitest config lets the sandbox read `@cire/ui`.
