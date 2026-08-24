---
"@osn/api": patch
"@pulse/api": patch
"@zap/api": patch
---

Add missing test coverage: the UNIQUE-constraint conflict branch in
`completeEmailChange`, and route-level 401 coverage for an expired bearer
access token on a protected Pulse and Zap route.
