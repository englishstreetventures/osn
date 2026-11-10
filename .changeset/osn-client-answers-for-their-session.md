---
"@osn/client": patch
---

A late answer for a session that was replaced or ended no longer changes the page's session; such calls reject with `AuthExpiredError`, and a refused `refreshSession` ends the session.
