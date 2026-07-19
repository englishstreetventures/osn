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
last-reviewed: 2026-07-19
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

## c2b (consumer-to-business) chats

### The `class` axis: c2c vs c2b

Every chat row carries a `class` column with two values:

| Class | Description | Body storage |
|---|---|---|
| `c2c` (consumer-to-consumer) | Traditional E2E-encrypted DMs and group chats. The server stores **ciphertext only** — `messages.body` is `NULL`. Decryption happens entirely on-device using the Signal Protocol (`@shared/crypto`). | `NULL` (ciphertext in Signal payload, outside this column) |
| `c2b` (consumer-to-business) | Conversations between a user and a business/service (e.g. a cire vendor inquiry). The business endpoint is a server-side service, not a user device, so full E2E is not applicable. `messages.body` is a **plaintext string**, visible to the server. | `TEXT NOT NULL` |

The `class` column was added to `@zap/db` in the c2b PR and defaults to `'c2c'` for all existing chats, preserving the E2E invariant for all consumer messaging.

### Internal API surface

c2b chat provisioning and messaging is exposed exclusively through **ARC-gated internal routes** — they are never reachable from user clients:

| Route | Method | Purpose |
|---|---|---|
| `/internal/chats` | `POST` | Provision a new c2b chat (sets `class = 'c2b'`). Caller must hold the `chat:c2b` scope. |
| `/internal/chats/:chatId/messages` | `POST` | Send a message into a c2b chat (writes plaintext `body`). |
| `/internal/chats/:chatId/messages` | `GET` | List messages in a c2b chat with cursor-based pagination. |

All three routes are protected by ARC token verification (audience `zap-api`, scope `chat:c2b`). A caller without the scope receives `403 Forbidden`. Consumer chat routes (`/chats*`) are unaffected and continue to enforce OSN user-token auth (ES256, audience `osn-access`).

#### `chat:c2b` scope

The `chat:c2b` scope is the ARC permission gate for all c2b operations. It is granted when a service (e.g. `cire-api`) registers its ARC public key with zap-api's `POST /internal/register-service` requesting `allowedScopes: "chat:c2b"`. See [[arc-tokens]] and the zap-api production bring-up runbook for the registration steps.

### DSAR / account-export

The DSAR account-export (`GET /account/export`) includes c2b message bodies:

- **c2b chats**: `messages.body` (plaintext) is included in the export under the user's own messages.
- **c2c chats**: ciphertext is still **excluded** — the server never holds the plaintext and cannot export it. The export includes c2c chat metadata (chat id, member list, timestamps) but not the encrypted payload.

This distinction is by design: c2b body content is server-visible and user-attributed data that users have a right to receive under GDPR/DSAR; c2c ciphertext is opaque server-side and cannot meaningfully be exported.

### CI pipeline

A `deploy-zap-api` job exists in `.github/workflows/deploy.yml` but is **dormant**: it activates once the prod D1 `database_id` is filled in `zap/api/wrangler.toml` `[env.production]`. See the zap-api production bring-up runbook for the manual steps to activate it.

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

- **Z7** — inbound ARC surface (`/internal/chats*` for c2b): **shipped** in the c2b PR (see [[#c2b-consumer-to-business-chats]] above). Pulse-driven event group chats remain a separate PR.
- **S-M6** — widen the 48-bit UUID-slice IDs (`chat_`/`cmem_`/`msg_`): separate
  PR.

## Observability

WebSocket per-message spans are out of scope for the initial observability rollout — they land alongside M1.

## Related

- [[social-graph]] — user relationships drive messaging visibility
- [[arc-tokens]] — S2S auth for Zap API → OSN API calls
- [[monorepo-structure]] — workspace layout and the `@zap/*` prefix
