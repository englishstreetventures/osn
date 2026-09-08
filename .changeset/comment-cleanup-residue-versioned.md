---
"@osn/api": patch
"@pulse/api": patch
"@shared/observability": patch
---

State four comment constraints directly instead of citing a tracker finding.

`recommendations.ts` carried D1's 100-bound-parameter cap as a tracker citation
three times over; each now states the constraint, and a claim the old text made
about the query binding `profileId` "once" is corrected — it binds a fixed
number of times, which is what the file's own measurement a few hundred lines
down already said. `d1ParamCounts.test.ts` loses five tracker numbers that its
own six-site index already covers, and `redact.ts` loses a finding tag from its
fast-path note. The deny-list's three-part admission test is untouched.

No behavior changes; every edit is comment text.
