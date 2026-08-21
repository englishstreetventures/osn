---
title: Close Friends (moved)
tags: [systems, pulse, retired]
status: retired
related:
  - "[[pulse-close-friends]]"
  - "[[social-graph]]"
last-reviewed: 2026-08-21
---

# Close Friends (moved)

Close friends is no longer an OSN-core feature. The list and all related code now live in Pulse — see **[[pulse-close-friends]]**.

OSN core retains only `connections` and `blocks`. Other OSN apps that want their own close-friends-style list should follow the same pattern: own a local table, validate membership eligibility against the OSN graph via the `graph:read` ARC scope.
