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
  - "[[component-library]]"
  - "[[pulse-close-friends]]"
  - "[[pulse]]"
  - "[[testing-patterns]]"
packages:
  - "@pulse/app"
  - "@osn/ui"
last-reviewed: 2026-04-26
---

# Frontend Patterns

## Component Library

UI primitives (Button, Input, Card, Dialog, etc.) live in `@osn/ui` as Zaidan-style components — copy-pasted source backed by Kobalte headless primitives and styled with Tailwind + CVA. See [[component-library]] for the full guide on adding, using, and testing components.

## Shared UI Tokens

Visual treatments that appear in more than one component live in `pulse/app/src/lib/ui.ts` as exported constants. Changing a colour or ring style should be a **single-file edit**.

### Current Tokens

```typescript
CLOSE_FRIEND_RING_CLASS  // green outline on attendees who are close friends
```

### How They Flow

The `RsvpAvatar` component reads the `CLOSE_FRIEND_RING_CLASS` constant and applies it via `cn()` to the `Avatar` wrapper. Both `RsvpSection` and `RsvpModal` use `RsvpAvatar` — so the entire event-detail page's close-friend affordance updates from one file.

```
lib/ui.ts (CLOSE_FRIEND_RING_CLASS)
  └─ RsvpAvatar (reads constant, applies via cn() to Avatar wrapper)
       ├─ RsvpSection (uses RsvpAvatar for inline attendee list)
       └─ RsvpModal (uses RsvpAvatar for full attendee grid)
```

### The Rule

When you find yourself copy-pasting the same Tailwind class list across two components, either:
1. **Use a Zaidan component** if the pattern is a standard UI primitive (button, card, input) — see [[component-library]]
2. **Lift a token into `lib/ui.ts`** if the pattern is app-specific visual treatment (close-friend ring, status colours)

### Testing

The `RsvpAvatar` test asserts that the constant flows to the DOM, so you can verify the linkage stays intact. This is important because a broken import or a renamed constant would silently drop the visual treatment without any runtime error.

## Shared Auth Components

Sign-in and registration UI lives in `@osn/ui/auth/*` (not in individual apps). These components use Zaidan primitives (Button, Input, Label) internally and receive an injected client prop to stay app-agnostic:

- `<Register />` — multi-step registration flow (email + handle + display name, OTP verification, **mandatory** passkey enrollment)
- `<SignIn />` — passkey-only login (identifier-bound or discoverable). Routes to `<RecoveryLoginForm>` via the "Lost your passkey?" link
- `<RecoveryLoginForm />` — recovery-code login (lost-device escape hatch)
- `<StepUpDialog />` — sudo ceremony for sensitive actions (recovery generate, email change, passkey delete)
- `<SessionsView />` — per-device session list + "sign out everywhere else"
- `<PasskeysView />` — passkey rename / delete (step-up gated)
- `<RecoveryCodesView />`, `<SecurityEventsBanner />`, `<ChangeEmailForm />`, `<ProfileSwitcher />`, `<CreateProfileForm />`, `<ProfileOnboarding />`

Any OSN app (Pulse, Zap, Social, future apps) imports these from `@osn/ui/auth/*` and injects a client from `@osn/client`.

## Lazy Loading

Route-level components (`EventDetailPage`, `SettingsPage`) are `lazy()`-loaded in `App.tsx` to reduce the initial bundle. Components with heavy dependencies (like `MapPreview` with Leaflet at ~150KB) dynamic-import their dependencies inside `onMount` so pages that don't need them never pay for the chunk.

## Source Files

- [osn/ui/src/components/ui/](../../osn/ui/src/components/ui/) — Zaidan component primitives
- [osn/ui/src/lib/utils.ts](../../osn/ui/src/lib/utils.ts) — `cn()` utility
- [pulse/app/src/lib/ui.ts](../../pulse/app/src/lib/ui.ts) — shared UI tokens
- [osn/ui/src/auth/Register.tsx](../../osn/ui/src/auth/Register.tsx) — shared registration component
- [osn/ui/src/auth/SignIn.tsx](../../osn/ui/src/auth/SignIn.tsx) — shared sign-in component
- [CLAUDE.md](../../CLAUDE.md) — conventions and commands
