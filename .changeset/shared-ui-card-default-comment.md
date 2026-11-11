---
"@shared/ui": patch
---

`card-default.browser.test.tsx` says which apps draw the unmapped card title it holds: pulse and cire, which map no title weight. Musubi maps 500, and the metrics dashboard and the lab draw its 500. The test and its snapshot are unchanged.
