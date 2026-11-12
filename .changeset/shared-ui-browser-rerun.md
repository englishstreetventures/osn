---
"@shared/ui": patch
---

Three browser test files pass when Vitest runs each test again in the same page (`--repeats`). `data.browser.test.tsx` clears the page and scrolls back to the top after each test. A page keeps the orb's module once it arrives, so in the two busy-button files a repeat checks that a busy button draws the orb at once; the room the orb waits in, when its fetch starts, and the fetch after a failed one are checked on the first run only, which each test reads from Vitest's repeat index. The test of a failed fetch waits for its own run's fetch, not one an earlier run made. Neither file sleeps for a fixed time: the failed-fetch test waits for an idle callback queued after the button's and then for its own import of the orb to fail, and the load test waits for an idle callback queued after the button's, then checks that the one fetch started after the button turned busy. No component changes.
