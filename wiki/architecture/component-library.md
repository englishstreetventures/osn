---
title: Component Library (Zaidan)
aliases:
  - zaidan
  - shadcn
  - UI components
  - design system
tags:
  - architecture
  - frontend
  - solidjs
  - tailwind
  - design-system
status: current
related:
  - "[[osn-and-musubi]]"
  - "[[design-tokens]]"
  - "[[frontend-patterns]]"
  - "[[monorepo-structure]]"
  - "[[testing-patterns]]"
  - "[[native-dialog-over-kobalte]]"
packages:
  - "@shared/ui"
  - "@osn/auth-ui"
  - "@cire/ui"
last-reviewed: 2026-09-22
---

# Component Library (Zaidan)

Components are **Zaidan**-style — the SolidJS equivalent of shadcn/ui: owned
source files in the repo rather than a versioned dependency, backed by
**Kobalte** headless primitives, styled with **Tailwind CSS** + **CVA**
(class-variance-authority), and coloured through the `--ui-*` token contract in
`@shared/design-tokens` ([[design-tokens]]).

## The three layers

There is no single component package. There are two shared layers and one
product layer, and which one a component belongs in is decided by
[[osn-and-musubi]]'s discriminator rather than by taste:

| Package        | On disk                                   | Holds                                                                                                                                                                           | Depends on                                                              |
| -------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `@shared/ui`   | `shared/ui/src/ui/`, `shared/ui/src/lib/` | The primitives — `Button`, `Card`, `Modal`, `Field`, `Table`, `Input`, `Select`, the rest — plus `cn()` and `clsx()`                                                            | `@kobalte/core`, `clsx`, `tailwind-merge`, CVA                          |
| `@osn/auth-ui` | `osn/auth-ui/src/`                        | The auth views — `SignIn`, `Register`, `PasskeysView`, `StepUpDialog`, `TotpView`, `SessionsView`, `RecoveryCodesView`, `ChangeEmailForm`, the profile forms, `TurnstileWidget` | `@shared/ui`, `@osn/client`, `@shared/toast`, `@simplewebauthn/browser` |
| `@cire/ui`     | `cire/ui/src/`                            | cire's house style — `Button`, `Card`, `Loading`, `DietaryPresets`, `DietaryPresetsPopover`, `Reveal`, a combobox `UsernameInput`                                               | `@shared/ui`, `@shared/design-tokens`                                   |

[[osn-and-musubi]] §Where the UI packages landed is the canonical statement of
_why_ the line falls there, and is not re-argued here. The short version is that
nobody has to spell `Button` our way to interoperate, so the primitives are
neither OSN nor Musubi and live under `shared/`; every auth view is paired with
a named ceremony in the spec, so those stay in `osn/`.

Who consumes what today: `@shared/ui` is a dependency of `musubi/social`,
`pulse/web`, all four cire surfaces, `@cire/ui`, `@osn/auth-ui`, `tools/lab` and
`tools/metrics`. `@osn/auth-ui` is consumed by `musubi/social` alone — it is the
only surface that runs the ceremonies. `@cire/ui` is consumed by the four cire
surfaces.

> [!warning] A primitive never imports upward
> `@shared/ui` knows nothing of `@osn/client`, of a session, or of an app's
> colour names. A component that needs any of those is an auth view or product
> chrome, not a primitive, and belongs in one of the other two packages.

## Why Zaidan / shadcn-style?

- **Owned source** — components live in the repo, not behind a version pin. Customise freely without forking a library.
- **Kobalte underneath** — headless primitives give proper ARIA semantics, focus trapping, portal rendering, and keyboard navigation by default.
- **CVA variants** — type-safe variant props (`variant="secondary"`, `size="sm"`) with consistent class composition.
- **Tailwind-native** — the styling is utilities against the token contract, so there is no second runtime theme system to keep alive.

## Where components live

```
shared/ui/src/
├── lib/
│   ├── utils.ts            ← clsx re-export, cn()
│   └── qr.ts               ← the byte-mode QR encoder behind <QrCode>
└── ui/
    ├── avatar.tsx          ← Avatar, AvatarImage, AvatarFallback
    ├── badge.tsx           ← Badge (variant-based)
    ├── button.tsx          ← Button + buttonVariants (CVA)
    ├── card.tsx            ← Card, CardHeader, CardTitle, …
    ├── checkbox.tsx        ← Checkbox (Kobalte)
    ├── chip.tsx            ← Chip
    ├── control.ts          ← controlClass / ControlSize — the box Input, Textarea and Select share
    ├── dialog.tsx          ← Dialog, DialogContent, … (Kobalte)
    ├── dropdown-menu.tsx   ← DropdownMenu, DropdownMenuItem, … (Kobalte)
    ├── empty-state.tsx     ← EmptyState
    ├── field.tsx           ← Field, Fieldset
    ├── info-popover.tsx    ← InfoPopover (circled glyph beside a form label)
    ├── input.tsx           ← Input
    ├── label.tsx           ← Label
    ├── meter.tsx           ← Meter
    ├── modal.tsx           ← Modal — the platform <dialog>, top layer
    ├── notice.tsx          ← Notice
    ├── otp-input.tsx       ← OtpInput (6-digit code verification)
    ├── popover.tsx         ← Popover, PopoverTrigger, … (Kobalte)
    ├── props.ts            ← SafeProps — element props minus innerHTML/innerText/textContent
    ├── qr-code.tsx         ← QrCode
    ├── radio-group.tsx     ← RadioGroup, RadioGroupItem (Kobalte)
    ├── select.tsx          ← Select (native <select>, Input's box)
    ├── stat.tsx            ← Stat
    ├── table.tsx           ← Table and its parts
    ├── tabs.tsx            ← Tabs, TabsList, TabsTrigger (Kobalte)
    ├── textarea.tsx        ← Textarea
    └── username-input.tsx  ← UsernameInput ("@" prefix + availability status)

osn/auth-ui/src/
├── index.ts                ← the barrel; most views also have their own subpath
│                             (RecoveryLoginForm and TurnstileWidget are barrel-only)
├── SignIn.tsx              ← Button, Input, Label, OtpInput
├── Register.tsx            ← Button, InfoPopover, Input, Label, OtpInput, UsernameInput
├── CreateProfileForm.tsx   ← UsernameInput
├── PasskeysView.tsx  StepUpDialog.tsx  TotpView.tsx  SessionsView.tsx
├── RecoveryCodesView.tsx   RecoveryLoginForm.tsx     ChangeEmailForm.tsx
└── ProfileOnboarding.tsx   ProfileSwitcher.tsx  SecurityEventsBanner.tsx  TurnstileWidget.tsx

cire/ui/src/
├── button.tsx  card.tsx  loading.tsx
├── dietary-presets.tsx     dietary-presets-popover.tsx
├── reveal.tsx              ← opens a block to its own height; the wrapper outlives the content
└── username-input.tsx      ← a combobox-shaped input; see cire/ui/README.md for why it is not the shared one
```

### `SafeProps` — why the primitives do not accept `innerHTML`

Solid's `HTMLAttributes` includes `innerHTML`, `innerText` and `textContent`,
and dom-expressions assigns `innerHTML` as markup, unescaped. A primitive that
spreads its rest props onto an element therefore type-checks
`<Notice innerHTML={vendorName} />`, which reads at the call site like ordinary
prop passing and is a script tag. `shared/ui/src/ui/props.ts` omits the three,
so the mistake is a compile error. Anything that genuinely needs to write markup
reaches for a bare element and says why.

### `InfoPopover` — the form-field explainer

A circled glyph beside a form label, opening a `Popover` panel that says what the
field is for. `glyph` chooses the character (`?` by default, `i` where the panel
states a fact rather than answering a question), and `placement` chooses the side —
Kobalte's default `"bottom"` opens the panel over whatever sits below the trigger,
which for a field label is the input itself, so a form field usually wants `"top"`.

The trigger is a native `<button type="button">`: Kobalte's `ButtonRoot` supplies
that default, so it never submits the form it sits inside. `@shared/ui`'s own tests
hold that guarantee rather than trusting it.

> [!important] Why `PopoverContent` carries `data-kb-top-layer`
> Kobalte's `Dialog` defaults to `modal: true` and sets `aria-hidden="true"` on
> everything outside itself — including nodes portalled to `<body>` after it
> opened, which it reaches with a `MutationObserver`. `PopoverContent` portals to
> `<body>`, so a popover opened from inside a dialog would be visible on screen
> and absent from the accessibility tree. `data-kb-top-layer` is what exempts a
> node from that walk; Kobalte itself sets it on `ToastRegion` and nowhere else.
>
> It sits on `PopoverContent` rather than behind a prop, because a prop is
> something every call site inside a dialog has to remember. Outside a dialog
> nothing walks the tree and the attribute does nothing.
>
> A test covering this **must flush macrotasks first**: the hide defers through
> `setTimeout` then `requestAnimationFrame`, so a check made immediately passes
> while the panel is in fact hidden. `shared/ui/tests/ui/info-popover.test.tsx`
> holds the guarantee, rendering the popover inside a real `Dialog`.

## Importing

Each layer has its own specifier shape, and they do not agree on default versus
named. `@shared/ui` exports a **named** binding per component. `@osn/auth-ui`
exports a barrel _and_ a subpath per view. `@cire/ui` is mixed: its six
components — `button`, `card`, `dietary-presets`, `dietary-presets-popover`,
`loading`, `reveal` — are **default** exports, while `username-input` is named, and
`card` carries named `CardEyebrow` / `CardCta` / `CardCtaButton` beside its
default. So a named `Button` import from `@cire/ui/button` resolves to nothing:

```typescript
import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { clsx } from "@shared/ui/lib/utils"; // conditional class joining
import { cn } from "@shared/ui/lib/utils"; // only for Tailwind conflict resolution

import { SignIn } from "@osn/auth-ui/SignIn"; // or: import { SignIn } from "@osn/auth-ui";

import CireButton from "@cire/ui/button";
```

## Dependency stack

| Package                    | Role                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `@kobalte/core`            | Headless UI primitives (Dialog, Popover, Tabs, RadioGroup, Checkbox, DropdownMenu) |
| `class-variance-authority` | Type-safe variant definitions for Button, Badge                                    |
| `clsx`                     | Conditional class string joining                                                   |
| `tailwind-merge`           | Tailwind class conflict resolution (used only via `cn()`)                          |

These are dependencies of `@shared/ui`. Consuming apps get them transitively — no extra installs needed.

> [!note] Kobalte is not free everywhere
> `cire/invites` and `cire/landing` carry no Kobalte at all, and importing
> `@kobalte/core/dialog` costs 15.3 KB gzip against roughly 11.7 KB of headroom
> in each. That is why `Modal` is built on the platform `<dialog>` rather than
> on Kobalte's. The measurement, its method and which of the two to reach for
> are in [[native-dialog-over-kobalte]]; the budgets are in
> `scripts/bundle-size-budgets.txt`, and the rules they obey in
> [[bundle-size-guards]].

## Class composition: the `base:` prefix, `clsx()`, and `cn()`

Three approaches handle class composition at different levels — one source convention and two functions:

### `base:` prefix — component defaults (zero-specificity via CSS)

Component files write `base:` prefixed classes directly in source strings. These compile to `:where()` selectors with zero CSS specificity, so any consumer class automatically wins via cascade — no runtime JS needed:

```typescript
import { clsx } from "clsx";

// In a component file:
<div class={clsx("base:bg-ui-surface base:rounded-ui-lg base:border", local.class)} />

// base:bg-ui-surface compiles to :where(.base\:bg-ui-surface) { … } — zero specificity
// Consumer passes class="bg-card/50 rounded-md" → wins via CSS cascade
```

> **Note:** The `base:` prefix must be written literally in source strings. Tailwind v4's scanner does static analysis and cannot resolve runtime transforms.

### `clsx()` — conditional class joining (no conflict resolution)

Use for composing non-conflicting class sets, conditional classes, and signal-driven toggles:

```typescript
import { clsx } from "@shared/ui/lib/utils";

clsx("px-4 py-2", isActive && "font-bold", props.class);
```

### `cn()` — arbitrary runtime merging (with `tailwind-merge`)

Reserved for rare cases where two arbitrary class sets may contain conflicting Tailwind utilities and neither is a component default. `cn()` wraps `clsx` + `tailwind-merge` (~14 KB) for runtime conflict resolution:

```typescript
import { cn } from "@shared/ui/lib/utils";

// Only use when you genuinely have unpredictable conflicts:
cn(dynamicClassesFromSignalA(), dynamicClassesFromSignalB());
```

**Rule**: component files use `base:` prefixed strings + `clsx()`. Consumer code uses `clsx()`. Use `cn()` only when you'd otherwise get broken styles from conflicting classes.

## Performance guidelines

### Prefer `classList` for reactive class toggles

SolidJS's `classList` directive performs fine-grained DOM updates — it adds/removes individual classes without touching the rest of the class string. When using `cn()` inside a `class` attribute binding, every signal change recomputes the entire class string and replaces the full `className`.

For static or low-cardinality elements (a few buttons, a card header), `cn()` is fine. But inside `<For>` loops or any hot path that renders many items, prefer `classList`:

```tsx
// Prefer this in <For> loops:
<button
  class="rounded-ui-md px-3 py-1.5 text-ui-sm font-medium"
  classList={{
    "bg-ui-accent text-ui-on-accent": isActive(),
    "bg-ui-ground text-ui-ink": !isActive(),
  }}
>

// Avoid this in <For> loops:
<button class={cn("rounded-ui-md px-3 py-1.5 text-ui-sm", isActive() ? "bg-ui-accent" : "bg-ui-ground")}>
```

### Use `createMemo` for filtered/mapped arrays

When passing a derived array to `<For>`, wrap it in `createMemo` so the array reference is stable unless the actual contents change:

```tsx
// Good — stable reference, <For> only diffs when filter result changes
const visibleTabs = createMemo(() => tabs.filter((t) => t.show()));
<For each={visibleTabs()}>{...}</For>

// Avoid — new array on every render, <For> diffs all items every time
<For each={tabs.filter((t) => t.show())}>{...}</For>
```

### Bundle size: `tailwind-merge` and the `base:` variant

Component files write `base:` prefixed classes directly in source strings (e.g. `"base:bg-ui-surface base:rounded-ui-lg"`) and compose with `clsx()`. The `base:` custom variant compiles to `:where()` selectors with zero specificity, so any unprefixed consumer class wins via CSS cascade — no runtime `twMerge` needed. `tailwind-merge` (~12-14 KB) is still bundled for the exported `cn()` function but is NOT called in the component render hot path.

If `tailwind-merge` is tree-shaken (i.e. no consumer imports `cn()`), the bundle drops by ~14 KB. If bundle size is a concern and `cn()` is still imported somewhere, consider refactoring the consumer to use `clsx()` instead — most conditional class composition doesn't involve Tailwind conflicts.

> **Important:** `base:` prefixes must be written directly in source strings, not generated at runtime via a function. Tailwind v4's JIT scanner does static analysis of source files — it cannot see classes produced by a runtime transform.

## Tokens: what an app has to declare

Components are written against the `--ui-*` contract — `bg-ui-surface`,
`text-ui-ink-secondary`, `text-ui-sm`, `rounded-ui-md`, `border-ui-hairline`.
The full vocabulary, its contrast floors and the conformance harness are in
[[design-tokens]]; what a _consuming app_ owes the components is two things in
its root stylesheet:

1. **`@import "@shared/design-tokens/tokens.css"`.** That file carries the
   `@custom-variant base (:where(&))` the primitives need, and the `@source`
   lines for every shared package that writes contract classes —
   `shared/ui/src`, `osn/auth-ui/src`, `shared/toast/src` and
   `shared/sortable/src`. No app declares any of those itself; the paths in that
   file resolve against its own real location rather than through the
   `node_modules` symlink.
2. **A `--ui-*` mapping block**, anywhere in the cascade above the components,
   pointing the contract at the app's own colour names. The app keeps its own
   vocabulary — `bg-card` in pulse, `text-gold` in cire — and maps once.

```css
/* pulse/web/src/app.css */
@import "tailwindcss";
@import "@shared/design-tokens/tokens.css";

:root {
  --ui-ground: var(--background);
  --ui-surface: var(--card);
  --ui-ink: var(--foreground);
  --ui-accent: var(--primary);
  --ui-on-accent: var(--primary-foreground);
  /* … */
}
```

`pulse/web/src/app.css` and `cire/host/src/styles/global.css` are the two worked
examples — one mapping a shadcn ramp, one mapping cire's two OKLCH ramps.

> [!important] A product package's `@source` goes in the app, never in the contract
> `@cire/ui` lives outside every app that renders it, so each cire surface adds
> `@source "../../../ui/src";` to its own `global.css`. That line must **not**
> move into `@shared/design-tokens`: a shared file pointing at a product package
> inverts the layering and would scan cire's classes into every musubi, pulse,
> lab and metrics build.

Ten edges across six Kobalte-backed primitives still spell `border-border` and
`bg-border` rather than a contract token, so a consuming app also defines a
`--color-border` alias; every app that depends on `@shared/ui` today does.

_Measured 2026-09-17 — `grep -o 'base:bg-border\|base:border-border' shared/ui/src/ui/*.tsx | cut -d: -f1 | sort | uniq -c`_

## Component patterns

### Variant components (Button, Badge)

Use CVA for components with discrete visual variants:

```tsx
import { Button } from "@shared/ui/ui/button";

<Button variant="default">Primary action</Button>
<Button variant="secondary" size="sm">Secondary</Button>
<Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
<Button variant="destructive">Delete</Button>
```

For links that need button styling, use the exported `buttonVariants` function:

```tsx
import { buttonVariants } from "@shared/ui/ui/button";

<A href="/settings" class={buttonVariants({ variant: "secondary", size: "sm" })}>
  Settings
</A>;
```

### Kobalte components (Dialog, Popover, Tabs, RadioGroup, Checkbox)

These wrap Kobalte primitives with styling. They provide proper accessibility by default:

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@shared/ui/ui/dialog";

<Dialog
  open
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Modal Title</DialogTitle>
    </DialogHeader>
    {/* content */}
  </DialogContent>
</Dialog>;
```

Key behaviours you get by default:

- **Dialog** — portaled to `<body>`, overlay click dismisses, Escape key dismisses, focus trapped
- **Popover** — portaled, auto-positioned, outside click/Escape dismisses
- **Tabs** — `role="tablist"` / `role="tab"` / `role="tabpanel"`, keyboard arrow navigation
- **RadioGroup** — grouped `role="radiogroup"`, single selection, keyboard navigation
- **Checkbox** — `role="checkbox"`, indeterminate support

### Simple styled components (Input, Label, Card, Textarea, Select)

Thin wrappers that apply consistent base styling and accept a `class` prop for overrides. `Input`, `Textarea` and `Select` share one box, defined once in `shared/ui/src/ui/control.ts` with two sizes — `md` for a form, `sm` for a control inside a table row — so a date and a currency line up in a column:

```tsx
import { Input } from "@shared/ui/ui/input";
import { Label } from "@shared/ui/ui/label";
import { Card } from "@shared/ui/ui/card";

<Card class="p-4">
  <Label for="email">Email</Label>
  <Input id="email" type="email" class="mt-1" />
</Card>;
```

### Overlays: `Modal`, and why its exit is deferred

`@shared/ui`'s `Modal` is the platform's `<dialog>` with `showModal()`. The focus
trap, Escape-to-close, background inertness and `::backdrop` all come from the
browser, and the element renders in the **top layer** — above every stacking
context in the document by definition, which is what makes it immune to the
`transform`-traps-`position: fixed` bug documented in [[frontend-patterns]]. It
therefore needs **no `z-index` and no portal**.

`@shared/ui` ships a Kobalte-backed `Dialog` too. Which to reach for, and why
`Modal` exists at all, is [[native-dialog-over-kobalte]] — not re-argued here.

Its motion is split, and the split is not arbitrary:

|           | How                         | Why there                                                                                                                                                                                              |
| --------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Entry** | `@starting-style`, pure CSS | The browser takes the from-state when the element is first rendered. No JavaScript at all. Safari has had it since 17.5; older engines show the dialog immediately, which degrades rather than breaks. |
| **Exit**  | JavaScript defers `close()` | `close()` drops a dialog out of the top layer _immediately_, so an exit transition has nothing left to paint.                                                                                          |

**The CSS-only exit does not work cross-browser, and this is the thing to know
before reaching for it.** The platform's own answer is the `overlay` property
with `transition-behavior: allow-discrete`, which defers that removal so the
transition can run. `overlay` is **Chrome and Edge only** — unsupported in
Safari and Firefox. On cire's guest site, where most traffic is mobile Safari, a
CSS-only exit means the dialog blinking away for nearly everyone who sees it.

So `Modal` sets `data-closing`, lets its own stylesheet run the exit, and calls
`close()` once the element's animations have finished. It waits on
`getAnimations({ subtree: true })` rather than a named transition, so an app
animating the panel with Motion One or the Web Animations API is waited out the
same way — the hook is animation-library-agnostic without naming a library.

Timing is two custom properties, so an app retimes rather than restyles:

```css
:root {
  --ui-modal-enter: 350ms;
  --ui-modal-exit: 200ms;
}
```

`prefers-reduced-motion` drops both to 1ms rather than `none`: the exit is
_awaited_, and a transition that never started is one there is nothing to wait
for.

> [!important]
> **Keep the modal mounted across the close.** `Modal` can only animate its exit
> while the element is still in the document, so drive `open` and leave the
> component where it is. `<Show when={sheet()}>{() => <Modal open …>}</Show>`
> unmounts the dialog the instant the value goes null, and the exit silently
> does not play. Put the `Show` _inside_ the modal instead, or hold the last
> value in a signal.

#### Overriding a `Modal` default: plain utilities, never `base:` ones

`Modal`'s defaults are `base:`-prefixed, which compiles to `:where(…)` and
therefore **zero specificity** — the whole point being that a caller's utility
wins. That only holds when the caller's utility is _plain_.

A `base:` one on the same property ties, and a tie is resolved by **Tailwind's
stylesheet order**, which is neither the order of the `class` attribute nor
anything the call site can see. Measured in `cire/invites`' built CSS,
`.base\:max-w-ui-sm` is emitted after `.base\:max-w-lg`, so the component beat
its own caller — silently, with every string assertion still passing.

```tsx
// Right: a plain utility beats `:where(…)` every time.
<Modal class="max-w-lg bg-bg" …>

// Wrong: ties with Modal's own, resolved by stylesheet order.
<Modal class="base:max-w-lg base:bg-bg" …>
```

Where a dialog's rendered size or surface is load-bearing, pin it in the browser
tier: the defect is invisible to anything that reads a class attribute, and
`cire/invites/tests/components/consent/consent-dialog-surface.browser.test.tsx`
is the worked example.

Same rule for any `base:`-styled component, not just `Modal`. The prefix belongs
to a component's own defaults; a caller writes plain utilities.

#### `frame`, for a panel that must not scroll

The default shape is the simple one: the panel scrolls and the panel is padded.
That breaks the moment something has to stay put while the body moves under it —
a close button in the corner, a sticky action bar at the foot — because a child
of the scrollport scrolls away with the content, and a `position: sticky` bottom
bar resolves its offset against the scrollport rather than against its parent.

`frame` drops the panel's own padding and overflow and makes it a column flex
container, so a child owns the scrollport and the furniture sits beside it. The
child needs its own `min-h-0`, or it cannot shrink under the panel's
`max-height` and nothing scrolls.

Two details worth carrying.

`frame` sets `p-0` rather than merely omitting the padding. **The user-agent
stylesheet gives every `<dialog>` `padding: 1em`**, so a component that writes
no padding rule ships a 16px band its caller cannot see in its own markup.

And the panel **clips rather than hides**. `overflow: hidden` refuses the user a
scrollbar and grants everything else — `scrollIntoView`, and the scroll the
platform performs when focus lands on a descendant it believes sits outside the
box — so a `hidden` panel can be slid sideways with no affordance to slide back.
`overflow: clip` is not a scroll container and has no scroll offset to move.
Both axes have to say it: beside an `auto` axis, `clip` computes to `hidden`
(CSS Overflow 3 §3.1). This does not change what a popover portalled into the
open dialog can do — it is clipped by the frame either way; see xchromo/osn#1089.

#### `presentation`, for where the panel sits

`centred` (the default), `sheet` and `drawer`. It is one prop rather than a
handful of utilities because the classes only mean anything together: a sheet is
not "a centred dialog with `rounded-b-none`" — it is bottom-anchored, which is
what makes its bottom corners square, which is what makes its top corners the
thing the eye reads as a grip. Set one without the others and the result is a
centred card with a corner missing.

Five call sites across three products had each spelled the combination out, and
they disagreed on the radius (28px against 8px), on the breakpoint (`sm` against
`md`) and on whether `env(safe-area-inset-bottom)` was accounted for at all.

|           | Anchor                                   | Radius                                  | Surface it defaults to |
| --------- | ---------------------------------------- | --------------------------------------- | ---------------------- |
| `centred` | centred, `85vh` cap                      | `rounded-ui-lg`                         | `raised`               |
| `sheet`   | bottom edge below `md`, centred at `md`+ | `rounded-ui-sheet` on top, square below | `surface`              |
| `drawer`  | right edge, full height                  | none                                    | `surface`              |

In the non-`frame` shape, `sheet` also carries the padding a sheet needs — room
at the top for a close button, and a bottom `max()`-ed against the home
indicator's inset.

The plane is its own prop, `surface`, because it varies independently of the
anchor. A sheet and a drawer default to `surface` rather than `surface-raised`
on purpose — a panel flush with an edge reads as part of the page, while a
centred dialog floats above it — but an app can want either at either anchor.
The third value, `ground`, is for the case where the panel's own contents are
cards: cire's consent sheet holds raised category rows, so the sheet behind them
has to sit _below_ them or the rows stop reading as rows, and
`cire/invites/tests/components/consent/consent-dialog-surface.browser.test.tsx`
is what holds that.

`DialogContent` takes the same `sheet`, for the Kobalte-backed dialog.

#### What has to sit above a modal — and why a `z-index` will not do it

The top layer is the reason to use `Modal`, and it is also the trap. It paints
above every stacking context **by definition**, so nothing outside it can be
raised over an open dialog at any number. Anything that must appear over a sheet
has to join the top layer, and there are exactly two doors:

| Element       | Enters the top layer by                | Painting order                           |
| ------------- | -------------------------------------- | ---------------------------------------- |
| A dialog      | `showModal()`                          | Entry order — later entries paint on top |
| Anything else | `showPopover()` on a `popover` element | Same                                     |

So a menu or a toast raised _after_ a dialog opened paints above it. That is the
whole mechanism, and it is enough for paint.

> [!warning]
> **The top layer is no exemption from `inert`.** A modal dialog makes every
> node outside it inert — not hit-testable, not reachable by assistive
> technology — however it is painted. A popover shown outside the dialog is
> therefore _visible and dead_.
>
> Only a descendant of the dialog escapes that. A menu opened from inside a
> sheet must render **in place**, with `popover` doing the job a `<Portal>` used
> to: out of every ancestor stacking context, without leaving the dialog. A
> container mounted once at the page root — a toaster — cannot be a descendant
> of anything, so a toast raised over a modal is seen and nothing more, and has
> to be a confirmation the dialog itself also states.

Both of these are live in `cire/invites`: `AddToCalendar` renders in place as a
popover, and `@shared/toast`'s `Toaster` takes a `topLayer` flag that shows the
container as a popover while it has something to show ([[toast]] §`topLayer`).
`cire/invites/src/lib/z-index.ts` documents what is left for numbers to decide,
which is everything that is not a dialog.

Three consequences for tests, each of which fails in a way that reads as a
component bug:

- **jsdom implements no part of `<dialog>`.** `showModal` is `undefined`, not
  inert; `Modal` degrades to a non-modal dialog, and Escape, the backdrop,
  modality and the focus restore cannot be asserted at all. Assert the wiring by
  dispatching the `close` event the platform would have fired, and put the
  gestures in the browser tier ([[browser-tests]]).
- **A dialog left open outlives its test.** `document.querySelector("dialog")`
  then finds the previous test's sheet rather than this one's, so a browser file
  rendering dialogs needs `afterEach(cleanup)`.
- **`getBoundingClientRect()` is post-transform**, and `Modal` animates in from
  `translateY(24px) scale(0.98)`. A rect read before the entry transition
  finishes is the layout box moved and scaled, and every comparison against
  `clientWidth` or `offsetLeft` is wrong by that much. Wait it out —
  `await Promise.allSettled(panel.getAnimations({ subtree: true }).map((a) => a.finished))`
  — after one frame, so the transition has actually started.

The motion itself is benched in `@tools/lab` under **shared/ui/overlays →
ModalMotion**, with the two durations on sliders ([[component-lab]]). Whether a
curve looks right is not a question a test can answer; whether the exit _runs_,
and whether the dialog stays in the top layer until it finishes, are — and
`shared/ui/tests/modal.browser.test.tsx` asserts both.

## What a call site may set, and what it may not

`shadcn/no-restyle` is at `error` in `oxlintrc.json`. It reports a call site that
changes a shared component's **colour, shape, spacing, typography or effects**
from outside. Two things stay the caller's, and the rule is configured to allow
both:

- **Layout** — `mt-*`, `w-full`, `flex-1`, `self-start`, `col-span-*`,
  `max-w-*`, `absolute`, `order-*`. Where a component sits is the page's
  business, not the component's.
- **`gap-*` on a container whose children are the caller's** — `Card`,
  `CardContent`, `CardFooter`, `CardHeader`, `Modal`, `DialogFooter`,
  `DialogHeader`, `PopoverTrigger`, `DropdownMenuTrigger`. The rhythm between a
  caller's own children belongs to the caller. `gap-*` on `Button` does not: the
  space between a button's icon and its label is the button's.

Everything else has four legitimate answers, in order of preference: use a
variant that exists; add one, named and documented, when the treatment appears
more than once or is a real design concept; delete the class when it restates
the component's own default; move it onto a wrapper when it is really page
layout. Suppressing the rule is not one of them, and neither is picking a class
that happens to slip past it.

The reason the rule can be trusted at `error` is that it reads the component's
own variants and names them in the diagnostic — `Use a variant: default,
destructive, outline, secondary, ghost, link` — so the fix arrives with the
error rather than needing a trip to the source.

### cire's `Button`, as a vocabulary

`@cire/ui`'s `Button` is the house style rather than the shadcn set — uppercase,
tracked, a sharp 4px corner, a gold primary — and on a cire surface it is where a
call site's colour, shape and padding have to come from. Fourteen variants,
grouped by the job rather than by the look:

| Group          | Variants                              | What each is for                                                                                                                                                                                                                              |
| -------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit         | `primary`, `cta`                      | The one thing to do on the screen. `cta` is the guest site's: outlined at rest and filled on hover, because an invite is restrained enough that a gold fill at rest would be the loudest thing on a page whose job is a photograph and a date |
| Secondary      | `outline`, `quiet`, `dashed`          | A gold wash, a neutral action, and the empty slot — a dashed box promises that something _appears_, a solid one that something _happens_                                                                                                      |
| Destructive    | `danger`, `quietDanger`, `bareDanger` | Red at rest for the button that commits it; muted at rest and red on hover for the control that merely offers it, boxed (`quietDanger`) or as a glyph (`bareDanger`). A column of red-outlined buttons down a table reads as an error state   |
| Text           | `link`, `subtle`, `touchLink`         | Accent ink, muted ink, and muted ink carrying its underline at rest. The last belongs to `@cire/invites`, which is read on a phone — there is no hover there to reveal one                                                                    |
| Glyph          | `bare`                                | An arrow, a cross, a disclosure caret. No underline, because there is no word to underline                                                                                                                                                    |
| State and fill | `choice`, `tile`                      | One option among several, marked through `aria-pressed` **or** `aria-checked` so a toggle group and a radio group look the same; and the control that _is_ a block — a card, a row — where a hairline stops describing the target             |

Five sizes, and they are not one scale:

| Size             | What it gives                                     | For                                                                                                              |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `sm`, `md`, `lg` | three steps of label padding and type             | An ordinary control                                                                                              |
| `swatch`         | one hairline of padding, no type at all           | A control whose content is the thing itself — a colour swatch, a product thumbnail. The picture is what sizes it |
| `icon`           | square, sized to the glyph rather than to a label | A single glyph                                                                                                   |

Three sizing tables, picked by the variant. The borderless ones take the type
step and none of the box padding, because `px-4 py-2` around a text link is a
word floating in a gap. `tile` takes square block padding, because its interior
is a small layout — a numbered marker beside two lines of text — rather than a
word. Everything else takes the ordinary one.

`cire/ui/src/button.tsx` carries the reason for each in its own doc comment, and
that is the bar for adding one: a variant is a design concept somebody can name,
not a colour somebody wanted. `custom`, `alt` and `variant2` are not names.

## Adding a new component

A primitive, in `@shared/ui`:

1. Create the file at `shared/ui/src/ui/<name>.tsx`.
2. Follow the existing pattern: `splitProps` for `class`, write `base:` prefixed defaults literally in the class string, use `clsx()` to compose them with `local.class`, spread `...others`. Type the rest props as `SafeProps<"div">` (from `./props`) rather than Solid's own attributes.
3. Colour it with contract tokens — `bg-ui-surface`, `text-ui-ink`, `border-ui-hairline` — never an app's own name. See [[design-tokens]].
4. For interactive components, use Kobalte primitives from `@kobalte/core/<name>`. Weigh the bundle cost first if the component has to render on a cire surface — and if only _some_ callers need the heavy dependency, **give them a separate file to import**, not a prop. A `<Show>`, a `createMemo` or a `shell` prop does not help: a bundler follows the static import, so every caller pays for the branch none of them took. Kobalte's popover is ~18.7 KB gzip, which is enough on its own to put `@cire/invites` over its budget in [[bundle-size-guards]]. `cire/ui/src/dietary-presets.tsx` (fields, no Kobalte) and `dietary-presets-popover.tsx` (the same fields behind a trigger) are the worked pair.
5. For a text control, reach for `controlClass` in `./control` instead of writing a box.
6. For variant components, use CVA with a literal `base:` prefixed string for each variant, and export both the component and the `variants` function.
7. For internal child elements that don't accept consumer `class` overrides, write the `base:` prefixed string directly (no `clsx` needed).
8. Add a subpath export in `shared/ui/package.json`:
   ```json
   "./ui/<name>": "./src/ui/<name>.tsx"
   ```
9. Add a test under `shared/ui/tests/` — `tests/ui/<name>.test.tsx` for DOM shape and wiring, `tests/<area>.browser.test.tsx` for anything that needs real CSS or layout.
10. Add it to the lab's catalogue story for its group, under `tools/lab/src/stories/shared-ui/` ([[component-lab]]).
11. No barrel file — consumers import individual components by path.

An auth view goes to `osn/auth-ui/src/<Name>.tsx` instead, with both a subpath
export and a line in `osn/auth-ui/src/index.ts`, and a test in
`osn/auth-ui/tests/`. cire chrome goes to `cire/ui/src/<name>.tsx`. If it is not
obvious which of the three, [[osn-and-musubi]] decides it.

## Testing considerations

`@shared/ui` runs two projects out of one `vitest.config.ts`, split by filename:
`tests/**/*.test.tsx` is the `unit` project on happy-dom, and
`tests/**/*.browser.test.tsx` is the `browser` project on real Chromium. Every
file lands in exactly one. `bun run --cwd shared/ui test:run` runs the first,
`test:browser` the second; `@osn/auth-ui` and `@cire/ui` have a unit tier only.

The split exists because the unit project parses no stylesheet and computes no
layout: it can assert a class list and a DOM shape, but not that a class emitted
CSS, won the cascade, or painted anything. The browser project loads
`shared/ui/tests/test-support/tailwind.css`, which stands in for an app by
mapping the whole `--ui-*` contract to a deliberately garish synthetic palette —
the neutral fallbacks collapse several roles onto one value, which is exactly
what a "tone is not carried by hue alone" assertion needs to tell apart. See
[[browser-tests]].

- Components render standard HTML — tests use `@solidjs/testing-library` with role/label queries
- **Kobalte portals**: Dialog and Popover content is portaled to `<body>`. Use `screen.queryByText()` (searches full document) instead of `container.querySelector()` (searches render container only)
- **`base:` prefixed class selectors**: Component default classes are prefixed with `base:` in the DOM (e.g. `base:relative` instead of `relative`). CSS selectors must escape the colon: `span.base\\:relative`. Consumer-provided classes (via `class` prop) are NOT prefixed and can be selected normally
- **Avatar DOM structure**: The `Avatar` wrapper has `base:relative` class. The fallback text is inside a nested `<span>`. Tests that find avatars should use `span.base\\:relative`
- **Close-friend ring**: Applied to the outer `Avatar` wrapper via `clsx()` (not prefixed — it's a consumer class), not to the inner `<img>` or fallback `<span>`

## Source files

| File                                        | What it is                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `shared/ui/src/ui/`                         | Every primitive's source                                                     |
| `shared/ui/src/lib/utils.ts`                | `clsx`, `cn()`                                                               |
| `shared/ui/src/ui/control.ts`               | The shared text-control box                                                  |
| `shared/ui/src/ui/props.ts`                 | `SafeProps`                                                                  |
| `shared/ui/package.json`                    | The subpath exports                                                          |
| `shared/ui/vitest.config.ts`                | The unit / browser project split                                             |
| `shared/ui/tests/test-support/tailwind.css` | The stylesheet the browser tier renders against                              |
| `osn/auth-ui/src/index.ts`                  | The auth-view barrel                                                         |
| `osn/auth-ui/package.json`                  | Per-view subpath exports                                                     |
| `cire/ui/README.md`                         | Why those components are cire's and not shared                               |
| `shared/design-tokens/src/tokens.css`       | The `--ui-*` contract, the `base:` variant and the `@source` lines           |
| `pulse/web/src/app.css`                     | An app's mapping block — shadcn ramp                                         |
| `cire/host/src/styles/global.css`           | An app's mapping block — cire's two OKLCH ramps, plus `@cire/ui`'s `@source` |
