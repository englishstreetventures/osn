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
  - "[[browser-tests]]"
  - "[[cire-development]]"
packages:
  - "@pulse/web"
  - "@osn/ui"
last-reviewed: 2026-08-21
---

# Frontend Patterns

## Component Library

UI primitives (Button, Input, Card, Dialog, etc.) live in `@osn/ui` as Zaidan-style components — copy-pasted source backed by Kobalte headless primitives and styled with Tailwind + CVA. See [[component-library]] for the full guide on adding, using, and testing components.

## Shared UI Tokens

Visual treatments that appear in more than one component live in `pulse/web/src/lib/ui.ts` as exported constants. Changing a colour or ring style should be a **single-file edit**.

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

When you copy the same Tailwind class list into a second component, do one of these:
1. **Use a Zaidan component** if the pattern is a standard UI primitive (button, card, input) — see [[component-library]]
2. **Lift a token into `lib/ui.ts`** if the pattern is app-specific visual treatment (close-friend ring, status colours)

### Testing

The `RsvpAvatar` test asserts that the constant reaches the DOM, so you can check the link stays intact. A broken import or a renamed constant would drop the visual treatment with no runtime error.

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

Route-level components (`EventDetailPage`, `SettingsPage`) are `lazy()`-loaded in `App.tsx` to reduce the initial bundle. Components with heavy dependencies (like `MapPreview` with Leaflet at ~150KB) dynamic-import their dependencies inside `onMount` so pages that don't need them never load the chunk.

## Rendering and animation gotchas

Every one of these cost a real bug. They were all found in cire, but none of them
is cire-specific — they are properties of Tailwind's scanner, Solid's reactivity,
Motion One's finish behaviour and the CSS spec, so they apply to `@pulse/web` and
`@osn/social` the same way. What unites them is that **the fast test tier cannot
see any of them**: jsdom and happy-dom compute no styles and no layout, so a
green unit suite proves nothing here. Pin the class contract in the fast tier and
measure the real thing in the browser tier ([[browser-tests]]).

### Tailwind class names must be literal source text

The scanner reads source as text. A computed class — `` `grid-cols-${n}` ``, or any
concatenation — emits **no CSS at all**, silently, because an unknown class is
simply ignored. Where a layout constant must exist in JS too (a key handler
stepping by a grid's column count, say), keep the literal at the usage site,
export the constant, and add a static drift guard in the tests asserting the two
agree. `SECTION_MENU_COLUMNS` (`cire/host` `invite/InviteBuilder.tsx`) and the
`auto-grid` / `page-frame` utilities use this pattern.

### `createMemo` runs eagerly, so declare memos below their dependencies

Unlike a plain accessor, a memo's computation runs at creation. A memo declared
above the `const` it reads throws a TDZ error at component-init — not on first
read, which is where you would look for it.

### A `transform` on any ancestor breaks `position: fixed`

It makes `fixed` resolve against that ancestor rather than the viewport, **and**
makes the ancestor a stacking context that no `z-index` can escape. Motion One
leaves its final inline `transform` on the elements it animates, so anything
`fixed` mounted inside an animated section is doubly trapped: mispositioned
(measured 723–814px down the page instead of at the viewport edge — off-screen on
a phone) and painted below page-level overlays. This is what left cire's RSVP save
toast behind the `z-100` sheet it fires underneath.

**Fix:** mount page-level overlays at the component root, as siblings of the
modals, never inside an animated section.

**Testing it:** do NOT reach for `document.elementFromPoint`. `@shared/toast`'s
container is deliberately `pointer-events: none`, so it hit-tests as transparent
even when painted perfectly. Assert the mechanism instead — no fixed-position
containing block between the element and `<body>`, and a computed `z-index` above
`Z_LAYER.MODAL`.

### Motion One leaves its final keyframe as inline style, and Solid will not clean it up

A fade-out ending at `opacity: 0` leaves `opacity: 0` on the element forever.
Harmless while the element never returns — and a blank-screen bug the moment
something brings it back, because Solid's style binding on that node typically
owns only `display`. It happily restores `display` onto a fully transparent box.

Whenever you add a path that **re-shows** what an animation hid, clear what that
animation wrote (`el.style.opacity = ""`, `el.style.transform = ""`). Writing those
two is safe where writing `display` is not, precisely because Solid does not
manage them — there is no binding to desynchronise.

The unit tier cannot see this: jsdom computes no styles, and those tests mock the
animation away, so the cause never runs. Assert it in the browser tier with
`checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })` — `display`
alone was never the failure. (Found on cire's guest sign-out control: the restored
claim form sat at `opacity: 0` in both design packs, with 800 unit tests green.)

### Write an animation's inline end state when it finishes, never before it starts

Motion reverts to base styles on finish, which is why a reveal keeps an inline end
state. Writing that `opacity: 1` up front instead paints one full-brightness frame
that the animation's first keyframe drops back to zero — the viewer sees content
blink in, vanish, and fade in again.

A staggered child is worse: nothing hides it (only its container carries
`opacity-0`), so a `startDelay` leaves every child at full opacity from the moment
the container appears until Motion commits its first frame. Hide the children
inline first, run the animations, and settle the inline end state in a `finally`,
so a stalled or throwing step can never leave them invisible.

One frame is invisible to jsdom **and** to the browser tier's assertions-after-the-
fact — catch it by sampling `getComputedStyle` per `requestAnimationFrame` in a
real browser (`UnlockReveal.motion.ts`, both packs).

### Anything a choreography animates must be in the DOM before it runs

Cire's post-claim components are `lazy`, so on a cold cache their chunk is still in
flight when the claim resolves, `<Suspense fallback={null}>` renders no cards, and
the reveal animates an empty section with nothing to stagger. The cards then slam
into the layout at full opacity when the chunk lands. `awaitEventCards`
(`cire/invites` `components/await-event-cards.ts`) is the fix: the sequence awaits
it through the `waitForEvents` hook, **under** the fade-out of the step before it
rather than on top of it, and both halves of the wait are capped so a chunk that
never arrives still reveals the page.

### `position: sticky` resolves its offsets against the scrollport

Not against its parent's content box — so the usual "cancel the container's padding
with a negative margin" trick inverts on a sticky element: a negative bottom margin
*hoists it up* over the content instead of stretching it down into the padding.

A full-bleed sticky action bar must instead have the scroll container drop its own
bottom padding and let the bar own the edge, plus its `env(safe-area-inset-bottom)`
— the `flushBottom` prop on `AnimatedModal`, used by cire's `RsvpModal`.

## Source Files

- [osn/ui/src/components/ui/](../../osn/ui/src/components/ui/) — Zaidan component primitives
- [osn/ui/src/lib/utils.ts](../../osn/ui/src/lib/utils.ts) — `cn()` utility
- [pulse/web/src/lib/ui.ts](../../pulse/web/src/lib/ui.ts) — shared UI tokens
- [osn/ui/src/auth/Register.tsx](../../osn/ui/src/auth/Register.tsx) — shared registration component
- [osn/ui/src/auth/SignIn.tsx](../../osn/ui/src/auth/SignIn.tsx) — shared sign-in component
- [CLAUDE.md](../../CLAUDE.md) — conventions and commands
