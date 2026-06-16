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
last-reviewed: 2026-06-16
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
| **M1 – 1:1 DMs** | Signal Protocol (Double Ratchet, **PQXDH** — X25519 + ML-KEM-768 hybrid; classical-only X3DH is HNDL-exposed), message CRUD, WebSocket transport, read/delivery receipts, disappearing messages |
| **M2 – Group chats** | MLS or Sender Keys for group encryption (hybrid PQ KEM required either way), roles, invites; Pulse event-chat hookup |
| **M3 – Organisation chats** | Verified accounts, dashboards, embeddable widget, e-commerce hooks |
| **M4 – Locality / government channels** | Location-based + institutional channels |
| **M5 – Polish + AI view + native** | AI message views, native polish, perf |

## Open questions (deferred)

| Question | Options | Notes |
|----------|---------|-------|
| Signal vs MLS | Signal Protocol (1:1), MLS (group) | Likely Signal for 1:1 + MLS for groups. Hybrid PQ KEM (ML-KEM-768 + X25519) required either way — durable message ciphertext is HNDL-exposed |
| Storage backend | Local SQLite vs server-side | E2E means the server stores ciphertext only |
| Media handling | Direct upload, CDN, P2P | Encrypted media blobs need a delivery mechanism |
| Spam / abuse | Content moderation on ciphertext? | E2E forecloses server-side moderation; need client-side reporting |

Tracked in the Deferred Decisions section of `wiki/TODO.md`.

## Authentication & authorization

### User-token verification (W1)

Every `/chats*` route verifies the caller's OSN access token the same way Pulse
does: ES256 signature against the OSN JWKS via `extractClaims` from
`@shared/osn-auth-client/verify`, with `audience: "osn-access"` enforced inside
the verify pass. There is **no shared HS256 secret** any more (`OSN_JWT_SECRET`
was removed). Keys are resolved from `OSN_JWKS_URL` (`zap/api/src/lib/jwks.ts`);
`zap/api/src/index.ts` refuses to boot in a non-local env if that URL is
plaintext `http://`.

The actor's `profileId` is derived through a single chokepoint
(`resolveProfileId` in `zap/api/src/routes/chats.ts`, AUDIT-Z2) that drops any
verified token whose `sub` does not start with `usr_`, so a non-user principal
can never be written into `created_by_profile_id` / `sender_profile_id`.

The factory signature mirrors Pulse:
`createChatsRoutes(dbLayer, jwksUrl, _testKey?, rateLimiters?)`. Route tests
inject a test public key and mint ES256 tokens.

### Social-graph consent (W2)

A user may only pull another profile into a chat (create-with-members or
add-member) when the two share a permitted OSN social-graph relationship.

- `zap/api/src/services/zapGraphBridge.ts` is the **only** file that makes S2S
  calls to `@osn/api` — an ARC-authenticated (`graph:read`, audience `osn-api`)
  call to `/graph/internal/connection-status`. Mirrors
  `pulse/api/src/services/graphBridge.ts`. See [[arc-tokens]].
- `zap/api/src/services/consent.ts` wraps that bridge in `checkConsent`, which
  **fails closed**: if the graph is unreachable the add is rejected
  (`ConsentDenied{reason:"graph_unreachable"}`) and the `blocked` denial metric
  fires. `not_connected` is the definitive-no path. The gate is swappable via
  `setConsentGate` for tests.
- Invariants enforced in `zap/api/src/services/chats.ts`: a **DM is exactly two
  members** (`InvalidDmMembership`); the **last admin** of a chat cannot be
  removed (`LastAdmin`). Message-list cursors are scoped to their chat and
  unknown cursors are rejected (`zap/api/src/services/messages.ts`, Z6).

> **Ops provisioning:** consent checks require `zap-api` to be registered as an
> ARC issuer in the OSN `service_accounts` table (allowed scope `graph:read`).
> Local dev self-registers on boot when `INTERNAL_SERVICE_SECRET` is set;
> production must seed the public key out-of-band. Until then consent fails
> closed and member-adds are rejected.

### CORS

`zap/api/src/lib/cors-config.ts` derives the allowlist from `ZAP_CORS_ORIGIN`
(comma-separated), falling back to the local dev ports only in a local env and
**failing closed** (throwing at boot) if a non-local deploy leaves it unset.

### Deferred

- **Z7** — inbound ARC surface (`POST /internal/chats`) for Pulse-driven event
  chats: separate PR.
- **S-M6** — widen the 48-bit UUID-slice IDs (`chat_`/`cmem_`/`msg_`): separate
  PR.

## Observability

WebSocket per-message spans are out of scope for the initial observability rollout — they land alongside M1.

## Related

- [[social-graph]] — user relationships drive messaging visibility
- [[arc-tokens]] — S2S auth for Zap API → OSN API calls
- [[monorepo-structure]] — workspace layout and the `@zap/*` prefix
