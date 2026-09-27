---
"@cire/api": patch
---

Refuse an organiser's plus-one removal that reaches someone they were not shown.
Both permission routes now take `removePlusOnes`, the plus-ones the organiser
confirmed, by id and name as `GET …/guests` served them, in place of the boolean
remove flag. Turning permission off goes through only when every plus-one in
scope is on that list, and the check runs inside the write batch, so a plus-one
named or renamed meanwhile makes the route answer `409 plus_one_named` instead of
being deleted. A plain turn-off is checked the same way, so it can no longer
commit over a plus-one named just before it. Unknown body keys are now a `400`.
