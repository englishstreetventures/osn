---
title: Frontend Patterns
aliases:
  - UI tokens
  - shared UI
  - Tailwind patterns
  - component patterns
tags:
  - architecture
  - frontend
  - solidjs
  - tailwind
status: current
related:
  - "[[close-friends]]"
  - "[[pulse]]"
  - "[[testing-patterns]]"
packages:
  - "@pulse/app"
  - "@osn/ui"
last-reviewed: 2026-04-12
---

# Frontend Patterns

## Shared UI Tokens

Visual treatments that appear in more than one component live in `pulse/app/src/lib/ui.ts` as exported constants. Changing a colour or ring style should be a **single-file edit**.

### Current Tokens

```typescript
CLOSE_FRIEND_RING_CLASS  // green outline on attendees who are close friends
avatarClasses(base, isCloseFriend)  // helper that appends the ring class
```

### How They Flow

The `RsvpAvatar` component reads the `CLOSE_FRIEND_RING_CLASS` constant, and both `RsvpSection` and `RsvpModal` use `RsvpAvatar` -- so the entire event-detail page's close-friend affordance updates from one file.

```
lib/ui.ts (CLOSE_FRIEND_RING_CLASS)
  └─ RsvpAvatar (reads constant, applies conditionally)
       ├─ RsvpSection (uses RsvpAvatar for inline attendee list)
       └─ RsvpModal (uses RsvpAvatar for full attendee grid)
```

### The Rule

When you find yourself copy-pasting the same Tailwind class list across two components, lift it into `lib/ui.ts`. This keeps visual consistency a one-file concern and makes it testable.

### Testing

The `RsvpAvatar` test asserts that the constant flows to the DOM, so you can verify the linkage stays intact. This is important because a broken import or a renamed constant would silently drop the visual treatment without any runtime error.

## Shared Auth Components

Sign-in and registration UI lives in `@osn/ui/auth/*` (not in individual apps). These components receive an injected client prop and are app-agnostic:

- `<Register />` -- multi-step registration flow (email + handle + display name, OTP verification, passkey enrollment)
- `<SignIn />` -- login form supporting passkey, OTP, and magic link methods
- `<MagicLinkHandler />` -- deep-link handler for magic link callbacks

Any OSN app (Pulse, Zap, future apps) imports these from `@osn/ui/auth/*` and injects a client from `@osn/client`.

## Lazy Loading

Route-level components (`EventDetailPage`, `SettingsPage`) are `lazy()`-loaded in `App.tsx` to reduce the initial bundle. Components with heavy dependencies (like `MapPreview` with Leaflet at ~150KB) dynamic-import their dependencies inside `onMount` so pages that don't need them never pay for the chunk.

## Source Files

- [pulse/app/src/lib/ui.ts](../pulse/app/src/lib/ui.ts) -- shared UI tokens
- [osn/ui/src/auth/Register.tsx](../osn/ui/src/auth/Register.tsx) -- shared registration component
- [osn/ui/src/auth/SignIn.tsx](../osn/ui/src/auth/SignIn.tsx) -- shared sign-in component
- [CLAUDE.md](../CLAUDE.md) -- "Shared UI tokens" section
