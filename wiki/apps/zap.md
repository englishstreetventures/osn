---
title: Zap
description: Zap messaging app -- currently placeholder
tags: [app, messaging, planned]
status: planned
packages:
  - "@zap/app"
  - "@zap/api"
  - "@zap/db"
---

# Zap

Zap is OSN's end-to-end encrypted messaging app. It is currently a **placeholder** -- the `zap/` directory exists but contains no implementation yet.

## Planned Architecture

The stack matches Pulse:

- **@zap/app** -- Tauri + SolidJS messaging client
- **@zap/api** -- Elysia + Eden messaging server
- **@zap/db** -- Drizzle + SQLite (chats, messages, group state)

Additional dependencies:

- **Bun** runtime
- **Effect.ts** for service layer
- **Signal Protocol** (lives in `@osn/crypto`, not `zap/`)

### Shared Messaging Backend

The messaging backend (`@zap/api`) is a **shared service**:

- **Zap** consumes it directly as its primary interface
- **Pulse** uses it indirectly for event group chats
- Users do **not** need a Zap install to participate in event group chats

## Milestone Roadmap

### M0: Scaffold

- Tauri app scaffolding (`bunx create-tauri-app`)
- API server scaffolding (Elysia + Eden)
- DB schema setup (Drizzle + SQLite)
- Auth integration with OSN Core
- Test infrastructure
- Turbo pipeline configuration

### M1: 1:1 DMs

- Signal Protocol integration (Double Ratchet, X3DH key agreement)
- Database schema for conversations and messages
- API routes for message CRUD
- WebSocket transport for real-time delivery
- Read receipts and delivery receipts
- Disappearing messages (timer-based)

### M2: Group Chats

- MLS or Sender Keys for group encryption
- Group roles (admin, member)
- Group invites and membership management
- Event chat linking (Pulse integration point)

### M3: Organisation Chats

- Verified organisation accounts
- Organisation dashboards
- Embeddable chat widget
- E-commerce integrations

### M4: Locality / Government Channels

- Location-based channels
- Government/institutional communication channels

### M5: Polish + AI View + Native

- AI-powered message views and summaries
- Native platform polish
- Performance optimisation

## Open Questions

These are tracked in the Deferred Decisions section of TODO.md:

| Question | Options | Notes |
|----------|---------|-------|
| Signal vs MLS | Signal Protocol (1:1), MLS (group) | Could use Signal for 1:1 and MLS for groups |
| Storage backend | SQLite (local), server-side storage | E2E means server stores ciphertext only |
| Media handling | Direct upload, CDN, P2P | Encrypted media blobs need a delivery mechanism |
| Spam / abuse | Content moderation on ciphertext? | E2E makes server-side moderation impossible; need client-side reporting |

## WebSocket Spans

WebSocket per-message spans are out of scope for the initial observability rollout. They are flagged to be added when `@zap/api` lands (M1).

## Related

- [[social-graph]] -- user relationships drive messaging visibility
- [[arc-tokens]] -- S2S auth for Zap API to OSN Core calls
- [[monorepo-structure]] -- workspace layout and the `@zap/*` prefix
