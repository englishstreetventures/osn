---
"@shared/ui": patch
---

Three browser test files pass when Vitest runs each test again in the same page (`--repeats`). `data.browser.test.tsx` clears the page and scrolls back to the top after each test. A page keeps the orb's module once it arrives, so in the two busy-button files a repeat checks that a busy button draws the orb at once and fetches nothing more; the room the orb waits in, and the fetch after a failed one, are checked on the first run only. The test of a failed fetch waits for its own run's fetch, not one an earlier run made. No component changes.
