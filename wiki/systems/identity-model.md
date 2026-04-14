---
title: Identity Model — Accounts, Profiles & Organisations
tags: [identity, accounts, profiles, organisations, multi-account]
related:
  - "[[social-graph]]"
  - "[[osn-core]]"
  - "[[backend-patterns]]"
  - "[[arc-tokens]]"
packages:
  - "@osn/db"
  - "@osn/core"
  - "@osn/client"
last-reviewed: 2026-04-14
p4-completed: 2026-04-14
p2-completed: 2026-04-14
p3-completed: 2026-04-14
---

# Identity Model

## Terminology

| Term | Meaning | Code entity |
|------|---------|-------------|
| **User** | The actual human person. Not a data structure — never a type name, column, or variable. | — |
| **Account** | Login identity — email, passkeys, auth tokens. A user owns one account. | `accounts` table, `acc_` prefix |
| **Profile** | Public-facing identity — handle, display name, avatar. An account can have multiple profiles. | `users` table (legacy name), `Profile` type, `usr_` prefix |
| **Organisation** | Group identity composed of profiles. | `organisations` table, `org_` prefix |

A user owns an account, which owns one or more profiles. The relationship is: **User (person) → Account (login) → Profiles (public identities)**.

OSN uses a two-tier identity model inspired by Meta's Accounts Center. A single **account** (the login entity) can own multiple **profiles** (the public-facing handles). **Organisations** are separate entities composed of individual profiles.

## Architecture

```
┌─────────────────────────────────────┐
│           accounts                  │  ← Login identity (invisible externally)
│  acc_xxxx | email | maxProfiles     │
└──────────────┬──────────────────────┘
               │ 1:N (private link)
               │
┌──────────────▼──────────────────────┐
│     users table (= profiles)        │  ← Public-facing identity / handle
│  usr_xxxx | accountId | handle | …  │
└──────────────┬──────────────────────┘
               │ (canonical entity everywhere)
               │
    ┌──────────┼──────────┐
    ▼          ▼          ▼
connections  pulse/*    zap/*
```

## Accounts

The `accounts` table is the **authentication principal** — the entity that logs in, owns passkeys, and receives OTP/magic-link emails.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `text PK` | `acc_` prefix + 12 hex chars |
| `email` | `text UNIQUE` | Login credential — the only place email lives |
| `maxProfiles` | `integer` | Default 5; enforced by `createProfile` in P3 |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Key invariants:**
- `accountId` is **never exposed** in any API response, token claim, or log entry. It is the multi-account correlation identifier — leaking it reveals which profiles belong to the same person.
- Email is **only on accounts**, not duplicated on profiles.
- Passkeys reference `accounts.id` (not profile IDs), because authentication is account-level.

## Profiles (DB table: `users`)

The `users` table is the **public-facing identity**. This is what other profiles see — a handle, display name, and avatar. Every reference across Pulse, Zap, and the social graph points to `users.id` (the `profileId`). Code-level functions and API parameters use `profile` terminology (e.g. `findProfileByHandle`, `registerProfile`, `blockProfile`); the DB table retains the name `users` for migration stability.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `text PK` | `usr_` prefix + 12 hex chars |
| `accountId` | `text FK → accounts.id` | The owning login entity (never exposed) |
| `handle` | `text UNIQUE` | `@handle` — immutable social identity |
| `displayName` | `text` | Nullable display name |
| `avatarUrl` | `text` | Nullable avatar URL |
| `isDefault` | `boolean` | Exactly one per account; auto-selected on login |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Key invariants:**
- `profileId` (previously `userId`) is the canonical identifier throughout all services. Pulse events, Zap chats, RSVPs, connections, blocks — everything keys on `profileId`. All service functions, route parameters, and error messages use "profile" terminology (not "user").
- Each profile has a **fully independent social graph**. If profile A blocks someone, profile B (same account) is NOT affected.
- Two profiles from the same account **can interact** — they can connect, message, RSVP to the same event. Preventing this would reveal the account link.
- Handle namespace is **shared with organisations** — no user handle can collide with an org handle.

## Organisations

Organisations are independent entities that are **composed of profiles, not accounts**. An org member is a handle/profile. The system cannot distinguish whether two members in the same org share an account.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `text PK` | `org_` prefix |
| `handle` | `text UNIQUE` | Shared namespace with user handles |
| `name` | `text` | Display name |
| `ownerId` | `text FK → users.id` | A profile, not an account |

### Organisation Members

| Column | Type | Notes |
|--------|------|-------|
| `id` | `text PK` | `orgm_` prefix |
| `organisationId` | `text FK → organisations.id` | |
| `profileId` | `text FK → users.id` | The member's profile |
| `role` | `admin \| member` | |

**Key invariants:**
- Multiple profiles from the same account **can be in the same org** — one might be admin, another a member. This is by design.
- Org ownership is per-profile. Deleting a profile that owns an org requires ownership transfer first (enforced in P3).
- The `listMembers` service return **never includes `accountId`** — defence in depth against correlation leakage.

## Token Model

| Token | Bound to | `sub` claim | TTL | Purpose |
|-------|----------|-------------|-----|---------|
| Access | Profile | `profileId` | 1 hour | Authorize API calls as a specific profile |
| Refresh | Account | `accountId` | 30 days | Re-issue access tokens; enables profile switching without re-authentication |
| Enrollment | Account | `accountId` | 5 min | Passkey registration after signup |

The two-tier token model (P2) scopes refresh tokens to accounts and access tokens to profiles. Refresh tokens include a `scope: "account"` claim that is explicitly validated on verification.

Two profile management endpoints:
- `POST /profiles/switch` — present the account-scoped refresh token + target `profileId` in the request body; receive a new access token for that profile. Per-account rate limited (20 switches/hr).
- `POST /profiles/list` — present the refresh token in the request body; receive all profiles for the account. Refresh tokens are never sent via `Authorization` headers to avoid conflation with access tokens.

## Client Storage Model (P4)

`@osn/client` stores the multi-profile session under a single `localStorage` key:

| Key | Shape | Purpose |
|-----|-------|---------|
| `@osn/client:account_session` | `AccountSession` JSON | Refresh token, active profile ID, per-profile access tokens, scopes, ID token |

The `AccountSession` structure:

```typescript
interface AccountSession {
  refreshToken: string;           // Account-scoped (shared across profiles)
  activeProfileId: string;        // Currently active profile
  profileTokens: Record<string, ProfileToken>;  // Per-profile access tokens
  scopes: string[];
  idToken: string | null;
}
```

**Design decisions:**
- Single-key storage (not multi-key) avoids the need for `keys()` enumeration on logout and simplifies atomic writes.
- Expired profile tokens are pruned on every `saveAccountSession` call (except the active profile's token, which is kept for identity tracking).
- An in-memory cache avoids redundant `localStorage.getItem` + `JSON.parse` round-trips within the same service instance.
- All storage reads are validated against Effect Schema (`decodeAccountSession`) — malformed data is discarded rather than consumed.
- Legacy sessions (pre-P4, stored under `@osn/client:session`) are migrated transparently on the first `getSession()` call.

## Registration Flow

```
POST /register/begin  → email + handle + displayName → OTP sent
POST /register/complete → OTP →
  1. Creates account (acc_*) with email
  2. Creates profile (usr_*) with accountId, handle (in a transaction)
  3. Issues access + refresh tokens scoped to the profile
  4. Issues enrollment token scoped to the account (for passkey setup)
```

## Cross-Service Impact

| Service | References | Notes |
|---------|-----------|-------|
| Pulse events | `createdByProfileId` | Profile that created the event |
| Pulse RSVPs | `profileId` | Profile that RSVP'd |
| Zap chats | `createdByProfileId`, member `profileId` | Profiles in the chat |
| Social graph | `requesterId`, `addresseeId` (both profile IDs) | Independent per profile |
| ARC S2S | No profile context | Service-to-service only |
| Login response | `{ session, profile: PublicProfile }` | Wire format + SDK types renamed to match identity model |

## Privacy Rules

1. **`accountId` never appears in**: API responses, JWT claims (except enrollment tokens), log entries, metric attributes, or any data sent to other services.
2. **Rate limiting is per-profile** for API calls, **per-IP for auth** — per-account rate limits would correlate profiles.
3. **Block independence** — blocking on one profile does NOT affect other profiles on the same account.
4. **Self-interaction allowed** — two profiles from the same account can follow, message, and interact. Preventing this would reveal the link.

## Multi-Account Roadmap

| Phase | Status | Scope |
|-------|--------|-------|
| P1: Schema + terminology | ✅ Done | `accounts` table, `userId` → `profileId`, seed data, email dedup, service/route/test rename from "user" → "profile" terminology |
| P2: Auth refactor | ✅ Done | Two-tier tokens (refresh=account, access=profile), `POST /profiles/switch`, `POST /profiles/list`, `verifyRefreshToken`, `findDefaultProfile`, scope claim validation, per-account rate limiting |
| P3: Profile CRUD | ✅ Done | `createProfile` (maxProfiles enforcement, S-L1), `deleteProfile` (cascade delete graph+org data), `setDefaultProfile`, three REST routes, `withProfileCrud` observability wrapper, S-L2 resolved |
| P4: Client SDK | ✅ Done | Multi-session `AccountSession` storage in `@osn/client`, `listProfiles` / `switchProfile` / `createProfile` / `deleteProfile` / `getActiveProfile` methods, SolidJS `AuthContext` integration (`profiles` resource, `activeProfileId` signal), legacy session migration, Effect Schema validation on storage reads + API responses, Base64URL JWT parsing, expired token pruning |
| P5: UI | Planned | Profile switcher component |
| P6: Privacy audit | Planned | Verify accountId never leaks, pen-test correlation attacks |
