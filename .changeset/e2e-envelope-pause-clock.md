---
"@tools/e2e": patch
---

The envelope flow pauses the page clock in a way that cannot fail on a slow runner: it freezes `Date` at the time it read from the page, pauses 16 ms past that, then lets `Date` move again, so `pauseAt` is never asked for a time the running clock has passed.
