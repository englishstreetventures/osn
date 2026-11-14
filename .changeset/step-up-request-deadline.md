---
"@osn/client": patch
---

Every `StepUpClient` call now ends at `STEP_UP_DEADLINE_MS` (15 s, exported) while the page is in the foreground: the token renewal `authFetch` makes first, the request, its 401 retry and the body read included. A call still waiting at the deadline is aborted and rejects with a `StepUpError` at status `0`, which `describeAuthError` reads as the connection sentence, so a step-up screen that holds its ways out while a call runs gets them back. A normal answer, a refusal and a session rejection are unchanged.
