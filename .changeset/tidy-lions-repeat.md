---
"@zap/api": patch
"@zap/db": patch
---

Enforce the chat class on every public chat operation, and finish the returned-row conversion.

Four public operations never checked `chats.class`. `sendMessage` let a member of a `c2b` (consumer-to-business) chat write an encrypted message into it; `listMessages` served that chat's plaintext `body` column straight back, going round the ARC-gated reader that is supposed to be the only way to it; `removeMember` let a member leave a chat cire had authorised, which silently truncated their own DSAR export, because the export reaches c2b message bodies only through `chat_members`; and `updateChat`/`addMember` were closed to c2b chats only by accident, since such a chat has no admin for `assertAdmin` to reject. A `c2b` chat is defined as server-visible, moderatable and DSAR-exportable; a ciphertext row inside one is none of those — the account export filters on a non-null `body` so the row is dropped silently, and the internal reader renders it as an empty string with no signal that content was withheld. All of them now fail `NotC2cChat`, reported as 409, mirroring the check `sendC2bMessage` already made the other way round. On the two public message routes the class check runs *after* the membership check — unlike its ARC-gated counterpart, because answering "not a c2c chat" to a stranger holding a chat id would tell them which ids are commercial.

`addMember` and `updateChat` were the last two write paths still re-reading the row they had just written. They now return what they wrote, through `storedNow()` — and `updateChat` keeps the stored title when a request sends none, which is what Drizzle's omit-undefined `SET` does and what the read-back used to get right by accident.

`zap/db`'s DDL lockstep test now also checks `drizzle/meta/`: `drizzle-kit generate` reads the journal and the latest snapshot rather than the `.sql` files, so a journal that has lost an entry makes the next generate re-emit a migration already applied to production.
