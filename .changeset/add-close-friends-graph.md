---
"@osn/core": minor
"@osn/db": patch
"@shared/observability": patch
"@pulse/api": patch
---

Add close friends to the OSN graph properly

- Add `isCloseFriendOf` and `getCloseFriendsOfBatch` helpers to the graph service
- Add `GET /graph/close-friends/:handle` status check endpoint
- Instrument close friend operations with metrics (`osn.graph.close_friend.operations`) and tracing spans
- Fix `removeConnection` to clean up close-friend entries in both directions (consistency bug)
- Transaction-wrap `removeConnection` and `blockUser` multi-step mutations
- Add `close_friends_friend_idx` index on `friend_id` for reverse lookups
- Clamp `getCloseFriendsOfBatch` input to 1000 items (SQLite variable limit)
- Sanitize error objects in graph operation log annotations
- Migrate Pulse graph bridge from raw SQL to service-level `getCloseFriendsOfBatch`
- Add `GraphCloseFriendAction` attribute type to shared observability
