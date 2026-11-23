---
"@osn/auth-ui": patch
---

Tests only: 17 cases go that another `@osn/auth-ui` case was seen to fail for under a hand break of the source line each guarded. Twelve cases that could not fail for what they name, or waited on the real clock, are repaired, and StepUpDialog's Resend cases stop leaking a testing-library poll onto the fake clock. No component changes.
