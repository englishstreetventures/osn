---
"@zap/api": patch
---

`createChat` holds the member cap `addMember` holds: a chat starts with at most `MAX_CHAT_MEMBERS` (500) members, the creator included. A longer list, counted after duplicates and the creator are folded out, is refused with `MemberLimitReached` before any consent check or write, and `POST /chats` answers it with 422 `{ "error": "Member limit reached" }`. `MemberLimitReached.chatId` is null for a create.

`removeMember` refuses to remove anyone from a DM, the member leaving included, with `InvalidDmMembership`, so a DM stays exactly two members after creation as well as at it. The refusal is held in the member delete's own condition, beside the last-admin rule, and `DELETE /chats/:id/members/:profileId` answers it with 422 `{ "message": "Cannot remove members from a DM" }`. A caller with no standing in the chat is answered as before, never told the chat is a DM.
