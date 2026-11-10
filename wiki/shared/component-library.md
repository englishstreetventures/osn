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
last-reviewed: 2026-11-10
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
| `@shared/ui`   | `shared/ui/src/ui/`, `shared/ui/src/lib/` | The primitives — `Button`, `Card`, `Modal`, `Field`, `Table`, `Input`, `Select`, the rest — plus `clsx()`                                                                       | `@kobalte/core`, `clsx`, CVA                                            |
| `@osn/auth-ui` | `osn/auth-ui/src/`                        | The auth views — `SignIn`, `Register`, `PasskeysView`, `StepUpDialog`, `TotpView`, `SessionsView`, `RecoveryCodesView`, `ChangeEmailForm`, the profile forms, `TurnstileWidget` | `@shared/ui`, `@osn/client`, `@shared/toast`, `@simplewebauthn/browser` |
| `@cire/ui`     | `cire/ui/src/`                            | cire's house style — `Button`, `Card`, `Disclosure`, `Eyebrow`, `FileInput`, `Loading`, `MessageThread`, `Note`, `PersonAvatar`, `SegmentedTabs`, `SignInPanel`, `SignInCard`, `Skeleton`, `SkeletonOutline`, `Wordmark`, `DietaryPresets`, `DietaryPresetsPopover`, `Reveal`, a combobox `UsernameInput` — and the guest-facing content both cire sites publish: the guest privacy notice (`guest-privacy-notice.astro`) and the consent registry it is built from, the footer (`site-footer.astro`) and the legal pages' document (`legal-layout.astro`) | `@shared/ui`, `@shared/design-tokens`, `@shared/legal`                  |

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

Every element a branch draws by hand that one of these packages already draws
is a finding of the `review-design` skill
(`.claude/skills/review-design/SKILL.md`), which `prep-pr` runs on any diff that
changes how a screen looks and which names the component that replaces it. Its
findings take the `U-` prefix in [[review-findings]].

## Why Zaidan / shadcn-style?

- **Owned source** — components live in the repo, not behind a version pin. Customise freely without forking a library.
- **Kobalte underneath** — headless primitives give proper ARIA semantics, focus trapping, portal rendering, and keyboard navigation by default.
- **CVA variants** — type-safe variant props (`variant="secondary"`, `size="sm"`) with consistent class composition.
- **Tailwind-native** — the styling is utilities against the token contract, so there is no second runtime theme system to keep alive.

## Where components live

```
shared/ui/src/
├── lib/
│   ├── utils.ts            ← clsx re-export
│   └── qr.ts               ← the byte-mode QR encoder behind <QrCode>
└── ui/
    ├── avatar.tsx          ← Avatar, AvatarImage, AvatarFallback
    ├── badge.tsx           ← Badge (variant-based)
    ├── button.tsx          ← Button + buttonVariants (CVA)
    ├── card.tsx            ← Card, CardHeader, CardTitle, …
    ├── checkbox.tsx        ← Checkbox — a box ticked to say yes, saved with a form (native)
    ├── choice.ts           ← the box, label and note slot Checkbox and RadioGroupItem share
    ├── chip.tsx            ← Chip
    ├── control.ts          ← controlClass, sizes, fills, faces, heights — the box Input, Textarea and Select share
    ├── dialog.tsx          ← Dialog, DialogContent, … (Kobalte)
    ├── dropdown-menu.tsx   ← DropdownMenu, its items, checkbox, radio and link rows, DropdownMenuHandle (Kobalte)
    ├── empty-state.tsx     ← EmptyState
    ├── field.tsx           ← Field, Fieldset
    ├── info-popover.tsx    ← InfoPopover (circled glyph beside a form label)
    ├── input.tsx           ← Input
    ├── label.tsx           ← Label
    ├── menu-classes.ts     ← the menu's panel, row, label and separator classes — no Kobalte
    ├── menu-touch-classes.ts ← MENU_TOUCH, the guest site's 44px link-menu rows — no Kobalte
    ├── meter.tsx           ← Meter
    ├── modal.tsx           ← Modal — the platform <dialog>, top layer
    ├── notice.tsx          ← Notice
    ├── orb.tsx             ← Orb — a dotted sphere that moves while something is in progress; its own export
    ├── orb-api.ts          ← the types the `./ui/orb` export gives a consumer; no code
    ├── otp-input.tsx       ← OtpInput (6-digit code verification)
    ├── popover.tsx         ← Popover, PopoverTrigger, … (Kobalte)
    ├── portal-mount.ts     ← where a popover's or a menu's panel portals: the open modal dialog, else <body>
    ├── props.ts            ← SafeProps — element props minus innerHTML/innerText/textContent
    ├── qr-code.tsx         ← QrCode
    ├── radio-group.tsx     ← RadioGroup, RadioGroupItem (native)
    ├── select.tsx          ← Select (native <select>, Input's box)
    ├── stat.tsx            ← Stat
    ├── switch.tsx          ← Switch — an on/off change that takes effect at once (native)
    ├── switch-classes.ts   ← the switch's track and thumb classes, which the menu's switch row draws too
    ├── table.tsx           ← Table and its parts
    ├── tabs.tsx            ← Tabs, TabsList, TabsTrigger (Kobalte)
    ├── textarea.tsx        ← Textarea
    ├── tooltip.tsx         ← Tooltip — a label that explains itself on hover (Kobalte)
    └── username-input.tsx  ← UsernameInput ("@" prefix + availability status)

shared/ui/vendor/
└── thinking-orbs/          ← the orb's drawing engine, upstream source kept byte for byte (see §Orb)

osn/auth-ui/src/
├── index.ts                ← the barrel; most views also have their own subpath
│                             (RecoveryLoginForm and TurnstileWidget are barrel-only)
├── SignIn.tsx              ← Button, Input, Label
├── Register.tsx            ← Button, InfoPopover, Input, Label, OtpInput, UsernameInput
├── CreateProfileForm.tsx   ← UsernameInput
├── PasskeysView.tsx  StepUpDialog.tsx  TotpView.tsx  SessionsView.tsx
├── RecoveryCodesView.tsx   RecoveryLoginForm.tsx     ChangeEmailForm.tsx
└── ProfileOnboarding.tsx   ProfileSwitcher.tsx  SecurityEventsBanner.tsx  TurnstileWidget.tsx

cire/ui/src/
├── button.tsx  card.tsx  disclosure.tsx  eyebrow.tsx  loading.tsx  note.tsx
├── file-input.tsx          ← a file input whose button is the quiet pill (FILE_BUTTON)
├── dietary-presets.tsx     dietary-presets-popover.tsx
├── reveal.tsx              ← opens a block to its own height; the wrapper outlives the content
├── message-thread.tsx      ← MessageThread: an enquiry's messages in timed segments, and the reply box
├── message-bubble.tsx      message-composer.tsx  message-info-menu.tsx  ← its parts, not exported
├── lib/message-time.ts     ← the thread's order, segments and time words
├── person-avatar.tsx       ← PersonAvatar: a photo, the empty avatar or an initial
├── avatar-trigger-class.ts ← avatarTriggerClass: the round button an account menu opens from
├── segmented-tabs.tsx      ← SegmentedTabs: a glass track of choices with one sliding highlight
├── sign-in-panel.tsx       ← SignInPanel: the portals' one button to musubi and its error lines
├── sign-in-card-class.ts   ← signInCardClass: the sign-in card's opaque fill and lit edge
├── sign-in-card.astro      ← SignInCard: the sign-in page's label, heading and card around the panel
├── site-footer.astro       ← SiteFooter: both guest-facing sites' footer — sign-off, rule, links, version
├── legal-layout.astro      ← LegalLayout: the legal pages' document, its four slots and the .legal type
├── sign-in-press.ts        ← createSignInPress: what a "Continue with musubi" button does once pressed
├── skeleton.tsx            ← Skeleton: a loading placeholder, in the corner and fill of what it stands in for
├── skeleton-outline.tsx    ← SkeletonOutline: a loading placeholder that is the real row, drawn hollow
├── lib/pulse.ts            ← PULSE: the loaders' pulse on the motion tokens, for Loading and Skeleton (SkeletonOutline writes the same values out); not exported
├── lib/sliding-pill.ts     ← createSlidingPill: one highlight that moves between items
├── lib/auto-size.ts        ← createAutoSize: a box animated between two content heights
├── lib/theme.ts            ← createPreferences: a portal's theme and haptics switch, under its own keys
├── lib/theme-boot.ts       ← themeBootScript: the inline script that sets the theme before first paint
├── lib/haptics.ts          ← createHaptics: touch feedback by event name, limited to a portal's names
├── username-input.tsx      ← a combobox-shaped input; see cire/ui/README.md for why it is not the shared one
└── wordmark.tsx            ← Wordmark: the portals' "✦ Cire" way home; WordmarkPlaceholder, its still copy
```

### `SafeProps` — why the primitives do not accept `innerHTML`

Solid's `HTMLAttributes` includes `innerHTML`, `innerText` and `textContent`,
and dom-expressions assigns `innerHTML` as markup, unescaped. A primitive that
spreads its rest props onto an element therefore type-checks
`<Td innerHTML={vendorName} />`, which reads at the call site like ordinary
prop passing and is a script tag. `shared/ui/src/ui/props.ts` omits the three,
so the mistake is a compile error. Anything that genuinely needs to write markup
reaches for a bare element and says why. The menu's parts and `PopoverContent`
are typed with it; `Notice` and `Chip` go further and take an allow-list of
props. `shared/ui/tests/ui/markup-props.test.tsx` fails the type check if any
of them takes markup again.

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

### `Notice` — five tones, three sizes, a mark that is a shape

`<Notice tone size fill alert>` says something went wrong, went right, or is worth
knowing. Five tones: `danger`, `warn` and `success` each lead with a circled
icon of a different shape (a cross, an exclamation mark, a tick), drawn inline
in [notice.tsx](../../shared/ui/src/ui/notice.tsx) in the tone's ink, sized in
`em` from the text step, `aria-hidden`, with a word read in its place
("Error:", "Warning:", "Success:"). `info` and `accent` carry no mark: they
are standing notes. `accent` paints `--ui-accent-ink`, never `--ui-accent`.

| Size | What it draws | For |
| --- | --- | --- |
| `md`, the default | the box every app drew before the others: `p-4`, `text-ui-base`, the `sm` corner | a block on a page or in a modal |
| `sm` | the same box, compact: `px-3 py-2`, `text-ui-sm` | a note beside a control or in a sidebar |
| `inline` | no border, fill, padding or corner — the mark, the word and the text, in the tone's ink | the error line under a field |

A box takes `fill`: `tint`, the default, or `none`, which keeps the border and
the ink and drops the tint, so the words sit on the ground beneath — for a note
whose ink must clear its contrast floor on that ground alone. The inline line
has no box, and the type refuses `fill` beside `size="inline"`.

All three render a `<div>`, so none sits inside a `<p>` or a `<label>`: a call
site there moves the line out of the paragraph. An inline line about a field
takes an `id` the field names in `aria-describedby`. A notice takes an
allow-list rather than a `<div>`'s props — `id`, `aria-describedby`, `data-*`
and a layout `class` — and the role follows `alert`: nothing else reaches the
element, typed or spread, so no call site can pass markup or a handler, hide
"Error", rename the words or turn an alert into a status. A call site that needs
a status region wraps the notice in one. `mark` draws an app's own icon
and read word in the same slot, for a part built on a tone that has none —
`@cire/ui`'s `Note`, the accent tone led by a ✦. With
no `size` and no `tone`, `Notice` renders the classes it rendered before it had
either: `shared/ui/tests/ui/notice.test.tsx` pins that string and an unfilled
box's as the same less its one fill class, and `primitives.browser.test.tsx`
holds the inline line boxless, an unfilled box's ground transparent, `accent`
off `info`, the icon on the first line and sized from the text step.

### `Chip` — a state in a pill: two variants, two treatments

`<Chip tone variant treatment>` names a state in a pill, in one of five
tones — `neutral`, `success`, `pending`, `accent`, `danger` — named for their
role, never a domain word. In [chip.tsx](../../shared/ui/src/ui/chip.tsx):

| Option | Values | What each draws |
| --- | --- | --- |
| `variant` | `filled`, the default; `outline` | a tinted ground and no border; a 1px border at 40% of the tone (the hairline for `neutral`) and no ground, at the filled chip's height |
| `treatment` | `caps`, the default; `tag` | a status word in small caps, held to one line; a label as written — sentence case, normal spacing, `px-2` — free to wrap |

The filled tints are light on purpose: `success`, `pending` and `accent` at 8%,
`danger` at 10%, `neutral` the surface at 60%. A chip's word is small text,
held to 4.5:1 on what it sits on, and a stronger wash darkens the ground under a
coloured word on a pale theme. `cire/host/tests/styles/chip-contrast.browser.test.tsx`
holds every tone, variant and treatment to 4.5:1 on cire's page and a card's
wash, and the flags' tones on the run sheet's coming-up row, in both themes;
filled `danger` reads 4.65:1 on cire's light page. Musubi draws only the
outline neutral tag, whose word is `--ui-ink-secondary` on the page or a card
with no ground of its own: `musubi/social/tests/styles/design-token-contract.test.ts`
holds that ink at 4.5:1 on every ground and surface, in both themes.

*Measured 2026-10-30 — the composite `cire/host/tests/styles/chip-contrast.browser.test.tsx` paints, read for a filled `danger` tag on the light page (headless Chromium)*

An outline or a tag may lead with a mark — a dot, an icon — held 6px from its
word; a filled small-caps chip holds its word alone. A `danger` chip with no
`variant` is outlined.

A chip is a label, and its word is the state, so it takes an allow-list rather
than a span's props: an `id`, `aria-describedby`, `data-*` attributes, a layout
`class` (appended last), and `role="status"` for a chip whose word changes under
the reader. Nothing else reaches the `<span>`, typed or spread — no handler, no
markup, no `aria-hidden`, `hidden` or `aria-label`, and no `title`: a badge that
needs explaining sits in `Tooltip` (below). A chip that has to be pressed is a
`Button`.

### `Tooltip` — a label that explains itself on hover

`<Tooltip text="…">{label}</Tooltip>` gives a short label, such as a table
badge, its explanation twice from one string: as `sr-only` text inside the
trigger, which a screen reader reads once, and in a panel a mouse user sees on
hover, which no screen reader reads. The RSVP table's badges in `cire/host` are
its caller. It takes no `class`; the label's look stays on the caller's own
element inside it.

What a screen reader gets — the words once, as written. Taking any one of
these out turns a browser test red:

- **The panel is `aria-hidden`.** Kobalte gives it `role="tooltip"`; hidden, it
  leaves the tree.
- **The trigger carries no `aria-describedby`.** Kobalte's trigger points it at
  the open panel, and Chrome exposes a node referenced that way as the
  trigger's description even when the node is `aria-hidden`. Kobalte sets the
  attribute before the caller's props, and Solid's `mergeProps` skips
  `undefined`, so a call site cannot clear it. The trigger renders through a
  `TriggerSpan` that drops it.
- **The hidden copy is `normal-case`**, so a trigger inside an `uppercase` run,
  such as a `Th`, does not reach a screen reader in capitals.

What a mouse, a keyboard and a touch screen get:

- **The trigger is a `<span>`, not Kobalte's default `<button>`.** A badge in
  every table row would otherwise add a tab stop to every row. So the panel
  opens on hover only: a span takes no focus and Kobalte ignores touch.
  Keyboard and touch users see the label alone. Use it where the explanation is
  a convenience; one a reader needs belongs in visible text ([[frontend-patterns]]
  §Chrome exposes a `title` as a description).
- **The trigger is `inline-block`**, so the panel is placed against the whole
  label. An inline span's box is its last line box only, and a badge that wraps
  to two lines would have its first line covered.
- **The panel** is `PopoverContent`'s raised surface at `text-ui-xs`, at most
  `max-w-ui-xs` wide, 4px above the trigger (Popper flips it below when there is
  no room).
- **Its timing is its own, not Kobalte's defaults.** A panel opens 400ms after
  the pointer arrives and goes the moment it leaves, with no exit animation.
  Kobalte's safe area keeps it while the pointer crosses the 4px gap onto it,
  so the panel can still be hovered (WCAG 2.1 SC 1.4.13). A label the pointer
  reaches within 300ms of a panel closing opens at once, and that panel does
  not animate: it carries `data-instant`, which the entry class excludes. A
  panel opened after the delay grows from the label with a fade and the shared
  entry scale (§Motion in [[design-tokens]]), and a reader who asked for
  reduced motion sees none.
- **The instant open is measured.** Kobalte opens a panel at once inside its
  skip window but marks nothing on it, and its warm-up state is shared by
  every Kobalte tooltip on the page, cire's sidebar ones included. So `Tooltip`
  times the open: one that lands sooner than half the delay after the pointer
  arrived is instant. The root is controlled, so the panel mounts once with
  the attribute already on it.

It is not for a trigger inside a `Modal`. The panel portals to `<body>`, and a
modal `<dialog>` paints over everything outside the top layer (§What has to sit
above a modal, below).

Each label gets its own Kobalte root. A closed one does no positioning: Popper
starts `autoUpdate` only once the panel mounts. Showing every row of a 900-row
RSVP list again, about 120 of them badged, costs 4 to 12 ms more with each
badge inside `Tooltip` than with the same badges bare.

*Measured 2026-10-20 — a one-off script over the fixture
`cire/host/tests/components/RsvpView.layout.browser.test.tsx` held that day:
three events of 300 guests, all drawn at once, 900 rows. A search that matches
no row, then a timed `search("")` and forced layout, 12 times, median taken;
three runs with each badge inside `Tooltip` (76–82 ms) and three with the same
badges bare (70–72 ms)*

Two test files hold the guarantees, in real Chrome.
`cire/host/tests/components/RsvpView.badges.browser.test.tsx` holds them where
the component is used: hovering each badge shows its explanation in view, on
top, clear of the badge, on an opaque ground that clears 4.5:1, in light and
dark; no badge is a tab stop; and each explanation reaches the accessibility
tree once and never as a description, with the panel closed and open.
`shared/ui/tests/tooltip.browser.test.tsx` holds the two a caller's page can
hide: the hidden copy as written inside an `uppercase` run, and no animation
for a reader who asked for reduced motion.
`shared/ui/tests/tooltip-timing.browser.test.tsx` holds the timing above with
Playwright's real pointer, and `overlay-motion.browser.test.tsx` its motion
beside the other overlays'.

### `Orb` — a wait you can see, and a still frame for reduced motion

`Orb` draws one of the nine animations of
[thinking-orbs](https://libraries.dev/orbs) into a canvas: a dotted sphere,
in the text colour it inherits, that moves while something is in progress.
It is decoration. The
canvas is `aria-hidden` with no role, no name and no tab stop, so it belongs
inside a control whose own label says what is happening.

```tsx
import { Orb } from "@shared/ui/ui/orb";

<Orb size={20} state="working" />
```

| Prop | Values | Default |
|---|---|---|
| `size` | `20` or `64`, required: two designs upstream tuned by hand, each with its own dot count, dot size and speed | — |
| `state` | `working`, `searching`, `solving`, `listening`, `connecting`, `weaving`, `composing`, `breathing`, `shaping` | `working` |
| `class` | composed after the defaults | — |

Nothing else is a prop: no speed, pause, colour or rest spread, since a
spread could undo `aria-hidden`. The canvas is `base:inline-block
base:align-middle base:shrink-0`, so the 20px orb sits in a line of text, or
beside a label in a flex row, without breaking it.

**The engine is vendored, not a dependency.** `shared/ui/vendor/thinking-orbs/`
holds upstream's `src/engine/` and `presets.ts` verbatim, its MIT `LICENSE`,
a `README.md` with the pinned commit, and a `types.ts` of ours holding the two
aliases the engine imports (upstream's own file imports React). It sits outside
`src/` so the Tailwind scan `tokens.css` points at `shared/ui/src` does not read
it. `oxlintrc.json` and `.oxfmtrc.json` ignore it, `scripts/verify-vendored.sh`
checks it in CI, and the tree's README has the re-vendor recipe and a command
that checks the files against upstream. The rules for vendored trees are in
[[agent-tooling#Vendored trees]].

**Its export carries a types-only module.** The engine declares a parameter it
never reads, which fails the type check of every consumer that sets
`noUnusedParameters` (`tools/lab`, `musubi/social`, `pulse/web`,
`tools/metrics`). So `package.json` gives `./ui/orb` two conditions: `types`
points at `src/ui/orb-api.ts`, which a consumer's TypeScript reads and stops at,
and `default` at `src/ui/orb.tsx`, which only the bundler follows into the
engine. `orb-api.ts` is a `.ts` and not a `.d.ts` because `skipLibCheck` would
leave a declaration file unchecked. `orb.tsx` declares its `Orb` as the type
`orb-api.ts` declares, so the package's own check fails if the two disagree.
**Nothing under `src/` imports `orb.tsx` by a relative path** (the package's
own tests may): a consumer's type check would follow that import into the
engine and fail. `Button` imports it through the export instead, dynamically,
so the orb is a chunk of its own that only a page holding a `Button` that
passes a `busy` prop fetches ([[#The orb chunk]]).

**One loop draws every orb.** While at least one orb is mounted, the module
holds one `requestAnimationFrame` loop, one `IntersectionObserver`, one
`ResizeObserver`, one `MutationObserver` on the root element, one
`visibilitychange` listener and the media queries for reduced motion, colour
scheme, forced colours and resolution; they go when the last orb unmounts.
Each frame paints every moving orb from the frame's timestamp, so two orbs of
one state and size stay in phase, and builds each state-and-size frame once
however many orbs draw it. The loop asks for no frame while no orb is moving
on screen, the tab is hidden or motion is reduced. Each orb paints once at
mount and on any prop change, so an orb off screen still shows a frame. Each
paint clears the canvas first.

**It moves for five seconds at most**, then holds one still frame, at the
time upstream's own component uses. Moving content that starts by itself and
runs past five seconds beside other content needs a way to pause it (WCAG
2.2.2); an orb that stops at five needs none, whatever else the page lets the
reader do. The five seconds run from the orb's first moving frame on screen.
**Reduced motion** draws the same still frame from the start, and follows a
change of the preference in either direction. Chromium sends no `change`
event when `matches` is read between the preference changing and the event,
and the loop reads it every frame, so the loop also checks for itself.

**The bitmap** is the box the canvas takes times the device pixel ratio,
capped at 2. The box is `base:size-5` or `base:size-16`, so it follows the
root font size; the `ResizeObserver` measures it after layout, so no orb forces
one, and until it has, the nominal size stands in. A change of ratio (a zoom,
a move to another screen) refits every orb. Callers do not resize the box: the
drawing is tuned for 20 and 64.

**The ink is the colour the canvas inherits** (`currentColor`), read from its
computed style and resolved to sRGB by painting it into a one-pixel canvas, so
an `oklch()` token or a forced-colours system colour reads as the browser
draws it. The near dots take the colour; the far ones fade toward white, or
toward black when the colour's luminance is above 0.179, the point where it
has as much contrast with black as with white, which marks it as ink for a
dark ground. So the orb reads on whatever ground its text is set for: `text-foreground`
on the page, `text-ui-on-accent` in a filled button, `CanvasText` under forced
colours. A moving orb re-reads the colour every frame; a still one when its
props change, when the root element's `class`, `style` or `data-theme`
changes, and when the colour-scheme or forced-colours preference changes. A
still orb whose ancestor below the root changes colour keeps its ink until one
of those.

`cire/invites`, `cire/landing`, `cire/vendor` and `cire/host` leave `orb.tsx`
out of their Tailwind scan (`@source not`), since none draws it. A page there
that starts drawing `Orb` needs its line gone, or the orb renders unsized.

`shared/ui/tests/orb.browser.test.tsx` holds the guarantees in real Chrome,
read back from the canvas's pixels: the still frame under reduced motion, and a
change of preference both ways; motion otherwise, and the still frame with no
frame requested once an orb has moved for five seconds; no painting off screen
or in a hidden tab; two orbs in phase, and orbs of different states drawing
their own frames at once; one frame request per frame for three orbs; no frame
left after the last unmounts, and the shared listeners kept while one of two
stays; the backing store capped at 2×, taken from the measured box, and refit
when the size changes; a line of text left unbroken; ink in the inherited
colour, a light colour mirrored, a coloured one tinting the dots, and a still
orb following a colour change on the root; nine distinct still frames; a clear
before each paint; nothing in the accessibility tree. It also
writes the nine still frames at both sizes on a light and a dark ground to
`e2e-artifacts/shared-ui-orb/`. The lab story is `shared/ui/Orb`
([[component-lab]]).

### Button — a link inside a sentence, and a wait

`Button` is a CVA component ([[#Variant components (Button, Badge)]]): seven
variants, five sizes, `busy`, and the focus every one of them draws.
`buttonVariants` carries every class but `busy`'s, so a link styled as a
button looks the same.

#### Sizes

`default`, `sm`, `lg` and `icon` draw a box: one centred row, glyph and label,
weight 500, no wrapping, at the control type step (`text-ui-base`; `sm` takes
`text-ui-sm` instead). That box group, and the type step, live in each of the
four sizes rather than in the base string, because `inline` must draw none,
and two `base:` utilities for one property tie: the winner would be whichever
Tailwind emits last. `link` takes `underline-offset-4` through a compound
variant on those four sizes for the same reason. Every existing (variant, size)
pair carries the class set it carried before `inline` existed, less one class:
`sm` no longer carries the base string's `text-ui-base`, which its own
`text-ui-sm` overrode. `shared/ui/tests/ui/button-classes.test.ts` holds the
class sets, and the snapshot in `button-default.browser.test.tsx` holds what
they compute to, `sm`'s 13px included.

#### `size="inline"`

A `link` standing alone underlines on hover. A link set inside a sentence
underlines at rest, since its colour alone would not tell it from the words
around it (WCAG 1.4.1), and that is `variant="link" size="inline"`:

```tsx
<p>
  By continuing you accept the{" "}
  <Button variant="link" size="inline" onClick={openTerms}>terms</Button>.
</p>
<p>
  Use a <A href="/recovery" class={buttonVariants({ variant: "link", size: "inline" })}>recovery code</A>.
</p>
```

It draws no box: `display: inline`, no height or padding, underlined with a
2px offset, start-aligned. Size, line height and **weight come from the
sentence**, not from `Button`: a link in a 400 sentence is 400, marked by its
colour and its underline, and adds no height to the line. An `<a>` wearing the
classes wraps with the text, and its focus ring closes round each line it spans
(`box-decoration-clone`). The ring is the base `--ui-focus` ring at
`--ui-radius-control`, flush with the glyphs, and the contrast-theme outline is
the one every size draws ([[#Focus]]).

**A `<button>` stays one box**, as HTML lays out every button, even at
`display: inline`: its words never break with the sentence, and at a phone's
width a label too long for what is left of the line drops whole to the next.
So keep an inline `Button`'s label to a word or two, and give a way to another
screen an `<a href>` wearing `buttonVariants`. `@shared/ui` takes the
`<button>` where `@cire/ui` does not (its `proseLinkClass` is for an `<a href>`
only, and an action that goes nowhere stays a button outside the sentence),
because Musubi writes such actions into a sentence: "No account yet? Create
one" on `/authorize` switches the panel to sign-up, has no address of its own,
and is one of the links inside a sentence `musubi/social/DESIGN.md` names.
`shared/ui/tests/button-inline.browser.test.tsx` holds each of these in Chrome.

#### `busy`

```tsx
<Button type="submit" busy={pending()} disabled={!pending() && !valid()}>
  {pending() ? "Creating…" : "Create profile"}
</Button>
```

While `busy` is true the button:

- keeps keyboard focus — it is not `disabled`, which drops focus to the page;
- is announced as busy and unavailable: `aria-busy="true"` and
  `aria-disabled="true"` (the caller's own `aria-busy` and `aria-disabled` pass
  through when it is not busy);
- refuses activation by any route that reaches its own click handler:
  `Button` always attaches one and, while busy, cancels the click and calls no
  `onClick`. A key press on a focused button and a form's implicit submission
  (Enter in a text field) both reach it as a click, so a `type="submit"`
  button with no `onClick` submits nothing either. A native `on:click`
  listener, another submit button and `form.requestSubmit()` are not refused,
  as `disabled` does not refuse them either, so work that must not run twice
  stays idempotent on the server;
- dims as a disabled button does: `opacity-50`, and `pointer-events-none`, so a
  pointer passes through to what is behind it. **Except while focused from the
  keyboard**: the focus ring is a box shadow, which the button's opacity fades
  with the rest, to between 1.86:1 and 2.69:1 on Musubi's and pulse's grounds.
  So a busy button with keyboard focus stays at full strength
  (`focus-visible:opacity-100`), its ring as strong as when it is not busy, and
  its orb and label still say it is busy;
- draws the 20px `Orb`, state `working`, before its label, in the button's text
  colour (§`Orb`, above). It sets no ink of its own.

*Computed 2026-11-07 — each app's `--ring` blended at 50% over its `--background` in sRGB, as the browser composites opacity, then `contrastRatio` from `@shared/color`: Musubi 2.22:1 light, 2.69:1 dark (2.60:1 on the dark `--card`); pulse 1.86:1 light, 2.18:1 dark. `button-busy.browser.test.tsx` flattens the ring the same way under the package's test stylesheet (2.36:1 at 50%) and holds it at 3:1.*

The caller owns the label: pass the words the wait wants ("Creating…"). Use
`busy` in place of `disabled={pending()}`, and keep `disabled` for the other
reasons a button cannot act; when both are true, `disabled` wins and focus
drops, as it does for any disabled button. So guard those reasons with the
busy signal (`disabled={!pending() && …}`): a reason that turns true mid-wait,
such as a verification widget dropping a spent token, then cannot take focus
away. `busy` is not accepted at `icon`
(no label for the orb to sit beside) or `inline` (no room in a line of text).
It is for plain buttons, not a Kobalte trigger: `DropdownMenu`'s trigger opens
on pointer-down and key-down, which the click refusal does not see.

#### The orb chunk

`button.tsx` imports `@shared/ui/ui/orb` dynamically, through the package's own
export, so the bundler puts the orb and its engine in a chunk of their own and
a consumer's type check stops at `orb-api.ts`. The chunk is fetched once a page
holds a `Button` that passes a `busy` prop (`busy={false}` counts): the first
such button to mount queues one fetch for idle time, or for a timer where the
browser has no `requestIdleCallback`, and a button that turns busy before then
fetches at once. A `Button` with no `busy` prop never fetches it: pulse, which
passes none, emits the chunk and never requests it. Until the module arrives a
20px `aria-hidden` box holds the orb's room, so the label does not move when it
lands. If the fetch fails the box stays and the label and ARIA still say busy;
the next button to turn busy asks for the module again, and Chromium fetches it
anew. No `lazy()` or `Suspense`: a lazy component suspends the nearest
`Suspense` above it, which in musubi is the route's, and blanks the page while
the chunk loads.

*Measured 2026-11-07 — `vite build` of a page holding one busy `Button`: the orb chunk is 16.99 kB, 7.03 kB gzip, as in musubi's build. Served by `vite preview`, the 20px box shows before the orb for 7–11 ms unthrottled, 77–79 ms at 9 Mbps / 60 ms, 193–195 ms at 1.6 Mbps / 150 ms and 539–570 ms at 400 kbps / 400 ms (Chrome network emulation, Playwright, 3 runs each), for a button busy from its first render. A button that mounts first and turns busy after idle time draws the orb at once (`button-busy-preload.browser.test.tsx`).*

#### The props union

`inline` goes with `variant="link"` only, and `busy` with `default`, `sm` and
`lg` only; anything else is a type error where `Button` is used directly.
Through Kobalte's `as={Button}` the rules do not hold: its props type `Omit`s
keys from the union, which keeps the shared keys and widens each to the union
of its types. Every member names `variant`, `size` and `busy`, so none of them
drops out there. A caller holding a variant and a size in variables narrows
them per member, as the lab's Playground, `button.browser.test.tsx` and
`button-default.browser.test.tsx` do.

#### Focus

Keyboard focus draws a 2px `--ui-focus` ring, which is a box shadow, and hides the outline only while focused (`focus-visible:outline-hidden`) rather than removing it. A Windows contrast theme (forced colours) drops box shadows and paints that hidden outline in a system colour, 2px wide and 2px off, so focus stays visible there; outside the theme it computes as no outline at all. A pointer press draws neither. `buttonVariants` carries the classes, so a link styled as a button gets the same. The drawn `Checkbox` box, the drawn radio circle and the switch track spell their contrast-theme mark another way (`forced-colors:peer-focus-visible:outline-2`, whose colour is `currentColor`): the same style, width and offset, but the theme paints the checkbox's and `Button`'s in different system colours — under Chromium's emulation on macOS, `rgb(0, 0, 0)` for the box and `rgba(5, 0, 73, 0.8)` for `Button`. `Button`'s ring and outline are fixed at 2px and do not follow `--ui-focus-width` or `--ui-focus-offset`. The defaults are `base:` and so lose to any call site: an `outline-*` class passed to `Button`, or an unlayered app rule that sets `outline` on `:focus-visible`, takes the theme's only focus mark away. `shared/ui/tests/button.browser.test.tsx` holds the contrast theme; `shared/ui/tests/button-default.browser.test.tsx` holds every computed style outside it as a snapshot; and the `token-contract` browser tests in `@musubi/social` and `@pulse/web` check the outline under each app's own stylesheet. See [[browser-tests#Current coverage]].

*Measured 2026-11-06 — a probe in `shared/ui`'s browser tier on macOS: under `emulateMedia({ forcedColors: "active" })`, Tab to a drawn `Checkbox` and to a `Button` and read `getComputedStyle(el).outlineColor` on the box and on the button*

### `DropdownMenu` — two looks, and rows that are checked, chosen or followed

`DropdownMenuContent` takes `variant`, set once on the panel and read by every
row, label and separator inside it, so one menu cannot mix two looks:

- **`default`** — the shared look musubi's account menu, pulse's header and
  explore menus, and the lab draw. Its classes are frozen:
  `shared/ui/tests/dropdown-menu-default.browser.test.tsx` reads them back as
  literal strings and checks what they paint, and imports only what the menu
  exported before the accent variant, so it runs on either side of a change.
  The panel grows from its trigger and shrinks a little as it closes, on the
  shared motion tokens (§Motion in [[design-tokens]]).
  A focused row is marked by its sunk fill and a `pill` trigger by its ring,
  both of which a contrast theme (forced colours) drops, so each hides its
  outline only while focused and the theme paints it there. A hidden outline
  at rest would ring every row in that theme.
- **`accent`** — cire's portal menus: the raised surface at the `md` corner
  with `--elev-2` (an app's own, else `--ui-elev-2`), 6px of padding; rows at
  the small type step in full ink, `px-3 py-2` at the `sm` corner; a
  highlighted row a 10% accent wash with the readable accent ink; a 2px focus
  ring inset by 2px for the keyboard, because Kobalte scrolls a row flush to
  the edge of a scrolling panel and the panel would clip a ring drawn outside
  it. The panel pops from its trigger's side — the shared `--ui-scale-enter`
  and a fade on the app's `--dur-fast` and `--ease-out`, under `motion-safe:`
  — and has no exit:
  a menu held mounted for an exit animation keeps focus inside it, and focus
  then falls to `<body>` instead of going back to the trigger. The colour fade
  names its properties, so the ring never fades in.

The rows:

- `DropdownMenuItem` — one choice. With `as="a"` it is a real anchor taking
  `href`, `target`, `rel` and `download`. It keeps only an address a menu may
  lead to — a web page, a path or fragment on the site, `mailto:` or `tel:` —
  and drops any other (`javascript:`, `data:`), whatever its caller checked.
  Opening another tab or window (any `target` but `_self`, `_parent`, `_top`),
  it adds `noopener noreferrer` to the caller's `rel` and drops an `opener`.
  The browser follows the link, never script:
  the menu stays open through Kobalte's select and closes a task after the
  link's own click, because an anchor taken out of the document during its
  click goes nowhere, and a tap's click can arrive after Kobalte's own
  close-on-select would have removed it. Space clicks it, as Enter does.
  Disabled, it keeps no `href`.
- `DropdownMenuCheckboxItem` — on or off (`checked`, `onChange`), open after
  choosing unless `closeOnSelect`. `indicator="check"` (the default) shows a
  trailing check while on; `indicator="switch"` draws `Switch`'s own track and
  thumb (`switch-classes.ts`), hidden from assistive technology — the row
  carries `menuitemcheckbox` and `aria-checked`.
- `DropdownMenuRadioGroup` (`value`, `onChange`) and `DropdownMenuRadioItem`
  (`value`) — one of several; the chosen row shows the trailing check, so the
  choice never rests on colour alone.
- `DropdownMenuLabel` — `heading`, `identity`, or `eyebrow`: small caps at the
  widest tracking in the secondary ink, for a group label. In a menu the
  accent marks state — the highlighted row, the check, a switch that is on —
  so a label that cannot be chosen does not wear it.

The trailing check and the switch take the readable accent ink and the accent.

**Where cire draws it.** Every portal menu is the accent look: host's account
menu, wedding switcher, a guest's seat menu (radio rows, each table's count in
the secondary ink), the narrow household list's one menu (§One popup for a
list) and the invite builder's phone menu; the vendor portal's account menu,
its account row a link row. A trigger with a look of its own — an avatar, a
wedding's name, a seat's "Seat", the builder's place pill — is a plain button
the trigger renders as (`as`), as it would a `Button`: `shadcn/no-restyle`
lets a `DropdownMenuTrigger` take layout classes only. The guest site's
`LinkMenu` draws no Kobalte menu and takes `MENU_TOUCH` (below).

**Inside a `Modal`** the panel portals into the open dialog and carries
`data-kb-top-layer` (`portal-mount.ts`, shared with `PopoverContent`), so a
click on a row lands. With no modal open it portals to `<body>` with no such
mark: Kobalte reads the mark outside modals too, and a press inside a marked
panel never counts as outside another open layer. In a dialog the panel is
clipped by the dialog's own scroll box and by a `frame` modal, as a popover is
(englishstreetventures/osn#1089).

**`menu-classes.ts`** holds every class the menu renders. **`menu-touch-classes.ts`**
holds `MENU_TOUCH`, the rows of a menu drawn without Kobalte: the guest site's
link menu, which paints in the top layer inside the guest sheet and cannot
afford Kobalte's menu. Its panel is `min-w-56`, `p-2` with a 4px gap, on
`shadow-lg`; its rows are 44px, a guest's touch floor, in the secondary ink,
filled with the accent under the pointer, for the keyboard (`focus-visible`)
and while pressed — never on focus alone, since a tap focuses the link it
lands on and a filled row then reads as chosen. Its outline is hidden, not
removed, so a contrast theme, which drops the fill, paints the outline
instead. Neither file imports
anything, and they are two files so a stylesheet can leave out the menu it
does not draw: `cire/invites` excludes `dropdown-menu.tsx` and
`menu-classes.ts` with `@source not`, and `cire/landing` all three. A page
there that starts drawing a menu needs its line gone, or the menu renders
unstyled.

`shared/ui/tests/dropdown-menu.browser.test.tsx` holds the rows' keys and
pointer, the link rules, the modal mount, the accent look's focus ring,
motion and its contrast on cire's two ramps, the touch row and the handle.

### Table and its pinned cells

`Table` is the table's frame, `Th` a column head, `Td` a cell. It has two
scroll modes.

- **`scroll="box"`, the default** — the box scrolls sideways so a wide table
  never takes the page with it, and it is a named, focusable region so its far
  columns are reachable from the keyboard. `label` is required.
- **`scroll="page"`** — the box clips sideways (`overflow-x: clip`), so the page
  stays the scroller and a pinned head row sticks to the page under the call
  site's offset. No tab stop and no region: the call site names the `<table>`
  by its caption or `aria-label` / `aria-labelledby`, and must never draw it
  narrower than its columns, since a clipped column is gone. Cire's RSVP and
  household tables use it under the host portal's stuck stack
  (`cire/host/DESIGN.md` §The stuck stack). A union type: `label` belongs to
  box mode only.

`frame="none"` drops the box's border and radius, for a table inside something
that already draws its edge. `Th srOnly` keeps a head in the table for
assistive technology — its words hidden, in sentence case, its row given no
height — for a table whose visible heads are a copy held elsewhere.

A sticky cell sticks to the nearest box that scrolls ([[frontend-patterns]]
§`position: sticky` resolves its offsets against the scrollport). In page mode
that is the document: pin the head row and give it the offset of whatever is
stuck above it.

```tsx
<Table scroll="page" class="[&>table]:table-fixed">
  <caption class="sr-only">RSVPs for Reception</caption>
  <thead>
    <tr>
      <Th pin="top" class="top-[calc(var(--chrome-h)+var(--bar-h,0px))]">Guest</Th>
      <Th pin="top" class="top-[calc(var(--chrome-h)+var(--bar-h,0px))]">Status</Th>
    </tr>
  </thead>
  <tbody>…</tbody>
</Table>
```

In box mode, for a long table whose head row and first column must stay on
screen, the call site gives the box a height to scroll within and pins the
cells:

```tsx
<Table
  label="Replies"
  class="relative isolate max-h-[calc(100svh-<top bar and a margin>)] scroll-pt-<head row> scroll-ps-<pinned column> overflow-y-auto"
>
  <thead>
    <tr>
      <Th pin="top-start">Guest</Th>
      <Th pin="top">Status</Th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <Td pin="start">Ada Sharma</Td>
      <Td>Attending</Td>
    </tr>
  </tbody>
</Table>
```

| `pin` | On | Holds the cell | Layer |
|---|---|---|---|
| `top` | `Th` | at the top of the box | 2 |
| `top-start` | `Th` | at the corner: top and start edge | 3 |
| `start` | `Td` | at the start edge | 1 |

A pinned cell paints `--ui-ground`, so the rows passing under it never show
through. That is only invisible on a table set straight on the page ground; on
a tinted card it reads as a band. The start column and the corner carry a
full-strength hairline on their end edge, which says where the held column
stops once the others slide beneath it; the row rules stay at 40%. On the box,
`isolate` keeps the layers inside it; `relative` makes it the containing block
for any `sr-only` text in its cells ([[frontend-patterns]] §`sr-only` is
`position: absolute`); and scroll padding a little larger than the head row and
the pinned column keeps a focused control clear of the pinned cells. Pin a
column only where the box can scroll sideways: each pinned cell costs every
scrolled frame.

`pin` is a variant because `shadcn/no-restyle` refuses a cell's colour and
border from a call site (§What a call site may set, below). The position
classes alone would leave a transparent cell the rows show through.
`shared/ui/tests/data.browser.test.tsx` holds it in real Chrome: the head row
at the top and the first column at the start of a box scrolled both ways, each
painted over what passes beneath, opaque over white and over black alike, with
the full hairline at its end edge, and a plain cell left transparent and in
flow; and in page mode, the head row held to the page at the call site's
offset rather than at 0, with no tab stop and no region. Its users are cire's
RSVP table ([[cire-rsvp-table]]) and household tables, in page mode.

## Importing

Each layer has its own specifier shape, and they do not agree on default versus
named. `@shared/ui` exports a **named** binding per component. `@osn/auth-ui`
exports a barrel _and_ a subpath per view. `@cire/ui` is mixed: its seventeen
components — `button`, `card`, `dietary-presets`, `dietary-presets-popover`,
`disclosure`, `eyebrow`, `file-input`, `loading`, `message-thread`, `note`, `person-avatar`, `reveal`, `segmented-tabs`, `sign-in-panel`, `skeleton`, `skeleton-outline`, `wordmark` — are **default** exports, while `username-input`, `sign-in-card-class`, `sign-in-press` and `avatar-trigger-class` are named,
`card` carries named `cardClass` / `cardBoxClass` / `CardCta` / `CardCtaButton` beside its
default, `message-thread` the `MessageThreadItem` and `MessageThreadReply` types, `eyebrow` a named `eyebrowClass`, `lib/glass` a named `GLASS_FILL`,
`sign-in-panel` the `SignInAuth` type, `skeleton` the `SkeletonStandIn` type, `skeleton-outline` the `SkeletonOutlineProps` type, `sign-in-press` `createSignInPress` and `SIGN_IN_PENDING_RESET_MS`, and
`wordmark` a named `WordmarkPlaceholder`. `sign-in-card.astro`, `site-footer.astro` and `legal-layout.astro` are Astro components, imported by default. So a named `Button` import from `@cire/ui/button` resolves to nothing:

```typescript
import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { clsx } from "@shared/ui/lib/utils"; // conditional class joining

import { SignIn } from "@osn/auth-ui/SignIn"; // or: import { SignIn } from "@osn/auth-ui";

import CireButton from "@cire/ui/button";
```

## Dependency stack

| Package                    | Role                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `@kobalte/core`            | Headless UI primitives (Dialog, Popover, Tooltip, Tabs, DropdownMenu)                       |
| `class-variance-authority` | Type-safe variant definitions for Button, Badge                                             |
| `clsx`                     | Conditional class string joining                                                            |

These are dependencies of `@shared/ui`. Consuming apps get them transitively — no extra installs needed.

The orb's drawing engine is not a dependency: it is upstream source vendored into
`shared/ui/vendor/thinking-orbs/`, with no entry in `package.json` or
`bun.lock` (§`Orb` above).

> [!note] Kobalte is not free everywhere
> `cire/invites` and `cire/landing` carry no Kobalte at all, and importing
> `@kobalte/core/dialog` costs 15.3 KB gzip against roughly 11.7 KB of headroom
> in each. That is why `Modal` is built on the platform `<dialog>` rather than
> on Kobalte's. The measurement, its method and which of the two to reach for
> are in [[native-dialog-over-kobalte]]; the budgets are in
> `scripts/bundle-size-budgets.txt`, and the rules they obey in
> [[bundle-size-guards]].

## Class composition: the `base:` prefix and `clsx()`

Two tools handle class composition: one source convention and one function. There is no runtime class merger. A component's defaults lose to a caller's classes through the cascade, so nothing has to settle Tailwind conflicts in JavaScript.

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

Use for composing class sets, conditional classes, and signal-driven toggles:

```typescript
import { clsx } from "@shared/ui/lib/utils";

clsx("px-4 py-2", isActive && "font-bold", props.class);
```

`clsx()` keeps every class it is given. When two of them set the same property, both reach the DOM and the stylesheet decides, whatever order they were joined in. So never join two unprefixed utilities that conflict; make one the other's alternative instead (`isActive ? "bg-ui-accent" : "bg-ui-ground"`). The one conflict that has to resolve, a component default against a caller's class, is the `base:` prefix's job. What a caller may pass a shared component at all is narrower; see §What a call site may set, and what it may not, below.

**Rule**: component files use `base:` prefixed strings + `clsx()`. Consumer code uses `clsx()`. Do not add a runtime merger such as `tailwind-merge`: `base:` already settles the conflict a merger would, at no runtime cost.

## Performance guidelines

### Prefer `classList` for reactive class toggles

SolidJS's `classList` directive performs fine-grained DOM updates — it adds/removes individual classes without touching the rest of the class string. When using `clsx()` inside a `class` attribute binding, every signal change recomputes the entire class string and replaces the full `className`.

For static or low-cardinality elements (a few buttons, a card header), `clsx()` is fine. But inside `<For>` loops or any hot path that renders many items, prefer `classList`:

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
<button class={clsx("rounded-ui-md px-3 py-1.5 text-ui-sm", isActive() ? "bg-ui-accent" : "bg-ui-ground")}>
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

### One popup for a list, not one per row

Each Kobalte `Tooltip`, `Popover` or `DropdownMenu` root builds its state, ids
and positioning context when it mounts, opened or not. One per row of a long
list — a tooltip on each household's four icons, a menu on each household's
"⋯" — is hundreds of roots of which the reader can open one. Draw the rows'
controls as plain buttons and mount the popup once:

- **A menu**: one `DropdownMenu` with no `DropdownMenuTrigger`, placed with
  `getAnchorRect` against whichever button was pressed. `DropdownMenuHandle`,
  a child of the root, hands the root's menu to a `ref`, and the buttons call
  its `open("first")` from the keyboard, `open(true)` from a click, as Kobalte's
  own trigger does, so focus lands where a keyboard user expects. The handle is
  Kobalte's `useMenuContext()`, so a call site imports nothing from Kobalte.
  `DropdownMenuContent` takes `onCloseAutoFocus` to give focus back to that
  button, and an `aria-label` to name the menu. The household list's "⋯"
  (`cire/host/src/components/GuestTable.tsx`).
- **A popover**: one `Popover` with `anchorRef` set to the pressed button, and
  `PopoverContent`'s `onInteractOutside` (a second press on the open button is
  not outside) and `onCloseAutoFocus` (focus back to it). The editor's cut-short
  event heads (`GuestsEditor.tsx`).
- **A tooltip**: cire's host portal draws one panel for the page from `data-tip`
  attributes (`cire/host/src/components/ActionTip.tsx`).

A list of a few rows needs none of this.

### Bundle size: the `base:` variant instead of a runtime merger

Component files write `base:` prefixed classes directly in source strings (e.g. `"base:bg-ui-surface base:rounded-ui-lg"`) and compose with `clsx()`. The `base:` custom variant (`shared/design-tokens/src/tokens.css`) compiles to `:where()` selectors with zero specificity, so any unprefixed consumer class wins via CSS cascade. No merge step runs in the browser, and no app ships a class-merging library. A runtime merger would add weight to every app that called it, to settle a conflict `base:` already settles.

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

Every size, the link inside a sentence, the `busy` wait and keyboard focus
are in [[#Button — a link inside a sentence, and a wait]].

### Kobalte components (Dialog, Popover, Tooltip, Tabs)

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
- **DropdownMenu** — portaled, roving focus by arrow keys, typeahead; §`DropdownMenu` above for its looks and rows
- **Tabs** — `role="tablist"` / `role="tab"` / `role="tabpanel"`, keyboard arrow navigation
- **Tooltip** — hover only, panel hidden from assistive technology; §`Tooltip` above says why
- **Switch** — not Kobalte: a native `<input type="checkbox" role="switch">`, visually hidden inside its label beside a painted track, so Space toggles it and it is announced as a switch. The element carries everything a switch needs, and it renders on the organiser portal, whose bundle budget had no room for Kobalte's form-control layer (~0.9 KB gzip there). Controlled: it shows `checked` and nothing else. Use it where flipping it *is* the action, and a `Checkbox` for a choice saved later with a form. `readOnly` is for someone who may read the setting but not change it — it stays in the tab order, announced as read-only, at full contrast — and `busy` holds it read-only and announced as busy while a change saves, so it keeps focus. `disabled` removes it from the tab order; prefer `readOnly` whenever the state is worth reading

### Checkbox and RadioGroup — native, in two boxes

`Checkbox`, `RadioGroup` and `RadioGroupItem` are native `<input>`s inside their `<label>`, like `Switch`, with nothing from Kobalte: Space ticks a box, the arrow keys move between radios of one `name`, a click anywhere on the label ticks or chooses, and `aria-label`, `aria-labelledby`, `aria-describedby`, `aria-invalid`, `disabled`, `name`, `value`, `id` and `required` land on the input itself. Both are controlled, as `Switch` is: the element is put back to the value it was given and `onChange` asks for the new one, so a change the caller refuses never shows as made. A `RadioGroup`'s `value` is required (`""` for none chosen yet); its `name` defaults to a fresh id, since native radios only exclude each other within one name.

| Prop | Values | What it does |
|---|---|---|
| `box` | `drawn` (default), `native` | `drawn` hides the input and paints a 16px box beside it: small corner, ground fill, accent and a tick (a dot for a radio) when chosen, `ring-2` from the input's `:focus-visible`. Pulse draws this. `native` shows the browser's own input: ticked, the platform's blue and tick; unticked, no fill, a 1px `--ui-hairline-strong` edge, a 2px corner (a radio round), `--ui-ink-secondary` under the pointer, 40% when disabled, only the edge fading. Both states 13px, so ticking moves nothing; the house focus outline (2px, 2px off, `--ui-focus`). Cire draws every box this way |
| `size` | `md` (default), `sm` | The label's step: `text-ui-base` or `text-ui-sm`. On `RadioGroup` for every item |
| `align` | `center` (default), `start` | `start` centres the box on the label's first line, for a label that wraps. A drawn label sets leading 1 beside a centred box, pulse's look, and prose leading at `start`, so its second line reads and its first line holds the 16px box |
| `orientation` (`RadioGroup`) | `horizontal` (default), `vertical` | Native: 16px between radios in a row, 8px in a column. Drawn: 8px either way. Layout only, so no `aria-orientation` |
| `label` | JSX | Inside the `<label>`, so a link or a second line is the caller's. Native labels are body ink (`--ui-ink`) at prose leading, 8px from the box |
| `description` (`Checkbox`) | JSX | Inside the label under the words, `text-ui-sm` secondary ink. The box is then named by `label` alone (`aria-labelledby`) and described by this |
| `note` (`Checkbox`) | JSX | Under the row, outside the label, indented by the box and its gap so its first word sits under the label's. A click on it ticks nothing; the box is described by it. A note that resolves to nothing draws nothing and is not referenced |

The outer element of a `Checkbox` is a `<div>` holding the label and the note, each at its own width, so a note that comes and goes never remounts the input, and only the box and its words answer a click. A cire app also draws every bare native box with the same values in a base-layer rule (`cire/host/DESIGN.md` §4, Checkboxes and radios), for the native inputs that sit outside the parts.

Two guarantees hold beyond a plain client render, for `Switch` too. A page the browser restores (a reload, a back navigation the cache missed) can tick an input before it hydrates, and hydration writes no property, so each part puts the caller's value back once mounted: a box never shows a state the caller does not hold, which matters most for a consent box. And a Windows contrast theme drops `box-shadow` and repaints backgrounds, so the drawn box, circle and switch track draw keyboard focus as an outline there, and the chosen dot and the switch's thumb keep the text colour. `tests/choice-restore.browser.test.tsx` holds both.

The drawn box keeps the DOM shape Kobalte's parts had — a clipped input, then the painted box — so pulse's forms read it unchanged. The vendor portal's listing editor draws the native box (`box="native"`), and its soft-shapes test reads the 13px box with a 2px corner. `tests/checkbox.browser.test.tsx` and `tests/radio-group.browser.test.tsx` hold both boxes in Chromium.

### Simple styled components (Input, Label, Card, Textarea, Select)

Thin wrappers that apply consistent base styling and accept a `class` prop for overrides. `Input`, `Textarea` and `Select` share one box, defined once in `shared/ui/src/ui/control.ts`, so a date and a currency line up in a column:

| Prop | Values | What it does |
|---|---|---|
| `size` | `md` (default, 36px), `sm` (28px), `form` and `form-compact` (34px), `touch` | `md` is a form, `sm` a table row or a filter bar. `form` (12px sides, the base type step) and `form-compact` (8px sides, the small step) are cire's portal fields. `touch` is a guest's field: 46px with 16px type below 640px, 44px from there, so iOS never zooms and the tap target never drops under 44px. Heights are rem, so on the guest site's 17px desktop root a touch field is 46.75px. `Input` and `Select` take a fixed height at every size, so no field's height comes from the platform's font; `Textarea` takes the size's sides and type and grows with its rows |
| `fill` | `ground` (default), `ink` | `ink` draws the edge and fill from the text colour at 55% and 4.5%, for a field on a surface the page does not choose (a guest site's section in the couple's colour): focus turns the edge to the accent and draws the 2px `--ui-focus` outline 2px off, with no ring offset to paint a halo; 16px type below 640px; normal letter-spacing, whatever the label above sets. The placeholder is the secondary ink taken 15% toward the text colour, because the well alone takes the secondary ink under 4.5:1 on a light palette such as garden's |
| `face` (`Input`) | `text` (default), `code`, `claim`, `amount` | `code`: mono with wide tracking, for an identifier. `claim`: an invitation's code, centred capitals at `tracking-ui-wider`, 1rem at every width, 16px sides, with the browser's spelling help off and a phone's keyboard in capitals. `amount`: centred |

`controlClass` picks one padding, one type size and at most one letter-spacing for each size, face and fill, because two zero-specificity `base:` classes on one property are decided by the stylesheet's order. With no fill, every string it returns for `sm` and `md` is the one it returned before the fills existed, and `tests/ui/control.test.tsx` pins them with the rendered classes of `Input` and `Textarea`.

`Select` draws its own chevron: the browser's arrow is off (`appearance: none`) and a 10×6 chevron in the secondary ink sits 12px in from the right on the wide boxes and 10px on the narrow ones, with right padding that keeps a long value clear of it; the select has no top or bottom padding, so the engine centres the value. The select and the chevron share the one cell of a grid, so the caller's `class` (with `classList`, `style` and `hidden`) lands on that box: it places, sizes and shows the field — `w-40`, `w-auto`, `h-8.5` — and cannot restyle it. Every other prop goes on the `<select>`. `tests/control.browser.test.tsx` measures the heights under a 2em line, the touch switch, the ink edge at 3:1 over three guest palettes, the chevron's inset and a content-sized select in a squeezed row.

A file picker in cire is `@cire/ui`'s `FileInput`, whose button is cire's `quiet` pill; `Input type="file"` keeps `@shared/ui`'s plain `file:` base for the other apps.

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
| **Entry** | `@starting-style`, pure CSS | The browser takes the from-state when the element is first rendered, or shown again after `display: none`, as a closed modal is. No JavaScript at all. Safari has had it since 17.5; older engines show the dialog immediately, which degrades rather than breaks. |
| **Exit**  | JavaScript defers `close()` | `close()` drops a dialog out of the top layer _immediately_, so an exit transition has nothing left to paint.                                                                                          |

**A CSS-only exit from the top layer does not work cross-browser, and this is
the thing to know before reaching for it.** The platform's own answer is the
`overlay` property with `transition-behavior: allow-discrete`, which defers that
removal so the transition can run. `overlay` is **Chrome and Edge only** —
unsupported in Safari and Firefox. On cire's guest site, where most traffic is
mobile Safari, a CSS-only exit means the dialog blinking away for nearly
everyone who sees it. The limit is `overlay`, not `allow-discrete`: a box that
is not in the top layer fades out of `display: none` in CSS alone in every
current engine — [[frontend-patterns#Motion follows the input]].

So `Modal` sets `data-closing`, lets its own stylesheet run the exit, and calls
`close()` once the element's animations have finished. It waits on
`getAnimations({ subtree: true })` rather than a named transition, so an app
animating the panel with Motion One or the Web Animations API is waited out the
same way — the hook is animation-library-agnostic without naming a library.
It leaves out endless animations: a loading spinner inside the dialog loops
until whatever it waits on arrives, its `finished` never settles, and waiting
on it would hold the dialog invisible but still modal, with the page behind it
inert.

Timing is two custom properties, so an app retimes rather than restyles:

```css
:root {
  --ui-modal-enter: 350ms;
  --ui-modal-exit: 150ms;
}
```

Unset, the entry fades in over 250ms and rises `--ui-distance-enter` (24px)
from a 0.98 scale over 350ms; the exit sinks the shorter `--ui-distance-exit`
(8px) to `--ui-scale-exit` (0.98) in 150ms, and the backdrop fades out with it
rather than vanishing when `close()` runs. Cire sets both durations on a desk
only, from its own ladder (`cire/host/DESIGN.md` §Motion); on touch it runs
these. The motion tokens are in [[design-tokens]] §Motion.

`prefers-reduced-motion` drops every one of them to 1ms rather than `none`:
the exit is _awaited_, and a transition that never started is one there is
nothing to wait for.

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

Three details worth carrying.

`frame` sets `p-0` rather than merely omitting the padding. **The user-agent
stylesheet gives every `<dialog>` `padding: 1em`**, so a component that writes
no padding rule ships a 16px band its caller cannot see in its own markup.

The column is drawn only while the dialog is open. **A closed `<dialog>` is
hidden by one user-agent rule, `dialog:not([open]) { display: none }`, and any
author `display` beats it**, so the frame's `flex` — or a caller's own `flex`
in `class` — would lay a modal kept mounted while closed out as a bordered,
shadowed strip at the top of whatever positions it. `Modal`'s injected
stylesheet puts the rule back for every `.ui-modal`, unlayered so no utility
outranks it; see [[frontend-patterns#A closed dialog with a display class is still drawn]].

And the panel **clips rather than hides**. `overflow: hidden` refuses the user a
scrollbar and grants everything else — `scrollIntoView`, and the scroll the
platform performs when focus lands on a descendant it believes sits outside the
box — so a `hidden` panel can be slid sideways with no affordance to slide back.
`overflow: clip` is not a scroll container and has no scroll offset to move.
Both axes have to say it: beside an `auto` axis, `clip` computes to `hidden`
(CSS Overflow 3 §3.1). This does not change what a popover portalled into the
open dialog can do — it is clipped by the frame either way; see englishstreetventures/osn#1089.

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

#### A dialog that only an answer closes

`Modal` closes on Escape and on a backdrop click by default, and that is right
for nearly every dialog. A dialog the user must answer — cire's first-visit
consent prompt, in
[`ConsentBanner.tsx`](../../cire/invites/src/components/consent/ConsentBanner.tsx),
is the one call site — takes four things together, because no one of them
covers every browser:

| Prop on `Modal` | What it stops |
| --- | --- |
| `dismissable={false}` | The backdrop click, which `Modal` handles itself |
| `closedby="none"` | Escape and the back gesture, in browsers that support the attribute; the request never reaches the dialog, so the back gesture goes back a page instead |
| `onCancel={(e) => e.preventDefault()}` | Escape and the back gesture where `closedby` is unsupported, by refusing the `cancel` they fire |
| `onClose` that mounts a fresh `Modal` | The case a browser will not let a page refuse: it allows a refused `cancel` only after the user has interacted, and otherwise closes the dialog regardless. Where `closedby` is unsupported, the back gesture therefore does nothing until the dialog is answered |

An unmount never fires `onClose` (the listener is removed first), so closing
the dialog by answering it cannot trigger the reopen.

**`onClose` always sets `open` back to false.** Escape and the back gesture
close the element before `onClose` runs, so a guard that returns early — "not
while saving" — leaves `open` true against a closed dialog, and the next
`open={true}` changes nothing: the dialog cannot be opened again until a
reload. A dialog that must stay up takes the four props above; work that ends
after its dialog closed reports through a toast
(`cire/host/src/components/ChecklistStarter.tsx` does both halves).

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

Both of these are live in `cire/invites`: `LinkMenu` (Add to calendar, Open in
maps) renders in place as a popover, and `@shared/toast`'s `Toaster` takes a `topLayer` flag that shows the
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

### cire's `SegmentedTabs` — one glass track, three meanings

The portals' segmented controls are one part (`cire/ui/src/segmented-tabs.tsx`,
owner's choice on englishstreetventures/osn#1845): a 28px track — a 1px hairline
on the surface at 30%, 2px inside — and 22px choices in sentence case at the
extra-small step, the secondary ink at normal weight at rest and the readable
accent ink at medium weight when chosen. The weight is the cue that is not
colour, since the glass and the inks alone read under 3:1 between the chosen
choice and the rest; a hidden copy of each word at medium weight holds its
width, so a choice moving shifts nothing, and each choice names itself with
`aria-label` so that copy is never read. The chosen one sits on glass: the raised surface at
55% under the accent at 14% (composited into one colour, so a test can read
what the label sits on), an inner lip, a light inner edge (`--glass-edge`, an
app token; white at 10% when unset), a hairline ring, the first lift and a
12px frosted backdrop. The glass slides on the house spring
(`--ease-spring`, falling back to the app's ease-out) at `--dur-base`, inside
its own layer clipped to the track's shape, so an overshoot is cut by the
track and no focus ring is. Under the pointer an unchosen choice goes halfway:
half the tint, an ink between the two. A hover's colours come and go on
`--dur-fast` with `--ease-out`; a choice being made arrives on `--dur-base`
with `--ease-in-out` (the one motion rule, host `DESIGN.md` §4; a browser takes
a transition from the state it moves to, so the choice giving the mark up runs
on the fast clock). Colours fade on named properties, so
the 2px ring at 2px never fades in; a reader who turned motion down gets no
slide and no fade. The frosted backdrop is filtered again on every frame of a
slide: a cost on low-end phones that the owner's frosted look accepts. In a
contrast theme the chosen choice keeps a 1px outline in the theme's text
colour, since the theme drops the glass.

`semantics` keeps each strip's meaning: `tabs` (a named tablist, one tab stop,
arrows, Home and End moving focus, Enter or a click choosing), `radio` (a
named radiogroup with one tab stop, the checked radio; the arrows move to the
next or previous radio, wrapping, and ask to choose it, as the ARIA radio group
does; a refused choice is never shown as made) and `current` (a named group of
buttons, the chosen one `aria-current="page"`). Items are keyed by `value`, so a
call site may rebuild them on every keystroke; `icon`, `name` (a fuller
accessible name), `describedBy`, `after` (a count, a mark) and `iconOnly` are
read as they change. `iconOnly` on the strip hides every label for assistive
technology alone and hands each to `tipAttribute`, the attribute the app's
tooltip layer reads (`data-tip` in the host portal); on an item it does the same
for that item alone, so some choices can show as their marks beside a word that
stays. `scroll` keeps the strip
on one row and scrolls it sideways inside its box, the chosen choice and one
the arrows reach kept in view without moving the page. `class` sets the
strip's place in its row only.

`GLASS_FILL` (`@cire/ui/lib/glass`) is the glass's look without its place, for
a lone glass pill that is no strip's choice: the invite builder's place on a
phone. A contrast theme drops its fill, so such a pill draws its own edge
there. The guest site and the marketing site leave `lib/glass.ts` out of their
Tailwind scan beside `segmented-tabs.tsx`, so no glass rule reaches their CSS.

Where the portals draw it: a module's views (`ModuleShell`, `tabs`, icon-only
below 36rem with `data-tip`), the Edit modes (`EditWorkspace`, `radio`), the
RSVP page's events (`RsvpView`, `tabs` with `scroll`, a count and "New" after
each word) and its reply filter (`radio` with `scroll`, each reply's dot before
its word and its count after it, the replies icon-only on a phone beside an
"All" that keeps its word), the invite builder's sections under Content (`tabs`, `scroll`) and
the vendor portal's two views (`current`). Host `DESIGN.md` §7 has the look and
§A tab strip inside a view, §The invite builder's two tiers the layouts.

`createSlidingPill` (`cire/ui/src/lib/sliding-pill.ts`) is the highlight under
it, and the module rail's marker: `ease: "out"` (the default) or `"spring"`.
`cire/ui/tests/segmented-tabs.test.tsx` holds the roles and keys,
`segmented-tabs.browser.test.tsx` where the glass lands, the 28px and 22px
heights, each label's 4.5:1 on both ramps, the ring and the scrolling strip.

### cire's `Wordmark` — the way home, and its still copy

Both portals' top bars open with the same mark (`cire/ui/src/wordmark.tsx`):
a readable-gold ✦ and "Cire" in the display face at the `md` step, wide
tracking and light weight, in a 6px box (`rounded-ui-sm`, `px-1.5 py-1.5`)
that takes the surface at 60% under the pointer — the nav-row highlight the
portal menus and the module rail draw. It is a button named by `label` alone
("Cire — all weddings", "Cire — your listings"), which its type holds to open
with "Cire — ", the word on screen, so a voice user who says "click Cire"
reaches it (WCAG 2.5.3); the star and the word are `aria-hidden`. The star stays readable gold under the pointer, so the hover
changes only the wash, and that fade names its one property on `--dur-fast`
and `--ease-out`. The focus ring is `Button`'s own, 2px at a 2px offset from
`--ui-focus`, because a library part cannot count on its app's blanket
`:focus-visible` rule. The box pulls 4px left (`-ml-1`) and never right: with
a pull on both sides the ring lands on the divider (or vendor's tabs) 8px
along the bar's `gap-2` row, and left only it clears them by 4px. It takes no
`class`, `size` or `variant`.

`WordmarkPlaceholder` is the same box and glyphs with no role, no tab stop, no
hover and `aria-hidden`, for the static bar a portal's `index.astro` paints
until the island mounts, rendered to HTML with no client directive. The two share one box string and one glyphs component, so the swap
moves nothing. `cire/ui/tests/wordmark.test.tsx` holds the name, the click, the
form, the placeholder's inertness, the readable star, the left-only pull and
the ring's classes; `wordmark.browser.test.tsx` the star and the word at
4.5:1 on the bar and on the wash in both ramps, the ring and its gap to the
divider, and the copy's glyphs landing where the button's do.

### cire's `SignInPanel` and `SignInCard` — one sign-in for both portals

The host and vendor portals sign in through the same page. `SignInCard`
(`cire/ui/src/sign-in-card.astro`, props `portal` and `apiBase`) is its body:
a 30rem measure through the portal's `page-frame`, set at the top (`py-24`) so
the header never moves while the card below it grows; an `Eyebrow` naming the
product and the portal ("Cire · Host portal", "Cire · Vendor portal"); a roman
"Sign in" in the display face, sized from the page's container
(`text-[clamp(1.9rem,5cqi,2.6rem)]`, so the page's `<body>` carries
`@container/frame`); and the card, `signInCardClass` — the opaque card at the
largest padding with its top edge lit by the app's `--inner-lip`, kept in
its own module (`sign-in-card-class.ts`) so the island ships no card code —
holding the panel as a `client:only` island. The card, the measure and the
labels are the owner's choices.

`SignInPanel` (`cire/ui/src/sign-in-panel.tsx`, props `apiBase` and an
optional `auth`) is the island: copy at the small step, one large primary
pill, "Continue with musubi", and a danger `Notice` read out as an alert when
the address carries `?auth_error=` — a line each for `sign_in_declined`,
`sign_in_failed` and `sign_in_unavailable`, the failed line for any other —
after which the marker is wiped from the address. It never leaves on its
own: it asks `resumeSession`, behind the page, whether this browser is
signed in already. Both that and the button return to `?returnTo` only when
it is a same-origin path with no `//`, no backslash and not `/login`, else to
`/`. After the press the label reads "Connecting to musubi…" at full
strength and a hidden status line says the same; a second press does
nothing; a `pageshow` from the back-forward cache, or ten seconds
(`SIGN_IN_PENDING_RESET_MS`) with the browser still on the page, puts the
button back. That press is `createSignInPress` (`sign-in-press.ts`), which
holds no markup, so any other "Continue with musubi" — the vendor's claim
page's — shares it and renders its own status line. `auth` is the four `@shared/rp-auth` calls, so a story or a test
can show every state without navigating; the portals pass nothing.

`cire/ui/tests/sign-in-panel.test.tsx` holds the flow, each marker, the
`returnTo` refusals and the pending state's three ways back;
`sign-in-card.test.ts` reads the template for the island, the labels, the
roman heading and the top-set measure; `sign-in-panel.browser.test.tsx` the
copy, the button and the notice at 4.5:1 on the opaque card in both ramps,
and a press that keeps the 284px button's box at a phone's width.

### cire's `PersonAvatar` — a face, or an account's circle

One part draws a person's photo everywhere cire shows one
(`cire/ui/src/person-avatar.tsx`): a face on a task, the portals' account
triggers and the guest site's account card. It is built on `@shared/ui`
`Avatar` and `AvatarImage`, which take layout classes only, so its frame, ring
and colours sit on its own root span. The photo is drawn only from an absolute
`https:` URL, with `referrerpolicy="no-referrer"` and `alt=""`; the whole part
is `aria-hidden`, and the caller names the person in text. A URL that fails to
load joins one set for the page: the face that failed falls back at once, and
no face that has not drawn that URL asks for it again, so vendor's placeholder
trigger and the real one agree. One that already drew it keeps it, and a new
URL gets its own try.

`fallback` picks the stand-in, by what the face is for:

- **`blank`**, a face in a stack or a list: the empty avatar, a figure in the
  page's colour cut from a disc of faint ink (`--ui-ink-tertiary`) laid over
  the page's colour, so it is opaque where faces overlap. Never initials. No
  frame.
- **`initial`**, an account's circle (it needs `name`): a hairline circle with
  no fill of its own, round the photo too, and the name's first grapheme in
  readable gold in the display face at weight 600, at half the circle's inside
  width (`50cqi`, with `@container` on the root: 17px in a 36px circle, 19px in
  a 40px one), upper-cased only when that keeps it one letter. The letter's
  size and weight are the owner's choices.

`ring` draws the stack's 2px band in the page's colour outside the circle, a
box-shadow on the root, so the photo keeps its size; `Avatar`'s
`ring="surface"` paints a border inside the circle instead. `class` is required
and sets the size and the place: the root measures its letter from its own
width, so it takes none from its contents.

`avatarTriggerClass` (`avatar-trigger-class.ts`, a module of its own so the guest
site, which draws no trigger, leaves its classes out) is the 36px round button an
account menu opens from: the
portals' pill ground (`--pill-ground`, the surface at 30%) and `Button`'s ring; the `initial` avatar inside it
(`class="size-full"`) draws the hairline, and its edge turns `--ui-accent-soft`
under the trigger's pointer (`group/avatar-trigger`). The fill is the
trigger's, not the avatar's, because the guest site lays no ground of its own
under a gold word. Neither imports Kobalte,
so a trigger can draw before a menu's code has loaded.

`cire/ui/tests/person-avatar.test.tsx` holds the URL guards, the failed-URL
set, both stand-ins and the initial's graphemes, the ring classes and the
trigger's ring; `person-avatar-source.test.ts` that neither file imports a menu
library; `person-avatar.browser.test.tsx` the initial at 4.5:1 on its disc in
both ramps, the letter's size and weight, the ring outside the photo, the
opaque blank disc, the trigger's edge and ring, and the edge's fade.

### cire's `SkeletonOutline` — the real row, drawn hollow

A view that loads renders its own rows from a typed sample inside
`SkeletonOutline` (`cire/ui/src/skeleton-outline.tsx`), and the outline paints
them as a placeholder: the placeholder is the loaded row's height at every
width because it is the loaded row's markup, with no height written down. The
look is the owner's (englishstreetventures/osn#1955):

| Part | Drawn as |
|---|---|
| A run of words or digits | A bar the height of its letters, one per wrapped line, 4px corner at both ends of each (`box-decoration-break: clone`) |
| Text with no letter or digit (a dot, a dash) | Nothing |
| A `button`, `input`, `select`, `textarea`, a switch's track, a meter (`progressbar`, `meter`), anything marked `data-skeleton="block"` | One block, its border, shadow and gradient cleared, what it holds hidden |
| A picture (`img`, `video`, `canvas`) | One block in its own corner, its pixels moved out of its box (`object-position`) |
| A `button` marked `data-skeleton="text"` (a sortable column head; `CardCtaButton` carries it) | Its words and glyph, as above, no block |
| A glyph (`svg`) | A small block, 4px corner |
| Frames, hairlines, grounds | As they are, still |

Bars, blocks and glyphs are the ink at 10% and pulse on `PULSE`'s timing (2s ×
`--motion-scale` on `--ease-in-out`), written out as literal classes, which
`skeleton-outline.browser.test.tsx` holds to what `Skeleton` computes; frames
do not pulse. The outline is `aria-hidden` and `inert`; the region that holds
it and what replaces it carries `aria-busy`, and an outline lent to a bar
outside that region (the households' count line in the view bar) needs none.
It builds its runs with `document` as it renders, so it renders in the browser
only: in a `client:only` island, never in a server render.

How it draws a bar: as its children arrive it moves each run of words, once,
into an inline `<span data-skeleton-run>`, and CSS does the rest — wrapping,
resizing and font loads move each bar with its text. Nothing is measured. An
inline background is the only way to round each line's ends, and most text in
a row sits bare in a block (`td`, `dt`, `p`), where no selector reaches it; a
struck-through line instead has square ends, draws a nested run differently in
Chromium and WebKit, and darkens once per decorating box under a translucent
fill. Text in an `svg`, `option`, `textarea`, `script`, `style` or `title` is
left where it is. It uses no `@scope` and no `:has()`, which are past cire's
floor (Chrome/Edge 111, Firefox 114, Safari/iOS 16.4).

It takes no `class`: its children bring their own layout, in the wrapper the
loaded content has. A call site may set `data-skeleton="block"` on a part of
the real row that is a disc or a chip, and `data-skeleton="text"` on a button
drawn as words. Both are plain attributes on the loaded markup and do nothing
outside an outline.

The children are a still picture, rendered once from constant samples: a run
that appears later inside them, under a `Show` that flips after the outline
mounts, is not drawn, and a reactive text moved into a run may stop updating. A layout that changes renders a new outline, by a `Show`
around it or a top-level child that changes, which the outline marks again.
Samples are typed against the real row's type and live beside the component
that renders them; they are never shown, since everything in the outline is
transparent (the owner's call on #1955).

The guest site, the marketing site and the vendor portal leave the file out of
their Tailwind scan (`@source not`), since none of them draws it.

`cire/ui/tests/skeleton-outline.test.tsx` holds which text becomes a run, what
stays alone and the wrapper's attributes; `skeleton-outline.browser.test.tsx`
holds the bars per line, their fill and corner in both ramps, the blocks and
glyphs, the hints, the untouched frame, hairlines and ground, the outline's
size against the loaded markup's at two widths, that nothing inside takes
focus or a click, and the pulse on the pieces alone. Stories:
`tools/lab/src/stories/cire-ui/skeleton-outline.story.tsx`.

### cire's `Button`, as a vocabulary

`@cire/ui`'s `Button` is the house style rather than the shadcn set — pill
actions, sentence-case labels at normal tracking in a medium weight, a gold
primary — and on a cire surface it is where a call site's colour, shape and
padding have to come from. Nineteen variants, grouped by the job rather than
by the look:

| Group          | Variants                              | What each is for                                                                                                                                                                                                                              |
| -------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit         | `primary`, `cta`                      | The one thing to do on the screen. `cta` is the guest site's: outlined at rest and filled on hover, because an invite is restrained enough that a gold fill at rest would be the loudest thing on a page whose job is a photograph and a date |
| Secondary      | `outline`, `quiet`, `bar`, `dashed`   | A gold edge, a neutral action, the portals' bar icon button, and the empty slot — a dashed box promises that something _appears_, a solid one that something _happens_. `outline`'s 40% edge turns full gold under the pointer and nothing fills, so its gold word keeps its rest contrast wherever it sits (`cire/ui/tests/outline.browser.test.tsx`). `quiet` holds its hover look (gold edge, readable gold) while what it opens is open (`aria-expanded`); at `icon` it is a portal row's icon action. `bar` rests as `quiet` does; under the pointer its ground lifts to the surface at 60% with the body ink and a gold edge, and while what it opens is open (`aria-expanded`) it stands on the raised surface in the body ink and its hairline, which the pointer does not move — the hover is gated on `not-aria-expanded` (`cire/ui/tests/portal-pills.browser.test.tsx`) |
| Destructive    | `danger`, `quietDanger`, `bareDanger` | Red at rest for the button that commits it; muted at rest and red on hover for the control that merely offers it, boxed (`quietDanger`) or as a glyph (`bareDanger`). A column of red-outlined buttons down a table reads as an error state   |
| Text           | `link`, `subtle`, `touchLink`         | Accent ink, muted ink, and muted ink carrying its underline at rest. The last is for a link whose underline must show without hover: on `@cire/invites`, read on a phone where there is no hover to reveal one. A link set inside a sentence is not a `Button` at all: it takes `proseLinkClass`, below |
| Glyph          | `bare`                                | An arrow, a cross, a disclosure caret. No underline, because there is no word to underline                                                                                                                                                    |
| Field          | `field`                               | A control shaped like the field it stands in for — the dietary picker's collapsed trigger, in a column of text inputs: an input's padding and weight, the text field's corner, transparent like the inputs around it |
| Chrome         | `chip`, `round`                       | A control in a sheet's own chrome rather than its content. `chip`: the guest event sheet's badge, "Give RSVP →" and "← See details", in its bar beside the round close button — a pill on the surface fill, opaque because content scrolls under it, in accent ink because it leads somewhere. `round`: a glyph on that same opaque disc with no edge — the sheet's close × — muted ink that brightens on hover while the fill stays |
| State and fill | `choice`, `glass`, `tile`             | One option among several, marked through `aria-pressed` **or** `aria-checked` so a toggle group and a radio group look the same — an accent edge, accent ink and a 2px 60% ring; and the control that _is_ a block — a card, a row — where a hairline stops describing the target. Under the pointer an unchosen `choice` goes halfway to chosen (edge and ink a `color-mix` of rest and chosen, a 1px 30% ring, so chosen and hovered differ by the ring's width and not by gold alone), its hover on `--dur-fast` with the arriving curve and its choosing on `--dur-base` with `ease-in-out`. Locked with `aria-disabled` while its answer saves, a `choice` keeps its look and only stops answering the pointer; every other variant fades to 40%, and `disabled` fades a `choice` too. `glass` is the portals' one of several (a scheme preset, the preview's Desktop and Phone, a crop's shape): the glass track's look at rest, a strip choice's halfway hover, and chosen the strip's glass in readable gold at medium weight, the rest at normal — the cue that is not colour, as a strip's, with each word's width held by an unseen medium copy drawn as generated content (`GLASS_WORD`, the strip's own) and the pill named by its word — on the same two clocks; its classes are `GLASS_CHOICE` in `lib/glass.ts`, held to the strip's by `cire/ui/tests/glass.test.ts`, and the guest site keeps `choice`, as does a swatch whose own fill is what is chosen |

Six sizes, and they are not one scale:

| Size             | What it gives                                     | For                                                                                                              |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `sm`, `md`, `lg` | three steps of label padding and type; `sm` takes `--pill-sm-height` where an app sets it (the portals: 28px) and its padding's own 31px elsewhere | An ordinary control                                       |
| `form`           | md's sides and type at the 34px form-field height (`field`: its own padding and type at 34px) | A button beside a portal form field                                  |
| `swatch`         | one hairline of padding, no type at all           | A control whose content is the thing itself — a colour swatch, a product thumbnail. The picture is what sizes it |
| `icon`           | square, sized to the glyph rather than to a label; boxed, a 28px circle | A single glyph                                                                                     |

**The portals' two tokens.** `Button` reads two app tokens the host and vendor
portals set and the guest site and the marketing site leave unset:
`--pill-ground`, the ground every non-primary boxed pill sits on (`cta`,
`outline`, `quiet`, `bar`, `quietDanger`, `dashed`, `danger`, `choice`, `glass`; in
the portals the surface at 30%, the glass track's ground; unset, transparent),
and `--pill-sm-height` (above). `avatarTriggerClass` and `FileInput`'s button
read the ground too. `cire/ui/tests/portal-pills.browser.test.tsx` measures
both with the portals' values and without.

Five sizing tables, picked by the variant. The borderless ones take the type
step and none of the box padding or weight, because `px-5 py-2` around a text
link is a word floating in a gap. `tile` takes square block padding, because its
interior is a small layout — a numbered marker beside two lines of text — rather
than a word. `field` takes an input's padding and weight. `round` takes a square per step — 28px at `sm`, 32px at
`md`, `icon` and `swatch`, 34px at `form`, 44px at `lg` (the close ×, the guest site's touch floor) — its glyph on the
`base` text step, and the close × on `lg`. A `round` button, and any `Button` at the `icon` size, holds one glyph hidden
from assistive tech, so its type requires `aria-label` or `aria-labelledby`
when the variant or size is written as a literal. Everything else takes
the ordinary one, whose side padding is a step wider than a rectangle's because
a pill's round ends eat into the room beside the label.

The corner is not in the sizing tables. Each class string carries exactly one,
`base:`-prefixed, from a contract role rather than a size step, so each cire app
sets how round its buttons are once, in its stylesheet ([[design-tokens]]):

| Variant or size                         | Corner                 |
| --------------------------------------- | ---------------------- |
| size `swatch`, whatever the variant      | `base:rounded-ui-field` |
| variant `tile` or `field`               | `base:rounded-ui-field` |
| variant `chip`                          | `base:rounded-ui-pill` |
| variant `round`, at every size           | `base:rounded-ui-pill` |
| every other variant and size             | `base:rounded-ui-control` |

A tile is a block, a field holds a value and a swatch frames a picture, so a
pill would read as a lozenge around each. `chip` and `round` take the `pill` step rather
than the `control` role: it sits beside a round close button and stays round
whatever an app maps `control` to. The borderless variants take `control` too;
with no border and no fill, only their focus ring shows it.
Because no default corner is a plain utility, a caller's plain `rounded-*` in
`class` wins rather than tying with it (§Class composition above).

`choice`'s hover is gated on the option being neither chosen nor locked, and the
gate is written inside `base:` — `not-aria-pressed:not-aria-checked:not-aria-disabled:hover:base:…` —
because Tailwind applies stacked variants left to right: `base:hover:x` compiles to
`:where(.x):hover`, which keeps the hover's own pseudo-class weight, and a gate
of three `:not()` before `base:` would outrank a caller's plain `hover:` class.
Written the other way the whole selector sits in `:where()` and a caller still
wins (`cire/ui/tests/choice.browser.test.tsx`).

`cire/ui/src/button.tsx` carries the reason for each in its own doc comment, and
that is the bar for adding one: a variant is a design concept somebody can name,
not a colour somebody wanted. `custom`, `alt` and `variant2` are not names.

**A link inside a sentence is not a `Button`.** Every `buttonClass` output
starts `inline-flex … whitespace-nowrap`, which holds a long link to one line.
`proseLinkClass({ tone })`, from the same file, gives an `<a>` set in running
text its classes instead: inline, so it wraps with its sentence; underlined at
rest at a 2px offset, so colour is not the only thing marking it (WCAG 1.4.1);
no type size and no weight, so it takes the sentence's. Two tones: `accent`
(the default), readable gold, unchanged on hover; `muted`, the secondary ink,
brightening to the body ink on hover as `touchLink` does. A link inside a
tinted `Notice` takes `accent` too, not the notice's ink (owner,
englishstreetventures/osn#1838). It draws `Button`'s focus ring itself, since
`@cire/landing` has no blanket `:focus-visible` rule, and its transition names
its colours only. It is for an `<a href>` that goes somewhere: a `<button>`
lays out as an inline block even at `display: inline`, so its words never wrap
with the sentence. A way to another screen written into a sentence is still a
link with a real address, whose click handler may take over the plain click to
do the navigating and leaves a modifier or middle click to the browser; an
action that goes nowhere stays a `<button>`, outside the sentence. A link that stands alone is not this either: it is a pill,
`buttonClass({ variant: "outline" })`. The organiser portal draws its pills through `LinkPill`
(`cire/host/src/components/LinkPill.tsx`): `sm` at 28px, a destination's 14px mark before the word, and a 28px circle
with the word in its name and its title in a row under 14rem (`cire/host/DESIGN.md` §7). The guest site's pills are `md` at its 44px
floor.

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
9. Add a test under `shared/ui/tests/` — `tests/ui/<name>.test.tsx` for DOM shape and wiring, `tests/<area>.browser.test.tsx` for anything that needs real CSS or layout — for each guarantee no caller's test already holds. Where a caller's test does hold one, name that test in the component's section, as §`Tooltip` does.
10. Add it to the lab's catalogue story for its group, under `tools/lab/src/stories/shared-ui/` ([[component-lab]]).
11. No barrel file — consumers import individual components by path.

An auth view goes to `osn/auth-ui/src/<Name>.tsx` instead, with both a subpath
export and a line in `osn/auth-ui/src/index.ts`, and a test in
`osn/auth-ui/tests/`. cire chrome goes to `cire/ui/src/<name>.tsx`. If it is not
obvious which of the three, [[osn-and-musubi]] decides it. Either gets lab
stories under `tools/lab/src/stories/osn-auth-ui/` or `cire-ui/`, never beside
the component ([[component-lab#Stories for auth and cire components]]).

A new or changed component in any of the three ships in a pull request of its
own, under the feature that uses it: [[stacked-prs#Frontend: one component per pull request]].

## Testing considerations

`@shared/ui` runs two projects out of one `vitest.config.ts`, split by filename:
`tests/**/*.test.tsx` is the `unit` project on happy-dom, and
`tests/**/*.browser.test.tsx` is the `browser` project on real Chromium. Every
file lands in exactly one. `bun run --cwd shared/ui test:run` runs the first,
`test:browser` the second. `@cire/ui` splits the same way, and its browser
project loads `cire/ui/tests/test-support/tailwind.css`, which maps cire's own
two ramps (the literals the lab's `cire-mapping.ts` resolves) rather than a
synthetic palette, so a contrast assertion there is a claim about cire's
colours. `@osn/auth-ui` has a unit tier only.

The split exists because the unit project parses no stylesheet and computes no
layout: it can assert a class list and a DOM shape, but not that a class emitted
CSS, won the cascade, or painted anything. The browser project loads
`shared/ui/tests/test-support/tailwind.css`, which stands in for an app by
mapping the whole `--ui-*` contract to a deliberately garish synthetic palette —
the neutral fallbacks collapse several roles onto one value, which is exactly
what a "tone is not carried by hue alone" assertion needs to tell apart. See
[[browser-tests]].

- Components render standard HTML — tests use `@solidjs/testing-library` with role/label queries
- **Kobalte portals**: Dialog, Popover and Tooltip content is portaled to `<body>`. Use `screen.queryByText()` (searches full document) instead of `container.querySelector()` (searches render container only)
- **`Tooltip`'s panel is `aria-hidden`**, so `getByRole("tooltip")` skips it: find it with `document.querySelector('[role="tooltip"]')`. While it is open its words are in the document twice, the hidden copy and the panel, so `getByText(<its text>)` throws
- **`base:` prefixed class selectors**: Component default classes are prefixed with `base:` in the DOM (e.g. `base:relative` instead of `relative`). CSS selectors must escape the colon: `span.base\\:relative`. Consumer-provided classes (via `class` prop) are NOT prefixed and can be selected normally
- **Avatar DOM structure**: The `Avatar` wrapper has `base:relative` class. The fallback text is inside a nested `<span>`. Tests that find avatars should use `span.base\\:relative`
- **Close-friend ring**: Applied to the outer `Avatar` wrapper via `clsx()` (not prefixed — it's a consumer class), not to the inner `<img>` or fallback `<span>`

## Source files

| File                                        | What it is                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `shared/ui/src/ui/`                         | Every primitive's source                                                     |
| `shared/ui/src/lib/utils.ts`                | `clsx`                                                                       |
| `shared/ui/src/ui/control.ts`               | The shared text-control box                                                  |
| `shared/ui/src/ui/props.ts`                 | `SafeProps`                                                                  |
| `shared/ui/package.json`                    | The subpath exports                                                          |
| `shared/ui/src/ui/orb-api.ts`               | The types the `./ui/orb` export gives a consumer                             |
| `shared/ui/vendor/thinking-orbs/README.md`  | The orb engine's pin, re-vendor recipe and upstream check                    |
| `shared/ui/vitest.config.ts`                | The unit / browser project split                                             |
| `shared/ui/tests/test-support/tailwind.css` | The stylesheet the browser tier renders against                              |
| `osn/auth-ui/src/index.ts`                  | The auth-view barrel                                                         |
| `osn/auth-ui/package.json`                  | Per-view subpath exports                                                     |
| `cire/ui/README.md`                         | Why those components are cire's and not shared                               |
| `shared/design-tokens/src/tokens.css`       | The `--ui-*` contract, the `base:` variant and the `@source` lines           |
| `pulse/web/src/app.css`                     | An app's mapping block — shadcn ramp                                         |
| `cire/host/src/styles/global.css`           | An app's mapping block — cire's two OKLCH ramps, plus `@cire/ui`'s `@source` |
