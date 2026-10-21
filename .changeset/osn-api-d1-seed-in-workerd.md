---
"@osn/api": patch
---

The D1 integration file no longer times out on a busy machine. Its bulk
fixtures (the co-member fan-out's 1,522 rows, the friend-of-friend test's 191
and the profile-list tests' 150 and 62) are written inside workerd as one D1
batch per test, instead of a proxied `prepare` and `bind` per statement, and
every test and hook in the file runs on a 30-second budget. Test-only: nothing
that ships changes.
