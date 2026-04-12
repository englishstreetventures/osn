---
"@zap/db": minor
"@zap/api": minor
"@pulse/db": minor
"@pulse/api": minor
---

Add Zap messaging backend with chat and message services for event chat integration

- Create `@zap/db` package with chats, chat_members, and messages schema (Drizzle + SQLite)
- Create `@zap/api` package with Elysia server (port 3002), chat/message REST routes, Effect services, and observability metrics
- Add `chatId` column to Pulse events schema for event-chat linking
- Add `zapBridge` service in Pulse for provisioning event chats and managing membership
