---
"@osn/client": patch
"@osn/auth-ui": patch
---

`describeAuthError(err, "code")` gives its own sentence for a call that got no answer (status `0`): "We couldn't connect. Check your connection, then try again with a new code." The server may have taken the code before the answer was lost, and it refuses the same code again as a replay that counts toward the lockout. `StepUpDialog` empties its code boxes on such a failure, the step-up deadline included, so a second Confirm sends nothing until a new code is typed.
