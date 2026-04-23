---
title: Social
description: OSN Social app — identity and social-graph management UI
tags: [app, identity, social-graph]
status: active
packages:
  - "@osn/social"
related:
  - "[[osn-core]]"
  - "[[social-graph]]"
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[rate-limiting]]"
last-reviewed: 2026-04-23
---

# Social

`@osn/social` is a SolidJS web app for managing your OSN identity and social graph. It is the first surface dedicated to the cross-app identity layer — separate from Pulse (events) and Zap (messaging), which remain responsible for their own domain UI.

## Architecture

```
@osn/social (SolidJS + Vite, port 1422)
  ├── SolidJS frontend (src/)
  ├── Consumes @osn/client and @osn/ui
  └── Talks to @osn/api (port 4000) directly over REST
```

No Tauri wrapper yet — the app ships as a web build only. Tauri wrapping is tracked in `wiki/TODO.md` as a Phase 2 item.

## Pages

| Route | Component | Purpose |
|---|---|---|
| `/` + `/connections` | `ConnectionsPage` | All connections, pending requests, close friends, blocks (tabbed) |
| `/discover` | `DiscoverPage` | Friends-of-friends recommendations (`GET /recommendations/connections`) |
| `/organisations` | `OrganisationsPage` | Orgs the user owns or belongs to; create new |
| `/organisations/:id` | `OrgDetailPage` | Org detail + member management |
| `/settings` | `SettingsPage` | Profile management, account section, sessions, passkeys, security events |

## Client surface

Pages talk to `@osn/api` via three plain-fetch clients factored out of `@osn/client`:

- `createGraphClient` — connections, pending requests, close friends, blocks (`osn/client/src/graph.ts`)
- `createOrgClient` — org CRUD and membership (`osn/client/src/organisations.ts`)
- `createRecommendationClient` — friends-of-friends suggestions (`osn/client/src/recommendations.ts`)

All three share the same hardening: `authGet/authPost/authPatch/authDelete` with `safeJson` wrapping (no `SyntaxError` leakage), capped error strings, and per-module typed error classes. These helpers are currently duplicated per module; factoring is tracked as P-I1.

## Dev

```bash
bun run dev:social             # starts @osn/social + @osn/api together
bun run --cwd osn/social dev   # social only (:1422)
```

Environment variables (all prefixed `VITE_`):

- `VITE_OSN_ISSUER_URL` — defaults to `http://localhost:4000`
- `VITE_OSN_CLIENT_ID` — defaults to `social`

## Auth

Uses `AuthProvider` from `@osn/client/solid` with the standard OSN passkey-primary login model — see [[passkey-primary]]. Access tokens live in `localStorage` (the only auth secret there after Copenhagen Book C3); the refresh token lives in an HttpOnly cookie. Silent refresh on 401 is handled by `OsnAuthService.authFetch`. A "Lost your passkey?" link routes to the recovery-code login form.

## Rate limits

Per-user Redis-backed limiter on the recommendations endpoint (20 req/min, fail-closed) — see `[[rate-limiting]]` and `createRedisRecommendationRateLimiter` in `@osn/api`.

## Testing

`osn/social/tests/` — currently covers the sidebar mount path under `AuthContext` + `MemoryRouter` using `@solidjs/testing-library` + `happy-dom`. The full open-and-click interaction for the Kobalte dropdown is not asserted; Kobalte's trigger relies on pointer-capture semantics that happy-dom does not reproduce faithfully.
