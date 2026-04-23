---
title: Zap
description: Zap messaging app — API + DB scaffolded; client app planned
tags: [app, messaging]
status: in-progress
packages:
  - "@zap/api"
  - "@zap/db"
related:
  - "[[social-graph]]"
  - "[[arc-tokens]]"
  - "[[monorepo-structure]]"
last-reviewed: 2026-04-23
---

# Zap

Zap is OSN's end-to-end encrypted messaging app. The backend (`@zap/api`, `@zap/db`) is scaffolded and runs on **port 3002**. The Tauri client (`@zap/app`) has not been started yet — see `wiki/TODO.md` for milestone status.

## Status by package

| Package | Purpose | Status |
|---|---|---|
| `@zap/api` | Elysia messaging server (port 3002) | M0 scaffolded — routes/services skeleton in place; M1 (1:1 DMs over Signal) in flight |
| `@zap/db` | Drizzle + SQLite schema (chats, messages, group state) | M0 scaffolded |
| `@zap/app` | Tauri + SolidJS messaging client | Not started |

The Signal Protocol implementation lives in `@shared/crypto` (alongside ARC tokens), not in `zap/` — every OSN app that needs E2E messaging consumes it from there.

### Shared messaging backend

`@zap/api` is a **shared service**:

- **Zap** consumes it directly as its primary interface.
- **Pulse** uses it indirectly for event group chats.
- Users do **not** need a Zap install to participate in event group chats.

## Milestone roadmap

| Milestone | Scope |
|---|---|
| **M0 – Scaffold** | Tauri / API / DB skeletons, OSN auth integration, test infra, Turbo pipeline |
| **M1 – 1:1 DMs** | Signal Protocol (Double Ratchet, X3DH), message CRUD, WebSocket transport, read/delivery receipts, disappearing messages |
| **M2 – Group chats** | MLS or Sender Keys for group encryption, roles, invites; Pulse event-chat hookup |
| **M3 – Organisation chats** | Verified accounts, dashboards, embeddable widget, e-commerce hooks |
| **M4 – Locality / government channels** | Location-based + institutional channels |
| **M5 – Polish + AI view + native** | AI message views, native polish, perf |

## Open questions (deferred)

| Question | Options | Notes |
|----------|---------|-------|
| Signal vs MLS | Signal Protocol (1:1), MLS (group) | Likely Signal for 1:1 + MLS for groups |
| Storage backend | Local SQLite vs server-side | E2E means the server stores ciphertext only |
| Media handling | Direct upload, CDN, P2P | Encrypted media blobs need a delivery mechanism |
| Spam / abuse | Content moderation on ciphertext? | E2E forecloses server-side moderation; need client-side reporting |

Tracked in the Deferred Decisions section of `wiki/TODO.md`.

## Observability

WebSocket per-message spans are out of scope for the initial observability rollout — they land alongside M1.

## Related

- [[social-graph]] — user relationships drive messaging visibility
- [[arc-tokens]] — S2S auth for Zap API → OSN API calls
- [[monorepo-structure]] — workspace layout and the `@zap/*` prefix
