---
"@cire/invites": patch
---

The FAQ tests in both design packs, and in the browser tier, load the pack's lazily imported `FaqSection` before they run. The first FAQ test no longer pays the chunk's first transform inside its one-second `waitFor`, which a loaded CI runner overran.
