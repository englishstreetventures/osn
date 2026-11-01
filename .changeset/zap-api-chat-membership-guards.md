---
"@zap/api": patch
---

`createChat` holds the member cap `addMember` holds: a chat starts with at most `MAX_CHAT_MEMBERS` (500) members, the creator included. A longer list, counted after duplicates and the creator are folded out, is refused with `MemberLimitReached` before any consent check or write, and `POST /chats` answers it with 422 `{ "error": "Member limit reached" }`. `MemberLimitReached.chatId` is null for a create.

`removeMember` refuses to remove anyone from a DM, the member leaving included, with `InvalidDmMembership`, so a DM stays exactly two members after creation as well as at it. The refusal is held in the member delete's own condition, beside the last-admin rule, and `DELETE /chats/:id/members/:profileId` answers it with 422 `{ "message": "Cannot remove members from a DM" }`. A caller with no standing in the chat is answered as before, never told the chat is a DM.

The public chat reads hold the class rule the writes hold: `GET /chats/:id` and `GET /chats/:id/members` answer a member of a c2b chat 409 `{ "message": "Not a c2c chat" }`, decided after the membership check so a caller with no standing still gets 404, and `GET /chats` lists c2c chats only and answers 422 to a c2b chat as its cursor. `assertMember` is now `assertC2cMember`, which checks both in one query.
