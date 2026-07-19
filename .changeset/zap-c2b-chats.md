---
"@zap/api": minor
"@zap/db": minor
---

Add a server-visible c2b (consumer-to-business) chat class to Zap: `chats.class`, plaintext `messages.body`, ARC-gated `/internal/chats` provisioning + message CRUD (scope `chat:c2b`), and c2b bodies in the DSAR export. Adds a dormant `deploy-zap-api` CI job (activates once the prod D1 is provisioned).
