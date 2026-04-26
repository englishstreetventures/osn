---
title: Close Friends (moved)
status: retired
related:
  - "[[pulse-close-friends]]"
last-reviewed: 2026-04-26
---

# Close Friends (moved)

Close friends is no longer an OSN-core feature. The list and all related code now live in Pulse — see **[[pulse-close-friends]]**.

OSN core retains only `connections` and `blocks`. Other OSN apps that want their own close-friends-style list should follow the same pattern: own a local table, validate membership eligibility against the OSN graph via the `graph:read` ARC scope.
