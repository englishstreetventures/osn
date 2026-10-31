---
"@zap/api": patch
---

Every write to a chat or its membership holds the requester's admin role as it runs, not only as an earlier read found it. Removing a chat member deletes the member only while the requester (when removing someone else) is still an admin, and an admin only while another admin stands: of two admins leaving at once one is refused with `LastAdmin`, a requester removed in the meantime is refused with `NotChatAdmin`, and a member who has already left answers `NotChatMember`. Adding a member inserts from the requester's own admin row, and renaming a chat updates only while that row stands, so a requester removed or demoted between the check and the write is refused with `NotChatAdmin` and nothing is written. The add's insert also holds the member cap: of two adds that both read the last free place, the second inserts nothing and is refused with `MemberLimitReached`.
