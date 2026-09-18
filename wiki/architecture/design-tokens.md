---
title: Design tokens — the contract every shared component reads
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
last-reviewed: 2026-09-18
---

# Design tokens — `@shared/design-tokens` and the `ui-*` contract

One neutral vocabulary that the shared component packages write and every app
maps onto once. Colour roles, plus type, tracking, leading, radius and measure
scales.

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
   `@osn/auth-ui` write `ui-*` utilities. Application code never does — every
   `bg-card` in pulse and `text-gold` in cire stays exactly as written.
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
`rounded-ui-hair` … `pill` plus the two role radii `rounded-ui-control` and
`rounded-ui-sheet`, `font-ui-body` /
`-display` / `-mono`, and the measure scale `max-w-ui-xs` … `3xl` — declared
as `--container-ui-*`, which is the namespace Tailwind reads a `max-w-*` from.

Three groups sit outside `@theme` as plain custom properties, because a
component consumes them inside its own rule rather than as a utility:
`--ui-focus-width` / `--ui-focus-offset`, the motion tokens
(`--ui-dur-fast|base|slow`, `--ui-ease-out|in-out`) and `--ui-elev-1|2`.
Aliasing those would generate utilities nobody spells. `CONTRACT_COLOR_TOKENS`
and `CONTRACT_SCALAR_TOKENS` in `src/index.ts` are the enumerable form of both
lists, and `tests/tokens-css-agrees.test.ts` fails if they and `tokens.css`
drift apart.

**`control` and `sheet` are roles, not sizes**, the same way `focus` is its own
colour rather than an alias of the accent. How round a _button_ is turns out to
be independent of how round a card is — musubi's house style is pill CTAs,
cire's a sharp 4px — and so is how pronounced the top edge of a _bottom sheet_
is, where cire wants 28px against its own 10px cards. Both default to a sized
step (`control` to `md`, `sheet` to `lg`), so an app with no opinion gets its own
value rather than one from the package.

Two names are worth reading twice. **`ground-deep` is not "darker"** — it is
what the page recedes _to_, behind a sticky bar or under a scrim, and on a dark
theme it is lighter. **`accent-ink` is not `on-accent`**: `accent-ink` is accent
text on the page, `on-accent` is the label on a filled accent ground, and the
two have opposite contrast requirements.

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
[[wiki/architecture/component-library]] §Overriding a `Modal` default, which is
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
> ([[wiki/conventions/browser-tests]]), and in the case of raw palette colours,
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
| `@osn/auth-ui`          | The OSN auth views. Built out of `@shared/ui` primitives, so it inherits the contract through them — but its own class attributes still name the shadcn vocabulary, so it renders correctly only in an app that speaks it. `@musubi/social` is the one consumer today |
| `@cire/ui`              | cire's house components — see [[wiki/architecture/component-library]] for why two layers rather than one                                                                                                                                                              |
| `@shared/toast`         | Its own `--toast-*` properties in plain CSS, mapped once per app — the arrangement this contract generalises. See [[toast]]                                                                                                                                           |

`scripts/codemod-scale.ts` is the migration tool: it rewrites static arbitrary
values (`text-[13px]`) onto the nearest scale step and **skips computed ones**
(`var`, `calc`, `clamp`, `min`, `max`, gradients), printing every skip by name.
It ran once across all six apps, moving 1,021 values.

_Measured 2026-09-16 — `bun run scripts/codemod-scale.ts`, whose own report
prints the counts._
