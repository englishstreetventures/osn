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
last-reviewed: 2026-04-13
---

# Identity Model

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
│        users (profiles)             │  ← Public-facing identity / handle
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
| `maxProfiles` | `integer` | Default 5; enforcement lands in P3 |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Key invariants:**
- `accountId` is **never exposed** in any API response, token claim, or log entry. It is the multi-account correlation identifier — leaking it reveals which profiles belong to the same person.
- Email is **only on accounts**, not duplicated on profiles.
- Passkeys reference `accounts.id` (not `users.id`), because authentication is account-level.

## Users (Profiles)

The `users` table is the **public-facing identity**. This is what other users see — a handle, display name, and avatar. Every reference across Pulse, Zap, and the social graph points to `users.id` (the `profileId`).

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
- `profileId` (previously `userId`) is the canonical identifier throughout all services. Pulse events, Zap chats, RSVPs, connections, blocks — everything keys on `profileId`.
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
- Org ownership is per-profile. Deleting a profile that owns an org requires ownership transfer (enforcement deferred to P3).
- The `listMembers` service return **never includes `accountId`** — defence in depth against correlation leakage.

## Token Model

| Token | Bound to | `sub` claim | TTL | Purpose |
|-------|----------|-------------|-----|---------|
| Access | Profile | `profileId` | 1 hour | Authorize API calls as a specific profile |
| Refresh | Profile | `profileId` | 30 days | Re-issue access tokens |
| Enrollment | Account | `accountId` | 5 min | Passkey registration after signup |

> **PR2 note**: The refresh token will be re-scoped to accounts (not profiles) when the two-tier token model lands. This enables profile switching without re-authentication.

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
| ARC S2S | No user context | Service-to-service only |

## Privacy Rules

1. **`accountId` never appears in**: API responses, JWT claims (except enrollment tokens), log entries, metric attributes, or any data sent to other services.
2. **Rate limiting is per-profile** for API calls, **per-IP for auth** — per-account rate limits would correlate profiles.
3. **Block independence** — blocking on one profile does NOT affect other profiles on the same account.
4. **Self-interaction allowed** — two profiles from the same account can follow, message, and interact. Preventing this would reveal the link.

## Multi-Account Roadmap

| Phase | Status | Scope |
|-------|--------|-------|
| P1: Schema | ✅ Done | `accounts` table, `userId` → `profileId`, seed data, email dedup |
| P2: Auth refactor | Planned | Two-tier tokens (refresh=account, access=profile), profile switching |
| P3: Profile CRUD | Planned | Create/list/delete profiles, maxProfiles enforcement |
| P4: Client SDK | Planned | Multi-session storage, profile switcher methods |
| P5: UI | Planned | Profile switcher component |
| P6: Privacy audit | Planned | Verify accountId never leaks, pen-test correlation attacks |
