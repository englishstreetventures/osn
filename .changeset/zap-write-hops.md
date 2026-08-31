---
"@zap/api": patch
---

Fold Zap's per-chat write and membership paths from several round trips into one.

`sendMessage`, `listMessages` and `sendC2bMessage` each used to run a `SELECT`
for the chat row and then a separate `assertMember` query for membership,
paying two round trips before doing anything. All three now run a single
`LEFT JOIN` between `chats` and `chat_members` scoped to the caller's
`profileId`, reading chat existence and membership off one row (`memberId ===
null` is the new non-member signal, in place of `assertMember`'s empty
result set).

`createChat`, `provisionC2bChat` and `sendC2bMessage` batch their multi-row
writes (`commitBatch` from `@shared/db-utils`) instead of several sequential
`Effect.tryPromise` awaits — atomic on D1's `db.batch`, sequential-but-safe on
bun:sqlite. Member-row inserts are chunked at `MAX_MEMBER_ROWS_PER_INSERT` (20
rows/statement, new in `zap/api/src/lib/limits.ts`) to stay under D1's
~100-bound-parameter ceiling per query on a chat created at the
`MAX_CHAT_MEMBERS` (500) cap.

`addMember`'s cap-plus-duplicate check is folded into one query
(`count()` + a conditional `sum()` over `chat_members`, in place of a
`COUNT(*)` followed by a separate indexed duplicate lookup), and the
remaining concurrent-duplicate-add race — two adds of the same profile
both passing the check before either inserts — is closed by catching the
database's own unique-constraint failure on the follow-up INSERT and
resolving it to `AlreadyMember` (409) instead of `DatabaseError` (500). The
bounded `.cause`-chain walk this needs (`isUniqueConstraintFailure`, exported
for its own unit tests) accounts for D1 wrapping every failure in
`DrizzleQueryError` where bun:sqlite does not.

`createChat` and `provisionC2bChat` now cap `memberProfileIds` at
`MAX_CHAT_MEMBERS` — previously unbounded on `createChat`, so a caller could
build a batched INSERT arbitrarily larger than D1 can execute in one
invocation.

The ARC-gated DSAR account-export route (`POST /internal/account-export`)
gains an explicit cap: `profile_ids` over `MAX_EXPORT_PROFILE_IDS` (100, new
limit) now returns 400 rather than letting the loaders' `IN (...)` clauses
grow past D1's bound-parameter ceiling. Its c2b-message loader
(`loadC2bMessages`) also replaces a two-query pair — c2b chat ids for the
profiles, then messages by `inArray(messages.chatId, c2bChatIds)`, the second
query's `IN` list unbounded in parameters — with a single three-table join
scoped only by `profileIds`, and groups by `messages.id` rather than using
`DISTINCT`: the join can duplicate a message row when two exported profiles
share a chat, and the projection (`chatId`, `body`, `createdAt`) deliberately
carries no `messages.id`, so a naive `DISTINCT` on the projected columns would
collapse two genuinely different messages that share a body and the same
second-resolution `createdAt` into one row and silently drop a message from a
data subject's export.
