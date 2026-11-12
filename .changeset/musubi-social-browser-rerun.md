---
"@musubi/social": patch
---

The browser test of a shell whose dialogs fail to load passes when Vitest runs it again in the same page (`--repeats`). Each run fails the dialogs' requests afresh and lifts the route after itself. A page keeps the dialogs' module once a load succeeds, so a repeat checks that the rail draws its Sign in at once, with the request still failing; the alert and the note's held-back Sign in are checked on the first run only, which the test reads from Vitest's repeat index. Test files only; nothing ships.
