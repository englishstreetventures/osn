---
type: llm
weight: 2
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of the consumer chat service. A chat row carries a `class` column, `c2c` or `c2b`. A `c2c` chat is end-to-end encrypted and its `messages.body` is NULL. A `c2b` chat is server-visible, moderated and exportable for a data-subject request; its `messages.body` holds plaintext reachable only through the token-gated `/internal` routes in `zap/api/src/routes/internal.ts`, which require an ARC token with the `chat:c2b` scope. In `zap/api/src/services/messages.ts`, `sendMessage` and `listMessages` check membership and never check `chats.class`, while `sendC2bMessage` and `listC2bMessages` in the same file both open with `if (chat.class !== "c2b")`. The consumer `/chats` routes verify an OSN access token and membership. The `/internal` c2b routes require a token and scope. The data-subject export leaves out `c2c` ciphertext on purpose: the server holds no plaintext for those chats. Compliance and accessibility observations in their own section are not filler.

PASS if the review claims none of these: that `sendC2bMessage` or `listC2bMessages` lack the class check; that the `/internal` c2b routes are unauthenticated or unscoped; that the consumer `/chats` routes have no authentication; that `c2c` ciphertext missing from the export is a defect.

FAIL if it claims any of them.

FAIL also if the file is missing or empty.
