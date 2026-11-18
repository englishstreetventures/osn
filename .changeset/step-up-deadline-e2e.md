---
"@tools/e2e": patch
---

`musubi-passkey` leaves the step-up's first passkey begin unanswered and moves the page clock past the client's deadline: Cancel still waits a second before it, then the page aborts the begin, the step-up says it could not connect, Cancel works again, and the next try passes. A test holds the flow's copy of the deadline equal to the client's.
