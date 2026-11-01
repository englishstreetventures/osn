---
"@zap/api": patch
---

`createChat` holds the member cap `addMember` holds: a chat starts with at most `MAX_CHAT_MEMBERS` (500) members, the creator included. A longer list, counted after duplicates and the creator are folded out, is refused with `MemberLimitReached` before any consent check or write, and `POST /chats` answers it with 422 `{ "error": "Member limit reached" }`. `MemberLimitReached.chatId` is null for a create.
