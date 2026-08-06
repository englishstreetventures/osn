# Host portal — design system

The visual system for `@cire/organiser` (`host.cireweddings.com`). Everything here
is implemented in `src/styles/global.css`; this file records the decisions and
the contracts, so a change to a colour can be checked against what the colour was
for.

The guest site (`@cire/web`) and the marketing site (`@cire/landing`) have their
own look and do not share this one. **The invite is a printed thing; the portal is
the desk it was made on.**

---

## 1. The one design law

> **The container is continuous; only its contents change.**

When a host moves between modules, sub-tabs, or steps of the invite builder, the
panel does not unmount and remount. It keeps its box, animates its height to the
new content, and cross-fades what is inside. Nothing in the chrome may jump.

Every motion decision below follows from this. Where a transition would need the
frame to disappear and come back, the transition is wrong, not the frame.

---

## 2. Colour

### Two ramps, one mechanism

Every colour in the portal is a custom property on `:root`. Tailwind's colour
utilities are `@theme` aliases onto those properties. Switching theme re-points
the properties; no component knows a theme exists.

```
:root                                       → dark (the house look, the default)
@media (prefers-color-scheme: light)
  :root:not([data-theme])                   → light, for a first visit with no stored choice
:root[data-theme="light"]                   → light, explicitly chosen
```

The attribute selectors come last, so an explicit choice always beats the system
preference. `data-theme="dark"` needs no block of its own — it falls through to
the base `:root`.

Authored in **OKLCH**, because the ramps are built by moving lightness at a fixed
hue. The same moves in sRGB hex shift hue, and the greens drift blue.

### `@theme`, never `@theme inline`

`@theme inline` pastes the value straight into each utility and stops emitting
`--color-*` as a real custom property. Two things in this app depend on those
properties existing:

- the invite preview — `previews.tsx` and `PaletteField.tsx` write
  `style={{ color: "var(--color-gold)" }}` and rely on the *nearest* scope
  defining it (the invite's own palette inside a preview, the portal's ramp
  outside one);
- anything reading a token from JavaScript through `getComputedStyle`.

A non-inline `@theme` whose values are `var()` still re-themes live, because the
resolution happens where the utility is used, not where it is declared.

The block is also `@theme static`. Tailwind emits only the theme variables it can
see a utility using, and it reads source as text — a token spelled only inside a
`style={{ … }}` object is invisible to it. Every such token currently happens to
be used as a class somewhere too, which means the invite preview works by luck;
`static` emits the whole block and takes the luck out.

### The tokens

| Token | Role |
|---|---|
| `--bg` | the page |
| `--bg-deep` | what the page recedes to behind a sticky bar or under a scrim |
| `--surface` | a card |
| `--surface-raised` | a menu or popover above a card |
| `--surface-sunk` | a well — an input, a code block |
| `--border` | a hairline; decoration only, **no contrast contract** |
| `--border-strong` | the visible boundary of an unfilled control; **≥ 3:1** |
| `--text` | body ink; **≥ 4.5:1** |
| `--text-muted` | secondary ink; **≥ 4.5:1** |
| `--text-faint` | large text, ornament, disabled; **≥ 3:1** |
| `--brand` | a *fill* — a primary button's ground, an active row's wash |
| `--brand-hi` | the hover fill |
| `--brand-ink` | the brand as readable ink on a ground |
| `--brand-wash` | the brand at low alpha behind an active row |
| `--on-brand` | what sits on top of a brand fill |
| `--gold` | metal — rules, ornament, the seal |
| `--gold-dim` | the same metal, fading out |
| `--gold-ink` | gold as readable ink; **≥ 4.5:1** |
| `--success` / `--warn` / `--error` | status; separate from the accent, as status colour always should be |
| `--focus` | the focus ring |
| `--inner-lip`, `--elev-1`, `--elev-2` | depth |

Three of these are worth stating outright, because they are the ones that get
misused:

**Only two border tokens.** `--border` is a hairline and is held to no contrast
floor, because a card is told apart by its surface, not by its edge.
`--border-strong` is the boundary of a control that has no fill, and clears 3:1
on both grounds. A third "control border" token was considered and rejected: two
is the number a reviewer can hold in their head.

**Gold is metal; `gold-ink` is ink.** `--gold` is for rules, ornament and the
seal, and must never carry readable text. On the light cream ground it measures
about 2.4:1. Anything a host has to read that wants to be gold uses `--gold-ink`.

**`--focus` is its own token, not an alias of gold.** Gold is unreadable on the
light ground and a focus indicator has a 3:1 floor. So focus is gold in dark and
brand green in light.

### The contrast contract

`src/styles/tokens.test.ts` parses the stylesheet — not a duplicated table — and
asserts every pair. It does two things a naive check does not:

- **Composites alpha.** Half the ink tokens are translucent, and `contrastOklch`
  ignores alpha by design. Each translucent token is blended over its actual
  ground in sRGB before it is measured, which is what a browser does.
- **Only asserts what has a contract.** `--gold` is absent by design.
  `--brand-hi` is a hover fill, so what is asserted is `--on-brand` on it, not it
  on the page.

It also asserts the two light blocks — the media-query copy and the attribute
copy — have not drifted apart, since they are hand-duplicated.

### Why these colours

The brief asked for `#2F4B26` as the dark green. Measured, that is L38% — nearly
double the page ground the portal already used. It became the **brand** token: a
fill for buttons and active rows, on a deeper evergreen page beneath it.

The brief asked for `#DBDBDB` as a cream. Measured, that is a pure neutral grey
with zero chroma. The light ground is a shade below it and carries a trace of the
accent's hue, so it reads warm rather than grey, and so an unintended light mode
at night is not a flashbang.

`#63585E` is the light mode's muted ink and its border hue — a secondary role.
Green carries buttons and active states in both themes.

---

## 3. Type

Two families, both self-hosted at build time by Astro's Fonts API
(`astro.config.mjs`). The portal used to link `fonts.googleapis.com`, which cost
a DNS lookup, a TLS handshake and a render-blocking round trip to a third party
before a signed-in dashboard could paint — and told Google about every host who
opened it.

| Family | Variable | Tailwind | Used for |
|---|---|---|---|
| Schibsted Grotesk | `--font-ui` | `font-body` | everything |
| Cormorant Garamond | `--font-flair` | `font-display` | the wordmark, a wedding's name, the invite preview |

Cormorant is **rationed to three things**. A portal is read as data — guest
tables, budget columns, RSVP counts — so the working face is a grotesque with real
tabular numerals, not the invite's stationery serif.

This is a deliberate divergence from `cire/web` and `cire/landing`, which are
Cormorant + Lato throughout. Lato is gone from the portal.

Two rules in `@layer base`:

- `table`, `time` and `[data-numeric]` get `font-variant-numeric: tabular-nums`.
  Cheaper and more reliable than a second numeric family.
- `h1`–`h4` are always roman. Cormorant's italic is lovely in running copy and
  wrong as a heading face — it reads as decoration rather than hierarchy, and it
  clips descenders at the leading these headings use. Emphasis is carried by
  weight, gold and rules instead.

---

## 4. Shape, depth, motion

**Radius.** One scale, sharp end of the range: `hair` 2px, `sm` 4px, `md` 6px,
`pill` 999px. The house look is stationery, not app-store chrome — nothing
rounder than 6px except pills.

**Depth.** `--inner-lip` is a single inner highlight along the top edge of a
raised surface. It is the one trick that makes a flat card read as a lit object
rather than a rectangle. `--elev-1` and `--elev-2` are the two drop shadows.

**Motion.** Three durations and two easings, and **no animation library in this
package by design**.

```css
--dur-fast: calc(120ms * var(--motion-scale));   /* a hover, a press */
--dur-base: calc(200ms * var(--motion-scale));   /* a panel swap, a pill slide */
--dur-slow: calc(320ms * var(--motion-scale));   /* a sheet, a modal */
--ease-out:    cubic-bezier(0.22, 1, 0.36, 1);   /* something arriving */
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);   /* something moving between two places */
```

Every duration is scaled by `--motion-scale`, so the fixtures page can slow the
whole app to 0.1× and a reference behaviour can be judged frame by frame. Nothing
in the app itself writes it.

`prefers-reduced-motion: reduce` is a global kill switch in `@layer base`, not a
per-component branch. It sets `transition-duration` and `animation-duration` with
`!important`, which beats an inline style — so a hook that writes a duration
inline still stops, and no hook needs a `matchMedia` check of its own.

Two hooks carry the design law of §1, both in `src/lib/`:

- **`createAutoSize`** — animates a frame between its own heights, then hands the
  height back to the content. It holds **nothing at rest**: no pixel height
  survives the transition, so a resized window, a changed font size or a late
  image never fights a stale number. The measured wrapper is a `flow-root`, so a
  child's top margin cannot escape it and change the answer depending on whether
  the frame was clipped at the time.
- **`createSlidingPill`** — moves one highlight between tabs instead of
  cross-fading one highlight per tab. That is what makes a strip read as a single
  control rather than a row of them. The pill's row must be `relative`: an
  absolutely positioned element paints above non-positioned siblings in the same
  stacking context, and without it the underlay covers its own labels.

The sheet variant of the module nav deliberately gets no pill. A pill measures a
strip the eye can see all of at once, and a sheet is a list.

**Focus.** One ring for the whole dashboard: 2px solid `--focus`, 2px offset,
never animated, never removed — the shell is keyboard-driven. It deliberately
sets no `border-radius`: the outline already follows whatever radius the element
has, and setting one would square off pill-shaped controls for as long as they
hold focus.

---

## 5. Layout

The portal has two jobs to do with width, and they want different tools.

**Container queries** decide *shape* — rail or sheet, one column or two, agenda
above the stats or beside them. Named containers: `@container/frame`, `/page`,
`/shell`, `/panel`, `/builder`, `/card`, `/enquiries`. There are **no viewport
media queries in the shell**. Each surface measures the box it was actually
given, so a 600px-wide panel behaves like a phone even on a 2560px monitor.

**Intrinsic values** decide *scale*, through two utilities:

- `page-frame` — the page's own width. Gutters grow with the frame's inline size;
  the measure runs to `--page-max` (default 100rem). The top bar and everything
  under it both wear it, so the bar's hairline reads as a margin line rather than
  a floating divider.
- `auto-grid` — as many whole columns of at least `--auto-grid-min` as fit, then
  equal shares of the remainder. Two invariants are load-bearing and documented at
  the utility: **no `col-span-*` on a child**, and **the track minimum must stay a
  fixed length**.

`src/styles/layout-utilities.test.ts` guards both utility names and every custom
property they read. Tailwind ignores an unknown class and CSS ignores a custom
property nobody reads, so the failure mode is 17 grids quietly collapsing to one
column with the suite green.

**Ornament.** `gilt-rule` — a rule that is a gradient rather than a flat line,
brightest in the middle where the eye lands. The only place gold touches a
full-width element.

---

## 6. Theme preference

Three states, not two: `system`, `dark`, `light` (`src/lib/theme.ts`).

Collapsing "system" into "dark" would silently convert a host who follows their
OS into a host pinned to dark, the moment they opened the menu to look at it.

`src/lib/theme-boot.ts` holds a zero-import boot script, inlined in `<head>`
before the stylesheet on every page. It has to run before first paint — a host
who chose light and gets one frame of dark has been flashbanged in the other
direction, which is the whole thing the light ramp was tuned to avoid. It is its
own module with no imports so that `.astro` frontmatter can import it without
dragging SolidJS and a module-scope signal graph into Astro's server bundle.

Every failure in it resolves to a theme rather than an exception: `localStorage`
throws outright in some private-browsing modes, and a browser with no `matchMedia`
is given the house dark.

---

## 7. Components

`src/components/ui/` holds the parts every module is built from. They are
class-mapping components: they own a look and its variants, and almost no
behaviour. A part that grows real behaviour takes its own file with it.

There is no `clsx`, no `tailwind-merge` and no `cva` in this package. Classes are
plain template literals, because Tailwind's scanner reads source as text and a
class that is computed at runtime emits no CSS at all — silently. Composition is
by variant map, and the caller's own `class` is appended last.

| Part | What it is |
| --- | --- |
| `Button` | Four variants — `primary`, `outline`, `quiet`, `danger` — and three sizes, `sm`, `md`, `icon`. `type="button"` is set **before** the spread, so a toolbar control inside a settings form does not submit it, and a caller who means `submit` can still say so. |
| `Card`, `cardClass`, `CardEyebrow`, `CardCta` | The raised surface, plus its two furnishings. `cardClass` is exported so a surface that has to be an `<a>` or a `<button>` gets the same look without wrapping. The `interactive` option adds the hover treatment — which is a promise that the whole rectangle is clickable, so a card that is not a control must not wear it. |
| `Notice` | Four tones. Error, warn and success each carry a distinct glyph plus an `sr-only` word; `info` is unmarked, because nothing has happened. `alert` opts into `role="alert"` and is for a note that appeared **in answer to something** — a standing note that was on screen before the host arrived has nothing to interrupt anyone about. |
| `EmptyState` | A title, an optional line of prose, and the one thing to do about it. |
| `Meter`, `meterPct` | A thin bar. Scaled by transform rather than resized — see the file. `meterPct` clamps at both ends and reads a zero or missing maximum as empty, not as a division by zero. |
| `Stat` | A figure, then what it is, then an optional hint. |
| `Table`, `Th`, `Td` | The five tables as one set of parts. The wrapper scrolls so the page never does, and it is a named, focusable `<section>` so the columns past the right edge are reachable without a mouse. `label` is required. |

### Two rules that apply to all of them

**Anything spread onto an element takes `SafeProps`.** Solid's `HTMLAttributes`
includes `innerHTML`, `innerText` and `textContent`, and dom-expressions assigns
`innerHTML` unescaped. `SafeProps<E>` (`src/components/ui/props.ts`) is
`ComponentProps<E>` with those three removed, so a call site cannot pass
unsanitised markup through a primitive without noticing.

**Colour never carries a meaning on its own.** The error and warn tones are the
closest pair in the palette, and about one host in twelve cannot tell them apart.
Every state that reports an outcome pairs its hue with a shape and a word.

### Testing them

`ui.test.tsx` asserts what a call site can rely on — that the variants differ
from each other, that props reach the DOM, that the accessibility wiring is
there, and that the one piece of arithmetic in the set is right. It does not
assert class strings: that pins the current answer rather than the contract, and
turns every move of the design into a test edit.
