---
type: llm
weight: 2
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of the consumer chat service. A chat row carries a `class` column, `c2c` or `c2b`. A `c2c` chat is end-to-end encrypted and its `messages.body` is NULL. A `c2b` chat is server-visible, moderated and exportable for a data-subject request; its `messages.body` holds plaintext reachable only through the token-gated `/internal` routes in `zap/api/src/routes/internal.ts`, which require an ARC token with the `chat:c2b` scope. In `zap/api/src/services/messages.ts`, `sendMessage` and `listMessages` check membership and never check `chats.class`, while `sendC2bMessage` and `listC2bMessages` in the same file both open with `if (chat.class !== "c2b")`.

PASS if the review reports that `sendMessage` in `zap/api/src/services/messages.ts` enforces membership but not the chat's `class`, naming the file and the function or line. Naming the asymmetry with `sendC2bMessage`, which does check, counts as naming the defect.

FAIL if the gap is not reported.

FAIL also if the file is missing or empty.
