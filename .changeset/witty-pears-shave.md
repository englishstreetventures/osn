---
"@tools/pr-metrics": patch
---

Price a model id that carries its snapshot date. Transcripts name Haiku as
`claude-haiku-4-5-20251001` while the rate table is keyed bare, so the lookup
missed and every Haiku session costed zero. The date now comes off before the
table is read.
