---
"@cire/api": patch
---

Test the last-owner guard under concurrent requests on D1: two owners demoting
each other, two owners leaving, and a step-down crossing a removal each leave
exactly one owner. Test that a wedding insert whose owner-seat insert fails in
the same D1 batch leaves no wedding behind. The dev seed script's profile-id
check now matches the whole value.
