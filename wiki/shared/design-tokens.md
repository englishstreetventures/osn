---
title: Design tokens — @shared/design-tokens and the ui-* contract
tags:
  - architecture
  - design-system
  - tokens
related:
  - "[[component-library]]"
  - "[[component-lab]]"
  - "[[frontend-patterns]]"
  - "[[browser-tests]]"
  - "[[toast]]"
  - "[[osn-and-musubi]]"
  - "[[house-lint-rules]]"
last-reviewed: 2026-11-12
---

# Design tokens — `@shared/design-tokens` and the `ui-*` contract

One neutral vocabulary that the shared component packages write and every app
maps onto once. Colour roles, plus type, tracking, leading, radius and measure
scales, and a title weight.

## The problem it solves

Two token vocabularies were in use across ten frontends: shadcn's semantic names
(`--card`, `--primary`, `--muted-foreground`) in `@musubi/social` and
`@pulse/web`, and cire's house ramp (`--gold`, `--bg`, `--text-muted`) in every
`@cire/*` app. A component cannot be shared across that split, because it has to
name a colour to paint one.

Without a shared vocabulary there are only three ways out, and a codebase that
lacks one ends up using all of them: write the component in plain CSS keyed off
its own custom properties, beat the library's defaults with `!important` at
every call site, or keep a duplicate component per app. The contract exists so
that none of the three is ever the answer.

## The shape

```
  app vocabulary          contract              component
  ──────────────          ────────              ─────────
  --card         ──map──▶ --ui-surface  ──────▶ bg-ui-surface
  --gold         ──map──▶ --ui-accent   ──────▶ bg-ui-accent
```

Three rules, and they are the whole design:

1. **The contract is library-facing.** `@shared/ui`, `@cire/ui` and
   `@osn/auth-ui` are held to `ui-*` utilities; `@osn/auth-ui`'s own class
   attributes do not meet that yet (see the table under §Where the pieces
   live). Application code is not held to them — every
   `bg-card` in pulse and `text-gold` in cire stays exactly as written. An
   app may still write one where it wants the contract's step or role:
   pulse and cire take their type and tracking steps from the contract
   (`text-ui-sm`, `tracking-ui-wider`), and cire its leading and radius
   steps too.
   `@shared/toast` reaches the same end by a different route: it compiles no
   utilities at all and reads its own `--toast-*` properties from plain CSS
   ([[toast]]).
2. **An app maps once.** A `:root` block naming each `--ui-*` in the app's own
   vocabulary. That is the entire integration; the package carries the
   `@source` and `@custom-variant base` the components need, so no app declares
   either.
3. **The namespace is what makes it real.** Nothing an app writes can collide
   with a contract utility, and nothing a contract utility reads depends on an
   app's naming.

Adopting it is two lines:

```css
@import "tailwindcss";
@import "@shared/design-tokens/tokens.css";

:root {
  --ui-surface: var(--card);
  --ui-ink: var(--foreground);
  --ui-accent: var(--primary);
  /* … */
}
```

### Why the prefix is `ui-`

A prefix has one job here: keep a library's vocabulary from colliding with an
app's. What it needs to be is short, unclaimed by Tailwind, and descriptive of
what the names are for — and what these names are for is user interface.

It also gets read as a claim about ownership, which is the part worth getting
right. Nothing in `tokens.css` belongs to the identity system: no
implementation has to spell `--ui-surface` to interoperate with anything, and
the surfaces reading these tokens include cire's guest site and the marketing
pages, which never touch an OSN ceremony. An `osn-` prefix therefore asserted a
relationship the components do not have. [[osn-and-musubi]] is what decides
which name a new package, token or identifier takes.

## The tokens

| Group    | Names                                                               |
| -------- | ------------------------------------------------------------------- |
| Grounds  | `ground`, `ground-deep`                                             |
| Surfaces | `surface`, `surface-raised`, `surface-sunk`                         |
| Edges    | `hairline`, `hairline-strong`                                       |
| Ink      | `ink`, `ink-secondary`, `ink-tertiary`                              |
| Accent   | `accent`, `accent-strong`, `accent-soft`, `accent-ink`, `on-accent` |
| Status   | `success`, `warn`, `danger`, `on-danger`                            |
| Focus    | `focus`                                                             |

Scales, each spelled as a Tailwind utility: `text-ui-xs` … `2xl`,
`tracking-ui-tight` … `ultra`, `leading-ui-none` … `relaxed`,
`rounded-ui-hair` … `pill` plus the three role radii `rounded-ui-control`,
`rounded-ui-field` and `rounded-ui-sheet`, `font-ui-body` /
`-display` / `-mono`, the weight role `font-ui-title`, and the measure scale
`max-w-ui-xs` … `3xl` — declared as `--container-ui-*`, which is the namespace
Tailwind reads a `max-w-*` from.

Three groups sit outside `@theme` as plain custom properties, because a
component consumes them inside its own rule rather than as a utility:
`--ui-focus-width` / `--ui-focus-offset`, the motion tokens (§Motion, below)
and `--ui-elev-1|2`.
Aliasing those would generate utilities nobody spells. No `@shared/ui`
primitive reads the two focus tokens: it draws focus with Tailwind's fixed
2px utilities (`ring-2`, `outline-2`, `outline-hidden` and their offsets), so
a surface that sets them moves only the rules it writes itself, such as the
lab's focus story. `CONTRACT_COLOR_TOKENS`
and `CONTRACT_SCALAR_TOKENS` in `src/index.ts` are the enumerable form of both
lists, and `tests/tokens-css-agrees.test.ts` fails if they and `tokens.css`
drift apart.

**`control`, `field` and `sheet` are roles, not sizes**, the same way `focus` is
its own colour rather than an alias of the accent. How round a _button_ is turns
out to be independent of how round a card is, and so is how round a _text
field_ is: `Button` reads `control`, while `Input`, `Textarea` and `Select` read
`field` (`shared/ui/src/ui/control.ts`), so an app can give its buttons pill
ends without making its fields pills, which read as search boxes. The top edge
of a _bottom sheet_ is a third: a sheet's grip is measured against the screen
edge it is pulled from, not against a card.

Each role falls back to a sized step, so an app with no opinion gets its own
value rather than one from the package: `control` to `md`, `sheet` to `lg`.
`field` falls back to `control` first and only then to `md`, so an app that maps
`control` alone keeps its fields and its buttons alike.

| Role      | musubi               | pulse                            | cire                                     |
| --------- | -------------------- | -------------------------------- | ---------------------------------------- |
| `control` | pill                 | `--radius`, the same as its `md` | pill                                     |
| `field`   | `--radius-md`, 8px   | not mapped: `--radius`           | 14px                                     |
| `sheet`   | not mapped: its `lg` | not mapped: its `lg`             | 1.75rem on the guest and marketing sites |

cire's sized steps are 2px `hair`, 6px `sm`, 10px `md`, 16px `lg` and 999px
`pill`, and its `--toast-radius` is `md`. All four cire stylesheets carry the
same values: `cire/vendor/tests/styles/tokens.test.ts` reads each one and fails
if a role or a step differs. What each step paints in cire is
`cire/host/DESIGN.md` §4.

**`title` is a weight role**, not a step on a weight scale: the weight a shared
part sets a short title or a tag in, one step over body text. An app maps
`--ui-weight-title`; parts read it through `font-ui-title`, which `tokens.css`
declares as `--font-weight-ui-title: var(--ui-weight-title, 600)` in its
`@theme inline` block. Tailwind tells it apart from the `font-ui-*` families by
the key: `--font-weight-*` builds a weight utility, `--font-*` a family. The
fallback is 600, Tailwind's `font-semibold`, so an app that maps nothing sets
those parts semibold. `@shared/ui`'s `Badge`, `DialogTitle` and `CardTitle`
read it ([[component-library]], §Variant components, §Kobalte components and
§Simple styled components). Musubi maps it to 500 in the contract block of
`musubi/social/src/App.css`, and the lab and the metrics dashboard, which
import that stylesheet, draw its 500. Pulse and cire map nothing: pulse draws
a badge and a dialog title at 600 and no `CardTitle`. Musubi draws dialog and
card titles at 500 and no badge. In the lab, `DialogStory`, the unmapped
columns of `CardTitleWeights` and `BadgeWeights`, and every cire subtree
(`cireStyle()`) lend `initial`, so they draw 600 whatever the lab maps. `shared/ui/tests/badge-default.browser.test.tsx`,
`dialog-default.browser.test.tsx` and `card-default.browser.test.tsx` each hold
an unmapped badge's or title's whole computed style, and pulse's
`tests/styles/token-contract.browser.test.tsx` holds 600 for its badges and the
dialog title under pulse's own stylesheet.

`@cire/ui` also reads a few of cire's own app tokens, outside the contract,
with a fallback at each use: the glass's `--glass-edge`, `--inner-lip` and
`--elev-1`, the motion ladder's `--dur-*` and `--ease-*`, and the portals' two
pill tokens, `--pill-ground` and `--pill-sm-height`, which only the host and
vendor portals set, so one `Button` draws grounded 28px pills there and clear
31px ones on the guest site ([[component-library]], §cire's `Button`).
They are not contract tokens because nothing outside cire reads them.

Two names are worth reading twice. **`ground-deep` is not "darker"** — it is
what the page recedes _to_, behind a sticky bar or under a scrim, and on a dark
theme it is lighter. **`accent-ink` is not `on-accent`**: `accent-ink` is accent
text on the page, `on-accent` is the label on a filled accent ground, and the
two have opposite contrast requirements.

## Motion

Each motion token is named for its job. **Choose one by its job, never by the
nearest number**: a hover timed on `--ui-dur-exit` because 80ms looked right
would change pace the day exits do, and a sheet on `--ui-dur-fast` would stop
following an app that slows its panels. `tokens.css` carries the same job as
a one-line comment beside each value, and `CONTRACT_SCALAR_TOKENS.motion`
lists them. A duration, delay or easing written out where a token belongs
fails `house/no-literal-motion` in TypeScript and
`scripts/check-motion-literals.ts` in `.css` and `.astro` files; a fallback
inside `var()` passes. A literal moves to the token of its job even when the
value changes. Tailwind's `ease-out` class reads the app's `--ease-out`:
Tailwind's own curve outside cire, cire's own curve inside it (below). It is
never `--ui-ease-out`: for the contract's curve write `ease-(--ui-ease-out)`
([[house-lint-rules]] §Literal motion).

| Token | Value | Used for |
| --- | --- | --- |
| `--ui-dur-fast` | 120ms | A hover, a press, a small panel arriving |
| `--ui-dur-base` | 200ms | A panel swap, a pill sliding |
| `--ui-dur-slow` | 320ms | Something crossing the screen |
| `--ui-dur-exit` | 80ms | A Kobalte overlay closing: a menu, a popover, `Dialog`. `Modal` exits on its own `--ui-modal-exit` ([[component-library]], §Overlays: `Modal`) |
| `--ui-ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | Something arriving |
| `--ui-ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Something moving between two places |
| `--ui-ease-exit` | `cubic-bezier(0.22, 1, 0.36, 1)` | A Kobalte overlay closing: a menu, a popover, `Dialog`. `Modal`'s exit runs `ease-in` |
| `--ui-scale-enter` | 0.96 | How small a floating panel starts as it arrives: a menu, a popover, a tooltip, `Dialog` |
| `--ui-scale-exit` | 0.98 | How small an overlay ends as it leaves, `Modal` included |
| `--ui-distance-enter` | 24px | How far `Modal` rises into place |
| `--ui-distance-exit` | 8px | How far `Modal` sinks as it leaves |

**An exit is shorter and smaller than its entry.** A panel leaving has nothing
more to tell the reader, so it gets out of the way: 80ms against 120ms, and it
ends at 0.98 where it started at 0.96. `Modal` keeps its entry's own 0.98, so
its exit is softer by distance and time alone (8px in 150ms against 24px in
350ms). Musubi sets the two scale tokens to 1 (below); no app sets the
durations or distances, so every app runs those, and pulse and cire run the
scales too.

**An exit has its own curve.** `--ui-ease-exit` carries the same curve as
`--ui-ease-out`, so a Kobalte overlay leaves on the curve it arrives on. They
are two tokens so that an app can map `--ui-ease-out` onto its own arriving
curve without moving its overlays' exits, which `animate-out` times. Cire
maps `--ui-ease-out` (below); no app sets `--ui-ease-exit`.
`overlay-motion.browser.test.tsx` holds each overlay that exits
on `--ui-ease-exit`, unmoved by `--ui-ease-out`, and
`dialog-default.browser.test.tsx` holds an unmapped `Dialog`'s entry and exit
on the one curve ([[browser-tests]]).

Cire's own `--ease-out` is a different curve, `cubic-bezier(0.23, 1, 0.32, 1)`,
the owner's choice of 2026-11-11 for all four cire apps and their one curve
for something arriving ([`cire/host/DESIGN.md`](../../cire/host/DESIGN.md) §4).
The shared parts that read `var(--ease-out, var(--ui-ease-out))` follow it
there, and so does every transition that names no easing: each cire stylesheet
sets Tailwind's `--default-transition-timing-function` to `var(--ease-out)`,
which outside cire stays Tailwind's `cubic-bezier(0.4, 0, 0.2, 1)`. Each cire
stylesheet's contract mapping also sets `--ui-ease-out: var(--ease-out)` (the
owner's choice of 2026-11-12), so `Modal`'s rise and every `animate-in` entry
(`Tooltip`, `Popover`, the default `DropdownMenu`) arrive on cire's curve too.
The exits stay where they were: `animate-out` reads `--ui-ease-exit`, which no
cire stylesheet maps, and `Modal` leaves on `ease-in`.
`cire/vendor/tests/styles/tokens.test.ts` fails if one cire app drops the
mapping or maps an exit, and cire host's
`tests/styles/overlay-curves.browser.test.tsx` reads a `Popover`'s and a
`Modal`'s curves back as they run.

`Dialog`'s `sheet` presentation scales like its centred card, from its
centre. Below `md` the sheet is pinned to the bottom edge at full width, so
its sides and its bottom edge sit in from the screen's by 2% of its size as
it arrives and 1% as it leaves. `Modal`'s sheet rises from below the edge
instead. Musubi's dialogs, most of the sheet's callers, fade with no scale
(below); pulse's share dialog keeps the scale.

**A fade with no scale is the two scale tokens at 1.** An app whose overlays
should fade without moving sets `--ui-scale-enter` and `--ui-scale-exit` to 1
on its root. Every Kobalte overlay — `Dialog` as card and as sheet, `Popover`,
both `DropdownMenu` looks and `Tooltip` — then changes only its opacity, since
`zoom-in` and `zoom-out` read those tokens and nothing else in the keyframes
moves a panel. `--ui-scale-exit` at 1 also stops `Modal`'s exit scale. Its
entry keeps its own `scale(0.98)` (`modal.tsx`), which no token reaches, so it
still grows as it opens; its rise and sink (`--ui-distance-enter`,
`--ui-distance-exit`) stay too. No component takes a prop for it: a prop would
give a panel's scale a second home, and leave the menus and popovers of the
same app zooming. A held frame's computed `transform` is the identity matrix
rather than `none`, because the shared keyframes always declare one.
`overlay-motion.browser.test.tsx` holds the fade for all five overlays, and
for `Dialog` as a sheet at 390px, against a control that scales, and the lab's
`DialogFadeOnly` story shows it ([[component-lab]]). Musubi sets both to 1 in
its contract block, so the lab and the metrics dashboard fade too. On real
pages `tools/e2e` holds Musubi's account menu, profile switcher and
create-organisation dialog on the fade, and pulse's avatar menus and "More
filters" dialog on the contract's 0.96 (`musubi-surfaces.ts`,
`pulse-menus.ts`).

The overlays reach them through four utilities in `tokens.css`, not by
reading the tokens in their own classes. `animate-in` runs `--ui-dur-fast` on
`--ui-ease-out` and `animate-out` runs `--ui-dur-exit` on `--ui-ease-exit`;
`zoom-in` and `zoom-out` set the scale an element enters from and leaves to
from `--ui-scale-enter` and `--ui-scale-exit`. Two pairs of names sit close:
`--ui-scale-enter` is the token an app sets, `--ui-enter-scale` is what
`zoom-in` writes on one element for the keyframes to read.

**Reduced motion has one home for the Kobalte overlays.** Under
`prefers-reduced-motion: reduce`, a flat block in `tokens.css` sets
`--ui-enter-animation` and `--ui-exit-animation` to `none` on the root, and
`animate-in` and `animate-out` read their `animation-name` from them. Every
overlay drawn with those utilities stops moving, and a new one needs nothing
on its class string. The accent menu's pop is its own `animation` shorthand,
so it keeps its `motion-safe:` prefix. `Modal` is a transition, not these
utilities: its own stylesheet drops every duration to 1ms
([[component-library]] §Overlays: `Modal`).
`overlay-motion.browser.test.tsx` holds each of these in Chromium
([[browser-tests]]).

## A `max-w-*` outside the built-in steps needs naming in the linter

Every step of the measure scale is **rem**, the contract's `max-w-ui-*` included.
That is right for a measure, which should track the type it bounds. It is wrong
for a cap that bounds a column against the _viewport_, in the one app that moves
its root font-size: `@cire/invites` steps 16px → 17px at 1024px, so a rem cap is
6.25% wider on every desktop viewport than the number it was written as.

Such an app declares its own px scale — `--container-column-*` in
`cire/invites/src/styles/global.css` — and that is ordinary app-token work. What
is not obvious is that `shadcn/no-restyle` then rejects the resulting class on a
library component:

```
"max-w-column-md" is not allowed on <Modal>: the grammar does not recognize it.
Fix the spelling, or use a class Tailwind generates.
```

Three facts settle it, and none of them is the one the message suggests.

**The rule classifies a class with `cn`'s grammar, and that grammar models
`max-w-*` only on Tailwind's built-in steps.** A `max-w-*` built from _any_
custom `--container-*` entry gets no class group, so it lands in the
`unclassified` category — and the `layout` bucket only admits a token that _has_
a group. So `allow: ["layout"]` can never reach one, however plainly a width cap
is layout. The class itself is fine: `shadcn/no-unknown-classes` reads the same
Tailwind build and is silent on it.

**This is not only about app tokens — the contract's own measure scale hits the
same wall.** `max-w-ui-sm` and `max-w-ui-2xl` on a `<Modal>` are rejected with
exactly the message above, while every built-in step (`max-w-md`) classifies
cleanly. So "use the contract instead" is not an escape from this, and the
rejected set is _everything off Tailwind's built-in scale_.

**An explicit glob does reach it.** The allow list is consulted _after_
classification, not before, so `"max-w-ui-*"` and `"max-w-column-*"` match the
token by name and return it allowed. The catch is where to put the entry: a
`contracts` entry's `allow` **replaces** the top-level one rather than extending
it, and `Modal` is inside the contract that covers `Card`, `Modal` and the menu
triggers. Named only at the top level, the entry is discarded for exactly the
components that need it, with no diagnostic saying so — which reads as "the
allow list has no effect". It also goes live everywhere else, including the four
packages where `no-unknown-classes` is turned off, where a `max-w-*` with no CSS
behind it would then pass both rules. So the entry belongs on the contract and
nowhere else, which is where `oxlintrc.json` puts it.

_Verified 2026-09-18 — `max-w-column-md`, `max-w-ui-sm`, `max-w-ui-2xl` and
`max-w-md` each put on `AnimatedModal`'s `class` in turn, with
`bunx --bun oxlint -c oxlintrc.json cire/invites/src/components/AnimatedModal.tsx`
run against each; and `max-w-column-*` tried on the top-level `allow` (no effect)
before the contract's (clean)._

## Four decisions that are easy to get wrong

### `@theme inline`, not plain `@theme`

`inline` makes `bg-ui-surface` compile to `var(--ui-surface, …)` resolved **at
the element**, not at `:root`. A subtree that redefines a token is then followed
correctly — a theme story showing light and dark side by side, a themed section
on a landing page, cire's invite preview rendering a wedding's palette inside
the organiser's own chrome. Without `inline` the alias resolves once at `:root`
and every one of those silently shows the page theme instead.

The reason `cire/host` gives for keeping _its own_ theme block non-inline does
not transfer: there the JS-read name is `--color-gold`. Here nothing reads
`--color-ui-*` from JavaScript — an app that wants a value in JS reads its own
`--ui-*`, or its own token, with `getComputedStyle`.

The lab shows the property directly. `design-system/theming` in `@tools/lab`
renders the same `@shared/ui` components three times: under musubi's mapping,
inside a `div` carrying cire's ramp as inline `--ui-*` custom properties, and
inside one that sets every token to `initial` so the fallbacks show. Only
`inline` makes the second and third columns differ from the first — see
[[component-lab]].

### Fallbacks inline, and no `:root` in the package

Every read is `var(--ui-x, <fallback>)` written at the use site. There is
deliberately **no `:root` block in `tokens.css`**: a package-level `:root` is
unlayered and lands at the import site, so it would beat an app mapping written
inside `@layer base` or a later `@theme` — the app would set a token and
silently get the library's value.

The fallbacks are a neutral greyscale, never a brand. An unmapped app renders
**legibly rather than correctly**, which is the intended failure.

### `base:` belongs to a component, not to a caller

`@custom-variant base (:where(&))` gives a component zero-specificity defaults,
so a caller's plain utility beats them. A caller who writes `base:` too **ties**,
and a tie resolves by Tailwind's stylesheet order — not by class-attribute
order, and not by anything visible at the call site. See
[[component-library]] §Overriding a `Modal` default, which is
where that cost nine call sites.

### What `@source` names, and what it leaves out

`tokens.css` declares four paths — `../../ui/src`, `../../../osn/auth-ui/src`,
`../../toast/src`, `../../sortable/src` — so importing the contract is enough
to scan every shared package that renders inside an app. They resolve against
the file's own real path rather than through the `node_modules` symlink, which
is what lets one of them reach out of `shared/` into `osn/`. `@shared/toast`
and `@shared/sortable` spell no contract utility today; the entries cost a
directory walk and mean neither has to edit five apps' CSS the first time one
does.

`@cire/ui` is not among them. It is one product's house layer, and the four
cire apps each declare `@source "../../../ui/src"` for it in their own global
CSS. A path to it in the shared contract would instead make musubi and pulse
scan cire's components on every build.

## The conformance harness

`@shared/design-tokens` exports `contrastPairs()` and
`assertContractConformance()`. Every app calls it from its own suite: the
harness resolves the app's mapping and checks each foreground/background pair
against WCAG 2.2 — 4.5:1 for text (SC 1.4.3), 3:1 for non-text and focus
indicators (SC 1.4.11).

This is not ceremony. Deriving the first four mappings surfaced **13 pre-existing
contrast defects**, including cire's primary button at 2.42:1 with a light label
and 1.80:1 on dark hover, and pulse's focus ring at 2.38:1 — a ring nobody can
see removes the feature outright for a keyboard user.

> [!warning]
> The harness checks the **tokens**. It cannot see a component that hard-codes a
> colour, an app utility used inside a library package, or a class Tailwind
> never compiled. Those need the browser tier
> ([[browser-tests]]), and in the case of raw palette colours,
> `@shadcn/lint`'s `no-raw-colors`.

The same pairs can be _looked at_: `design-system/contrast` in the lab lays them
out as a matrix and measures each ratio from the painted cell in whichever theme
is on, which is the reading the harness — working from the stylesheet — cannot
take. See [[component-lab]].

## Where the pieces live

| Package                 | What                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@shared/design-tokens` | `tokens.css` (the contract), the conformance harness, and `CONTRACT_SCALES` / `SCALE_MIGRATION` which the scale codemod reads                                                                                                                                         |
| `@shared/color`         | The OKLCH maths — parsing, conversion, contrast, `ensureContrast`. Lifted out of `@cire/theme` so no `@shared/*` package depends on a `@cire/*` one                                                                                                                   |
| `@shared/ui`            | The primitives — `Button`, `Card`, `Modal`, `Field`, the rest — painted entirely in `ui-*` utilities                                                                                                                                                                  |
| `@osn/auth-ui`          | The OSN auth views. Built out of `@shared/ui` primitives, so it inherits the contract through them — but its own class attributes still name the shadcn vocabulary, so it renders correctly only in an app that speaks it. `@musubi/social` is the one consumer today. Its rules: [`osn/auth-ui/DESIGN.md`](../../osn/auth-ui/DESIGN.md) |
| `@cire/ui`              | cire's house components — see [[component-library]] for why two layers rather than one                                                                                                                                                                                |
| `@shared/toast`         | Its own `--toast-*` properties in plain CSS, mapped once per app — the arrangement this contract generalises. See [[toast]]                                                                                                                                           |

`scripts/codemod-scale.ts` is the migration tool: it rewrites static arbitrary
values (`text-[13px]`) onto the nearest scale step and **skips computed ones**
(`var`, `calc`, `clamp`, `min`, `max`, gradients), printing every skip by name.
It ran once across all six apps, moving 1,021 values.

_Measured 2026-09-16 — `bun run scripts/codemod-scale.ts`, whose own report
prints the counts._
