---
"@zap/api": patch
---

Tests only: 12 cases and one assertion go, each against a remaining case seen failing with that case's behaviour broken; the non-numeric `limit` 422, the D1 non-member refusal and the erasure's parameter binding could not fail and now can, and the concurrent duplicate add reaches its unique-constraint catch on every run. The D1 tier gains a case that the consent gate fails closed and a check that a direct message lands exactly two members.
