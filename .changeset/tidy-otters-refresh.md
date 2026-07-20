---
"@osn/api": patch
"@osn/client": patch
---

fix(auth): stop refresh-token rotation from logging users out on concurrent grants

Refresh-token rotation revoked the entire session family whenever two grants of the same current token raced — multiple tabs bootstrapping on reload, a cold-start bootstrap racing a 401-refresh, or a retried grant after a lost response. That is a false positive (a replay of an already-rotated token can't reach the CAS branch; only concurrent use of the live token does), and it logged legitimate users out across every device well before the 30-day session TTL.

Server (`@osn/api`): a 0-rows rotation CAS is now treated as benign concurrency (family preserved, `rotation_race` metric) instead of reuse, and `detectReuse` applies a short `ROTATION_GRACE_MS` (10 s) window — a rotated-out token replayed within the window is benign, outside it is still genuine reuse and still revokes the family. `RotatedSessionStore.check` now returns the rotation timestamp.

Client (`@osn/client`): the bootstrap and refresh paths share one `/token` single-flight so a bootstrap racing a refresh in one tab fires the grant once.
