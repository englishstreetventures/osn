---
"@zap/api": patch
---

Removing a chat member holds its checks in the delete itself: the member goes only while the requester (when removing someone else) is still an admin, and an admin goes only while another admin stands. Of two admins leaving at once one is refused with `LastAdmin`; a requester removed in the meantime is refused with `NotChatAdmin`, and a member who has already left answers `NotChatMember`.
