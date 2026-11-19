---
"@tools/e2e": patch
---

`cire-remove-my-data` opens Musubi's Connected apps, checks cire's "Remove my data from Cire" link (its address, a tab of its own, no opener or referrer) and follows it to cire's removal screen. The seed gives cire's client its link and the removal person a cire consent; the stack's osn-api gains `CIRE_ORGANISER_ORIGIN`.
