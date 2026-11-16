---
"@cire/host": patch
---

The loading-placeholder browser test pins the page's clock to a week before
its fixture's first event. The overview's agenda drops events dated before
today, so from 15 November 2026 the fixture's fixed dates left the band empty
and both overview cases failed on every run. Test-only; nothing shipped changes.
