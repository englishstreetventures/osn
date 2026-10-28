# Host portal — design system

The visual system for `@cire/host` (`host.cireweddings.com`). Everything here
is implemented in `src/styles/global.css`; this file records the decisions and
the contracts, so a change to a colour can be checked against what the colour was
for.

The guest site (`@cire/invites`) and the marketing site (`@cire/landing`) have their
own look and do not share this one. **The invite is a printed thing; the portal is
the desk it was made on.**

---

## 1. The one design law

> **The container is continuous; only its contents change.**

When a host moves between modules, sub-tabs, or steps of the invite builder, the
panel does not unmount and remount. It keeps its box, animates its height to the
new content, and cross-fades what is inside. Nothing in the chrome may jump: the
module's view bar animates its height with the panel's (§The stuck stack).

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
| `--status-yes`, `--status-no`, `--status-maybe` | the fills of a status mark's circle (§Status marks); opaque |
| `--status-no-ink`, `--status-maybe-ink` | the glyph on the red and tint circles; **≥ 4.5:1** on its circle |
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

`tests/styles/tokens.test.ts` parses the stylesheet — not a duplicated table — and
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

This is a deliberate divergence from `cire/invites` and `cire/landing`, which are
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

**Motion.** Three durations and three easings, and **no animation library in
this package by design**.

```css
--dur-fast: calc(120ms * var(--motion-scale));   /* a hover, a press */
--dur-base: calc(200ms * var(--motion-scale));   /* a panel swap, a pill slide */
--dur-slow: calc(320ms * var(--motion-scale));   /* a sheet, a modal */
--ease-out:    cubic-bezier(0.22, 1, 0.36, 1);   /* something arriving */
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);   /* something moving between two places */
--ease-spring: linear(0, 0.055, …, 1.083, …, 1); /* something landing with a little give */
```

`--ease-spring` is a damped spring (damping ratio 0.62) sampled into `linear()`:
it overshoots by 8% at about 40% of the run and settles. The browser floor
(Chrome 111, Safari 16.4) has no `linear()`, and an easing it cannot parse voids
the whole `animation` declaration, so `@theme` declares a one-overshoot
`cubic-bezier` and an unlayered `@supports` block swaps the spring in. It is for
small things arriving — a popover, a tick — never for a sheet or a page, which
should not bounce.

**The ladder follows the input, not the screen.** With a fine pointer — a mouse
or a trackpad, at a desk — an organiser waits on every popover and panel before
the next click, so `@media (pointer: fine)` shortens the ladder to 90 / 150 /
200ms. On touch the ladder above stays: a phone is held, not worked at. The
query reads the *primary* pointer, so a touch laptop driven by its trackpad
gets the desk pace. `Modal` (`@shared/ui`) takes its two durations from the same
ladder through `--ui-modal-enter` and `--ui-modal-exit`, set under the same
query. A new motion reaches for a `--dur-*` token, never a literal or
Tailwind's bare 150ms `transition`, so it follows the input with everything
else.

Every duration is scaled by `--motion-scale`, so a reference behaviour can be
slowed to 0.1× and judged frame by frame. Nothing in the app itself writes it.

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

**The droplet.** A checklist row's popovers — the assign popover and the
time editor — grow out of the control that opened them (`droplet-popover`,
`droplet-popover-body`): a small round drop at the trigger springs out to the
panel (`droplet-grow`, `--ease-spring`) while its corners square off
(`droplet-round`, `--ease-out`), and the contents fade in once there is room.
`transform-origin` is Kobalte's `--kb-popover-content-transform-origin`, the
panel's corner at the trigger whichever side it opened on. The fade is timed by
keyframe percentage, never by `animation-delay`: the reduced-motion switch zeroes
durations and leaves delays alone, so a delay would hold the list back from a
reader who asked for no motion. A true "goo" — an SVG filter melting the panel
out of the trigger — is not done: the panel portals to `<body>`, away from the
trigger, and the filter would blur its border and shadow. The exit is a quick
shrink and fade, as keyframes, because Kobalte keeps a closing popover mounted
until its animation ends.

**Every other menu and picker pops.** The profile menu, the wedding switcher,
the date and colour pickers, the seat menu and the module card carry
`menu-pop`: a short scale-and-fade from the side of the trigger they opened on
(`--kb-popper-content-transform-origin`, which Kobalte sets for popovers and
menus alike), with no overshoot. It has no exit: these menus are worked from
the keyboard, and a closing menu held mounted for an exit animation keeps
focus inside it, so Kobalte's hand-back to the trigger falls to `<body>`. A new
Kobalte popover or menu takes `menu-pop` unless it belongs to a checklist row.

**A disclosure fades open and closes at once.** A `<details>` body drops 4px and
fades in on `::details-content`; it closes instantly, because a fading body
leaves its controls focusable in a box that is going away. The fade sits inside
`prefers-reduced-motion: no-preference`: the global switch selects `*`, which
reaches no pseudo-element.

**A toggled box that is not in the top layer fades out in CSS alone.**
`transition-behavior: allow-discrete` holds `display` until an opacity fade has
run, and `@starting-style` gives the opening its from-state — the invite
builder's section menu (`section-menu`) is the pattern. A dialog or popover in
the top layer cannot do this in Safari or Firefox: leaving the top layer needs
`overlay`, which is Chrome only, so `Modal` defers `close()` in script instead.

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
`/shell`, `/panel`, `/builder`, `/card`, `/enquiries`, `/run-sheet`. There are **no viewport
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

`tests/styles/layout-utilities.test.ts` guards both utility names and every custom
property they read. Tailwind ignores an unknown class and CSS ignores a custom
property nobody reads, so the failure mode is 17 grids quietly collapsing to one
column with the suite green.

**Ornament.** `gilt-rule` — a rule that is a gradient rather than a flat line,
brightest in the middle where the eye lands. The only place gold touches a
full-width element.

**Print sheet.** A view with a paper form — the seating chart, for the venue —
renders it into a `[data-print-sheet]` child of `<body>` through a portal, and
marks `<html>` with the same attribute, both from `beforeprint` to `afterprint`
only; the sheet is hidden on screen for the moment it exists there.
Printing then prints the sheet alone: the stylesheet hides every other child of
`<body>`. The switch is on `<html>`, not `body:has(…)`, which the Firefox floor
does not support, and the screen rule names `body > [data-print-sheet]`, never
the bare attribute, which `<html>` also carries. Paper is black ink on white in
the working face whatever the screen theme is — the one place the portal writes
literal colours rather than tokens, since a ramp means nothing on paper. Each
table is kept whole on a page where it fits. `SeatingView.browser.test.tsx`
checks it under print media.

### The rail, collapsed

The module rail collapses to its icons from a toggle at its top, and back.
Each choice, and what it was weighed against:

- **An icon rail, not a hidden or off-canvas one.** Collapsed, the rail is
  2.625rem: the row's own `px-3` around the 1.125rem icon, so no icon moves as
  it narrows (§1). The active row keeps its icon, pill and bar, and locked rows
  stay dimmer than the rest, so the organiser still sees where they are and
  still reaches any module in one click. A rail hidden outright makes every
  move two clicks and drops the "you are here" mark; an off-canvas drawer at
  desktop is the phone's sheet, a modal per move.
- **A collapsed icon reads at 3:1.** Collapsed, the icon is the only mark a row
  shows, so it is held to the 3:1 WCAG asks of a graphic that identifies a
  control: it drops the `opacity-80` fade it wears beside a label, and the
  active one is `--gold-ink`, since `--gold` has no contrast contract (§2) and
  falls short of 3:1 on the pill's wash in the light theme. A locked icon stays
  in `--text-faint`, which clears 3:1 at full strength and still reads dimmer
  than an idle one.
- **Every row keeps its place.** A collapsed label stays in the row's flow at
  no width, with the gap before it gone. `sr-only` would take the label's line
  box, which is taller than the icon, out of the row, and every row below would
  rise — Settings, the last, by about 17px.
- **The toggle sits at the rail's top** — the owner's choice — above the first
  module and a hairline, in the icons' column and outside the `<nav>`, which
  holds the modules alone. It stays in that one place in both states, so after
  a click it is still under the pointer and a second click undoes the first.
  It is icon-only in both states (`panel-left-close`, `panel-left-open`), so it
  never reads as one more module.
- **The toggle comes first in the tab order.** Focus follows what is on screen
  (WCAG 2.4.3 focus order, 1.3.2 meaningful sequence): a toggle drawn above the
  modules but reached after them, by CSS `order` or a `tabindex`, would send
  keyboard focus back up the rail. It is also the order a reader meets the
  controls in — the control that changes the list, then the list. The cost is
  one Tab stop before Overview on every keyboard pass through the rail; a
  keyboard user who never collapses it pays that stop and nothing more.
- **Its name changes with the state, and it keeps `aria-expanded`.** "Collapse
  sidebar" and "Expand sidebar" are also the words its tooltip shows, so voice
  control can say what it sees; `aria-expanded` is there because a screen
  reader announces a changed state on a focused button where it often skips a
  changed name. The cost: a screen reader hears both ("Expand sidebar,
  collapsed").
- **Labels move into a tooltip.** On the collapsed rail a row shows a Kobalte
  tooltip 8px to the right of the rail: the label, then the module's hint in
  `--text-muted`, or for a locked row "Included with <Tier>" in `--gold-ink`.
  It is `--surface-raised` with a `--border` hairline, radius `sm`,
  `shadow-md`, and `z-50`: Kobalte copies the content's `z-index` onto the
  element it positions, and without one the tooltip paints under the top bar.
  It opens after 300ms of hover, so a pointer crossing the rail opens nothing,
  and at once on keyboard focus; never on touch. It is for the eye only:
  `aria-hidden`, and nothing points at it. A collapsed row's name is still its
  label and its description still its hint — a hidden copy it points at, where
  the expanded row uses `title` — so a screen reader hears the same in both
  states. `@shared/ui`'s `Tooltip` does not fit: its trigger is a span that
  takes no focus.
- **On the collapsed rail a locked card opens on a press and closes on the
  next** — the owner's choice. On the expanded rail, a pointer resting three
  seconds on a locked row also opens its card. Collapsed, the tooltip names the
  tier after 300ms, and a card in the same place three seconds later would say
  it again, so there is no dwell: a click, Enter or Space opens the card, a
  second click on the same row closes it, and Escape closes it and puts focus
  back on the row. No tooltip shows while any card is open.
- **Motion.** On a press, the rail's `width` transitions over `--dur-base` with
  `--ease-in-out`, something moving between two places. Only on a press: the
  expanded width also steps at `@5xl/shell` (a resize, zoom, a scrollbar
  arriving), and that lands at once, as everything else in the shell does, so
  the transition is on the rail only while a press's slide runs. The labels
  fade back in as it widens (`rail-label`, held for the first 40% by keyframe
  percentage), and a tooltip arrives with a `--dur-fast` fade and a 4px slide
  out of the rail (`rail-tip`) and leaves at once. The reduced-motion switch
  stops all three. The panel reflows on every frame of the slide. Holding the
  panel's width through the slide was rejected: expanding would push the held
  content under the frame's edge and then snap, which §1 forbids.

  Over a 300-guest RSVP table, the slide each way takes 24–25 frames, the
  longest 9.4–21.9ms and the median 8.3ms.

  *Measured 2026-10-28 — `VITE_RAIL_SLIDE_BENCH=1 bunx --bun vitest run --project browser tests/components/ModuleSidebar.collapse.browser.test.tsx -t "frame by frame" --reporter=verbose` in `cire/host`, headless Chromium on a 120Hz Mac, two runs*
- **Remembered per browser.** `localStorage` key `cire.host.rail`, value
  `collapsed` (`src/lib/rail-preference.ts`); expanding removes the key. It is
  read as the sidebar is created, so a collapsed page paints collapsed and never
  slides on load, and every storage failure reads as expanded. Per browser, not
  per wedding: the choice is about the screen.
- **The sheet ignores it.** Below `@2xl/shell` the sheet stands in for the rail
  and shows every label; the toggle lives inside the rail, which is not laid out
  there.
- **No keyboard shortcut and no palette entry.** A single key or a chord risks
  clashing with the browser and with screen readers, and the palette does not
  know whether the rail or the sheet is showing.
- **The rail sticks under the top bar**, at `top-[calc(5.5rem+1px)]`: the bar's
  4rem and hairline at every width that has a rail, plus 1.5rem. A smaller
  offset slides the rail's first rows under the bar once the page scrolls.

`ModuleSidebar.collapse.browser.test.tsx` checks the places, the icon and
tooltip ink, the tooltip, the names and the motion in Chromium; the
`cire-checklist-starter` end-to-end flow checks the toggle, the stored choice
across a reload, a locked card opened and closed from the narrow rail and the rail
sticking below the real top bar.

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

The parts every module is built from come from `@shared/ui`
(`shared/ui/src/ui/`), with `Button` and `Card` from `@cire/ui`. They are
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
| `Table`, `Th`, `Td` | Every table in the portal as one set of parts. By default the wrapper scrolls so the page never does, and it is a named, focusable `<section>` so the columns past the right edge are reachable without a mouse; `label` is required. `scroll="page"` clips instead and lets the page scroll, for a table whose head row sticks under the stuck stack (§A table that scrolls with the page). `frame="none"` drops the border for a table inside something that draws its edge. `Th` and `Td` take `pin` for a head row or first column held in view; `Th srOnly` keeps a head for assistive technology under a visible copy. |

### Who holds a task: faces, not names

A checklist row shows its holders as an overlapping stack of faces
(`TaskHolders.tsx`, `PersonAvatar.tsx`). The decisions it settles, for any
later stack of people:

- **Faces are 28px on a row and 32px in a list**, overlapping by 8px, each with
  a 2px ring in the page's colour standing in for the gap. Every layer is
  positioned, so they paint in document order and each covers the edge of the
  one before it; a layer left static paints under all of them.
- **Three faces, then a count.** "+N" is a disc of `--surface-raised` with a
  `--border-strong` edge and `--text` figures. A layer after it covers its edge
  as it covers a face's — the 8px overlap and that layer's 2px ring — so the
  count holds that strip as padding at its inline end, and its figures keep 7px
  clear of the +'s ring at any width, two digits included. So before an
  editor's + the count is always a pill, while a viewer's, with nothing after
  it, is a disc with its figures centred until they need more room. Nothing may
  cover a figure: a last digit touching the dotted circle reads as part of it.
- **The reader comes first** when they are among the people shown.
- **A person with no photo, or one that will not load, gets the empty avatar** —
  their outline in `--bg`, cut out of a disc of `--text-faint` laid over `--bg`
  so it is opaque (the `blank-avatar` utility). A light figure on a mid disc in
  light, a dark one in dark: nobody's photo in either ramp. **Never initials**:
  on a stack, letters read as a list of codes. The photo itself is drawn only
  from an https URL, checked at the `<img>`.
- **The faces are pictures; the names are text.** Screen-reader text beside the
  stack reads "Held by Sam Lee and @jo"; each face's name shows on hover from
  an `aria-hidden` element, so it is not heard twice.
- **The control is a dotted circle holding a +**, in `--border-strong` (it is
  the boundary of an unfilled control), as the stack's top-right layer. It turns
  gold on hover and while its popover is open. Someone who cannot act sees the
  same dotted circle empty, and only where its absence would mislead — an open
  task nobody holds, never a done one.

The popover it opens is a listbox of toggles, the command palette's pattern
with `aria-multiselectable`: each row is a 20px circle — `--border-strong`
outline when off, a `--brand` fill with an `--on-brand` tick when on — then the
face, the name, and the role in muted ink. The focus stays in the search or on
the list, so the house ring never reaches a person: the highlighted one wears
the ring's mark instead — a 3px `--focus` bar at the row's inline start, at
3:1 or more on the panel in both ramps — with the name in `--gold-ink` over the
palette's `bg-gold/10` wash, which is far too faint to be the mark on its own.
What the list says beside its people — that it is
still looking, how many a search matches, that it matches nobody — is one
status line (`<output>`) under the list, never a row inside it: the listbox holds
options only. Five people show whole; above five a search
heads the list and it shows about four and a half rows, the half saying it
scrolls. The list draws the house focus ring inside its own edge, and the
search field turns its border and a 1px ring `--focus` while it has the focus:
the panel clips anything drawn outside it, for the droplet's rounded corners.
A popover that focuses something as it opens focuses it without scrolling, and
a list in it follows its highlight by setting its own `scrollTop`, never with
`scrollIntoView`, which scrolls the page as well: Kobalte opens the panel at the
page's top left and moves it beside its trigger a frame later, and anything that
scrolls toward the panel before then jumps the page up to that corner.

### A list inside a form: the event drawer's run of show

The event drawer holds one list a host builds item by item: the run of show
(`RunOfShowField` in `EventsEditor.tsx`). What it settles, for any later list
of short rows inside a drawer:

- **One row per item, in the house reorder pattern.** The grip, Arrow keys from
  it and the `sr-only` move buttons come from `createSortableList`, as on the
  events list itself, so the two lists in one editor move the same way. The
  grip leads the row; Remove (`bareDanger`, a ✕ with an `aria-label` naming the
  item) ends it. All four visible controls clear 24px. An item with no name yet
  is "item N" everywhere it is named: the grip's label, the move announcement
  and Remove.
- **The row wraps, and the fields keep a floor.** The time is a native
  `type="time"` input at a fixed 8.5rem; the name takes the rest with an 8rem
  floor, and drops under the time when there is no room for both. The fields
  together never shrink below 8.5rem, and the row itself wraps, so a move
  button revealed on focus, wider than the room beside the grip on a phone,
  pushes the fields and Remove onto the next line instead of sitting over
  them. At 390px a row at rest stays on one line; nothing scrolls sideways.
- **The labels are hidden, the fieldset is not.** Each control's label is
  "Time of item N" / "Item N", visually hidden, under a visible "Run of show
  (optional)" legend and one muted line naming the zone the times are in.
- **A consequence the host cannot see is said on the row.** The guest reads the
  list in time order from the event's start, so an item earlier on the clock
  than the start gets a muted line under it — it reads as after midnight — and
  the line is in its time input's `aria-describedby`. Muted ink, not warn: it
  is a fact about the list, and often the intended one.
- **Focus goes somewhere on purpose.** Add item is an `outline` button under
  the list, never inside it; a new item starts at the last item's time and
  focus moves to its name. Remove takes its own button with it, so focus moves
  to the next item's grip, else the previous item's, else Add item. The dress
  code's swatch Remove does the same with the swatch names and Add swatch.
- **An item's errors are said under it, once it is left.** "Item 4 needs a
  name." goes under that item's field, which `Field` marks `aria-invalid` and
  describes by it, not in the list of errors above the form. A new item's
  errors wait until focus leaves its row, so a row is not called wrong while it
  is being filled in; Save stays blocked meanwhile.
- **Two presets side by side, then a note.** The guest policy is two native
  `Select`s at 11rem minimum each: they share a row in the drawer at 1280px and
  stack on a phone, then a note. "Not stated" is the first option of each, not
  a blank one, because saying nothing is a choice the host makes.
- **The list's changes merge by item key.** Each edit patches the whole list;
  the draft reconciles it by key, so the row being typed in keeps its node and
  its focus.
- **Shown only to an API that stores it.** When the events read carries no run
  of show (an API older than it), the drawer leaves out the run of show,
  getting there and guest policy, rather than take what a save would drop.

The Events list (`EventTable`) shows the run of show as guests read it, by time
from the start, an item after midnight last and marked "(after midnight)"; the
drawer keeps the organiser's order. Its detail values wrap anywhere, so a link
in organiser text stays inside the card.

`EventsEditor.drawer.browser.test.tsx` measures the row at 390px and 1280px:
every control inside the drawer and at least 24px, no two controls overlapping
while a move button is focused, the after-midnight line on the right item and
describing its time, focus after Add and Remove, an item's error under it, and
the selects stacking on a phone. `EventTable.browser.test.tsx` keeps a long link
inside its card.

### The run sheet: the day on one thread

`RunSheetView.tsx` is the Run sheet module and the whole of a helper's seat.
It is read-only for every role. The decisions it settles:

- **Every time is on its own clock.** An event reads in its own zone, a task
  in `runTimezone` (its event's, when linked); the browser's zone never enters,
  so a helper abroad reads the times the day runs on. Rows are grouped under
  the local date each falls on there, in the API's order (by instant), with
  untimed tasks last under "Any time on the day". A day in one zone says so
  once beside its heading ("Times in AEST"); a day that mixes zones says "Each
  time on its own clock" and puts the zone under every time.
- **Day headings** are `h3`s in `--gold-ink`, body face, sentence case. Not
  Cormorant (rationed, §3), and not the checklist's tracked capitals: a date
  is several words, and Chrome hands a screen reader the transform.
- **The thread.** A day hangs on one vertical hairline of `--gold-dim` — metal,
  a rule, no contrast floor — down the middle of the gap between the time
  column and the words. Every row is a grid on three lengths (`--rs-pad`,
  `--rs-time`, `--rs-gap`, in `global.css`'s `run-sheet-*` utilities), so its
  marker sits on the thread whatever the row holds, level with the title's
  first line. Items align on their first baselines, so a `text-ui-sm` time
  reads on the line of a `text-ui-base` title. The time column is end-aligned:
  4.5rem, 5.5rem once the view is 36rem wide.
- **Events are bands, tasks are rows.** An event is a raised band
  (`--surface`, the hairline, the lip) marked by a gold diamond; it paints over
  the thread. A task is a transparent row marked by a bead: a hollow
  `--border-strong` ring when open, filled `--text-faint` when done, filled
  gold while coming up. An event's name carries a hidden "Event:".
- **An event's run of show rides inside its band**, under its name and place,
  so it moves with the event and is never mistaken for a task: no marker on
  the thread, no flags, nobody holding it, nothing to press. It is a list
  named "Run of show for <event>" on a `--border` hairline of its own, each
  item a `text-ui-sm` label after its time in a fixed 3.5rem column of muted
  `text-ui-xs`, end-aligned like the sheet's own times. The order and the
  marking are the guest's (`guestOrder`, as the Events list reads it): from the
  event's start on its own clock, an item earlier on the clock than the start
  last and marked "(after midnight)" in muted ink. Each time is the item's own
  `HH:MM` as the organiser wrote it, on the event's clock, never converted.
- **Flags are a word and a shape.** Sentence-case pills, never colour alone:
  "You" on a `--brand` fill, "Coming up" on a gold fill (`--on-gold` ink),
  "Done" in a `--border-strong` outline with a tick, "Event removed" in a
  `--warn` outline with a broken link, explained on hover by `Tooltip`. The
  two that are about the reader and about now are filled; the two that are
  states are outlined — "Coming up" and "Event removed" are both warm in the
  dark ramp, and the fill is what tells them apart at a glance.
- **The reader's rows** also carry a 3px `--brand-ink` bar at the row's
  inline start (3:1 or more on the row in both ramps), and `data-own`.
- **A coming-up row** sits on a `bg-gold/8` wash. **A done row** stays in its
  slot, its title struck through in `--text-muted`, its time muted.
- **Who holds a task** is the read-only avatar stack (above), in a third
  column once the view is 36rem wide and on a line under the words before.
  The view measures its own box (`@container/run-sheet`): in a helper's seat
  there is no panel to measure.
- **States.** Below Gold, and on a 402, an `info` `Notice` — "The run sheet
  isn't available for this wedding." — that names no plan: a helper cannot buy
  one. Any other refusal is a `warn` `Notice` with "Try again". Empty is an
  `EmptyState` worded by scope, with "Set times on the checklist" for an owner
  or editor. Loading is `PanelLoading`. A loaded sheet offers owners and
  editors "Change times on the checklist" (`quiet`, small) above the days.
- **A helper's seat** wears the panel header the module shell gives every
  module — the module's label, its hint, the gilt rule — so it reads as the
  same page an owner opens.
- **The clock never moves the focus.** "Coming up" is re-read on a timer set
  for the next flag change and when the tab becomes visible; nothing else
  changes on screen when it fires.

### A task's time on its row

`RunTimeEditor.tsx`, on each checklist row for an owner or editor, beside the
holders' stack:

- **The trigger is one node** whatever it shows, so a save keeps the focus on
  it. Untimed, it is an empty slot: a 28px dotted circle holding a clock,
  `--border-strong`, gold on hover and while open — the same mark as the
  holders' +, an empty place to fill. Timed, it is a pill holding a clock and
  the time on the task's own clock, with the zone after it in muted ink when
  that is not the reader's. A task whose event was removed shows its pill in
  `--warn` with a broken link. Its name says the time and the task: "1:30 pm,
  time for Greet the celebrant".
- **Anyone else** sees the same pill as text (`RunTimeChip`), and nothing on an
  untimed task.
- **On a narrow row** the time, the holders and delete wrap together onto a
  line of their own at the row's end once the title would fall under 8rem
  beside them: a title squeezed into a column of broken words is worse than a
  row one line taller.
- **The popover is a form**, so unlike the assign popover it is `modal`: Tab
  moves between its fields and stays inside, Escape closes it, and the focus
  goes back to the trigger. It does not lock the page's scroll. It grows as
  the droplet (§4), `w-80`, on `--surface-raised`.
- **Its fields**: Event (`No event — a fixed time`, then the events by start,
  each with its day and time); linked, a choice of "Before or after the start"
  (minutes, and before or after, with where that lands on the event's clock
  beneath) or "At a clock time" (date and time, with the event's zone named
  beneath and no zone field); unlinked, date, time and a time zone defaulting
  to the zone every event shares, else the browser's. "Clear time" shows only
  when there is a time to clear.
- **Saving** is never `disabled`: a disabled button drops the focus it holds.
  Save reads "Saving…" and is `aria-disabled` while the write is out. A refusal
  is a `danger` `Notice` in the popover, worded by cause.

### Two rules that apply to all of them

**Anything spread onto an element takes `SafeProps`.** Solid's `HTMLAttributes`
includes `innerHTML`, `innerText` and `textContent`, and dom-expressions assigns
`innerHTML` unescaped. `SafeProps<E>` (`shared/ui/src/ui/props.ts`) is
`ComponentProps<E>` with those three removed, so a call site cannot pass
unsanitised markup through a primitive without noticing.

**Colour never carries a meaning on its own.** The error and warn tones are the
closest pair in the palette, and about one host in twelve cannot tell them apart.
Every state that reports an outcome pairs its hue with a shape and a word.

### Testing them

`RunSheetView.browser.test.tsx` and `RunTimeEditor.browser.test.tsx` measure
the two screens above at 390 and 1280px in both ramps — every marker on the
thread, the holders' column, an event's run of show inside its band and past
the thread, every word at 4.5:1 on what it is painted over,
the popover inside the screen, Tab inside the popover — and leave screenshots
in `__screenshots__/`.

`shared/ui/tests/` asserts what a call site can rely on — that the variants differ
from each other, that props reach the DOM, that the accessibility wiring is
there, and that the one piece of arithmetic in the set is right. It does not
assert class strings: that pins the current answer rather than the contract, and
turns every move of the design into a test edit.

### A badge that explains itself

A badge whose meaning is not obvious sits inside `@shared/ui`'s `Tooltip`. A
screen reader hears the explanation once, as hidden text; a mouse user sees it
on hover, in a panel on `--surface-raised` at `text-ui-xs`. The badge stays out
of the tab order. An explanation a host needs in order to act goes in visible
text instead. Never a `title`: Chrome would hand a screen reader the words a
second time. `wiki/shared/component-library.md` §`Tooltip` has the rest.

Where a badge repeats once per household or row inside the module shell — a
household's Opened, Sent or Deactivated — it is a `TipNote` (`ActionTip.tsx`)
instead: the same hidden text, and the shell's one panel on hover, so a list of
300 builds no tooltip of its own per row.

A badge stays out of the tab order, so a host on a phone or at the keyboard
cannot hover it. Where the badges are icons with nothing written beside them —
the RSVP meta line's provenance — one button in the view bar opens a key that
names every one, with what it says: "What the reply icons mean", a quiet 28px
`info` circle at the end of the bar's second row (on a phone, the search row),
its panel the marks' own words. One stop for the page, not one per row.

On a guest's meta line (§Names and meta lines) a provenance badge is an icon
with nothing written beside it, at `--text-muted`, 14px, stroke 1.75: its name
is hidden text inside it, its explanation the tooltip. Host-entered is
`user-round-pen`, Host-updated `pencil-line`, Household-entered `users-round`,
a linked musubi `link-2`. "New" stays a word — gold-ink, tiny caps, no box —
because it says what to look at, and a dot would leave colour alone to say it.

### Status marks

Iconography carries the state (the owner's lead: Flighty). A state is a filled
circle with a glyph, then its word in tiny caps — `text-ui-xs`, medium,
`tracking-ui-wider` — with no outline, no box and no border round the word
(`StatusMark.tsx`). The four tones:

| Tone | Circle | Glyph | Word | Used for |
|---|---|---|---|---|
| `yes` | solid `--status-yes` (gold) | `--on-gold` | `--gold-ink` | Attending; a household's Opened (`eye`) |
| `no` | deep muted red `--status-no` | `--status-no-ink` | `--error` | Declined (`x`); Deactivated (`ban`) |
| `maybe` | gold tint `--status-maybe` | `--status-maybe-ink` | `--text-muted` | Maybe (`?`); a household's Sent (`send`) |
| `none` | an empty 2px ring in `--text-faint` | — | `--text-muted` | No reply |

Contrast, measured from the ramps (`GuestsMarks.browser.test.tsx` holds each
glyph at 4.5:1 on its painted circle, in both themes, though a glyph owes 3:1;
the words are contract inks):

| Pair | Dark | Light |
|---|---|---|
| `--on-gold` on `--status-yes` | 8.54:1 | 4.87:1 |
| `--status-no-ink` on `--status-no` | 8.33:1 | 6.71:1 |
| `--status-maybe-ink` on `--status-maybe` | 6.66:1 | 5.86:1 |
| `--gold-ink` on `--bg` (the Attending word) | 11.66:1 | 5.14:1 |
| `--error` on `--bg` (the Declined word) | 6.22:1 | 4.60:1 |

*Computed 2026-10-28 with `contrastOklch` (`@cire/theme`) from the values in `src/styles/global.css`; `GuestsMarks.browser.test.tsx` checks the painted words and glyphs in both themes.*

The circle is 16px beside its word in a table cell, and 20px over it
(`stacked`) in the fixed column that starts a phone row. Declined is never a red
border: at 1px a red edge on either ground was the poorest contrast on the page.
The circle alone (`StatusDot`, 14px) stands for its word on a chip that names
it.

### Names and meta lines

A guest's name is one line: it ends in an ellipsis, never breaks mid-word, and
never shares its line with a badge. Under it, a muted meta line at
`text-ui-xs` holds what else there is — whose plus-one they are, what changed,
who answered, how — each piece whole, the line itself cut short at its end
(Luma's name and meta line; Airbnb's dot-separated meta).

A plus-one is "+1" on screen, never "Plus-one": "+1 · Kai" on the meta line, the
inviter's first name after the dot, in `--gold-ink`. The full words ("Plus-one
of Kai Wolfeschlegelsteinhausenbergerdorff") are hidden text, so a screen reader
and the search still have them. The households' column head is "+1", its
hidden head "Plus-one"; a guest's switch on a phone is labelled "+1"; a
household's count is "+1 1/2", its hidden words "Plus-ones: 1 of 2".

A phone's RSVP row is three columns (Flighty): the reply's mark stacked over its
word in a fixed 4.25rem column at the start, so the marks read down the list;
the name, the household, the meta line and the dietary answer (a `utensils`
icon, then the words, free to wrap at words) in the middle; the button at the
end. A household's events are a quiet line of names with a dot between, not a
row of boxes.

### Chips

A chip is a pill at the small search box's height (`h-7`), `text-ui-sm`, on
`--surface` with no border, its count in the mono face in `--text-muted` beside
its name. Chosen, it fills in the brand green (`--brand`, `--on-brand` on it,
8.66:1): Wise's filter chips. A row of chips never wraps; it scrolls sideways
(Wise). Pills, so they never read as part of a segmented control. Focused from
the keyboard a chip wears the dashboard's one focus ring, never `outline-none`;
the row keeps 4px of padding inside a matching negative margin, so its sideways
scroll, which clips both ways, never cuts the ring.

- **Event chips** pick the event on the RSVP page. They follow the module's
  segmented sub-tabs on the view bar's first row after a hairline divider
  (`data-bar-divider`), so the bar holds two groups that look like two: a
  boxed segmented control, then free pills.
- **Reply chips** filter the RSVP list and are its legend and counter at once
  (Partiful): each carries its reply's `StatusDot` and its count. The chosen
  one shows ⊗ (`circle-x`), and a second press clears it back to All. On a phone
  they keep their dots and counts, their words hidden text, on a row of their
  own under the search and the sort.

**Grouping.** The RSVP list is not grouped under status headings (Apple
Invites). The host sorts it by guest or household and searches it; a heading
per status would split a household's replies across the page and fight the
sort, and would be one more stuck layer. The reply chips already answer "who
still owes a reply" in one tap, with the count on the chip, and the column of
marks scans down the page.

### A tab strip inside a view

A view that shows one of several things at a time — the RSVP page's events —
picks it from a row of event chips (§Chips), a `tablist` with the keys of the
module sub-tabs: the arrows, Home and End move focus and Enter or Space
chooses, because a panel that draws hundreds of rows is not instant, and
choosing what you only passed over would draw it anyway.

The row scrolls sideways rather than wrapping, and brings a chip into view by
scrolling itself, never the page. Anything a chip needs to say about what it
holds — the RSVP page's "New" — is a word, never a dot: colour does not carry a
meaning alone. A chip whose name is a phrase (the event and its count) gets an
`aria-label` in sentence case
([frontend-patterns](../../wiki/shared/frontend-patterns.md) §Chrome exposes a
`title` as a description).

A view lends its chips to the module's view bar (§The stuck stack), after a
divider beside the module's own sub-tabs, outside the module's tab panel. Ids
carry a per-view prefix, so they never meet the shell's `subtab-*` and
`subpanel-*`, and the chips keep `aria-controls` on the view's own panel.

### The stuck stack

A long view keeps what it is about on screen while its rows scroll by. The
module title and its hint scroll away; under the top bar, layers hold at the
top of the window, each one's top at the foot of the one above. On a laptop
the whole stack, top bar included, is at most 220px; on a phone, 200px (both
asserted in `GuestsStack.browser.test.tsx`).

| Layer | `top` | z | Ground |
|---|---|---|---|
| 0 Top bar | 0 | 30 | `--bg` at 85%, blurred |
| 1 View bar | `var(--chrome-h)` | 20 | `--bg`, hairline below |
| 2 Column heads, or a card's header | `+ var(--bar-h, 0px)` | 10 | `--bg`; a card header paints the card's ground opaque |
| 3 Household bar | `+ var(--heads-h, 0px)` | 5 | `--surface`, hairline below |

Every offset is a sum of heights the page already knows, never a guess:

- `--chrome-h` — the top bar with its hairline: `calc(3.5rem + 1px)`, and
  `calc(4rem + 1px)` under `@container frame (min-width: 42rem)`, the bar's own
  breakpoint. It lives on `.chrome-scope` — a `display: contents` wrapper round
  the top bar and `<main>`, and the boot bar — so it follows the frame, not the
  viewport. The top bar takes its height from it.
- `--bar-h` — measured: `ModuleShell` writes the view bar's height on the shell
  from a `ResizeObserver` and removes it with the bar, so every use carries a
  `0px` fallback and a layer holds at the top bar's foot before the first
  measure.
- `--hh-bar-h`, `--card-head-h` (2.75rem) and `--head-strip-h` (2.125rem) —
  the fixed rows. Each is one line, `whitespace-nowrap`, at that height.
- `--heads-h` — set by a view that has a head strip (the strip and its
  hairline), `0px` where it has none.

A control that takes focus inside a view carries the stack's height above it
as its `scroll-margin-top`, so the browser never leaves focus under a layer. A
switch adds a rem: its focusable input sits inside its label, below the
track's top edge.

A stuck layer is the same box stuck or not: nothing in it changes size when it
sticks, because Safari has no scroll anchoring to hide the jump. A shadow on
`@container scroll-state(stuck: top)` would be an enhancement only; none is
drawn.

**The view bar.** One compact bar per module that has sub-tabs (Events,
Vendors, Registry, Guests, Invite, Settings), between the title and the panel,
outside the panel's animated frame. A `role="region"` named "<Module>
controls" — one landmark, outside the module's tab panel, whose sub-tabs still
control it. First row: the sub-tabs, icon and label, then whatever the open
view lends the row (`<ViewBar slot="end">`); a second row draws only when a
view fills it (`slot="row2"`). Below a 36rem panel the sub-tabs show their
icons alone, their label each one's name and tooltip. The bar's height moves
with the panel's, through `createAutoSize` on its own frame, so a change of
view that adds or drops a row never jumps; a view that loads holds its rows'
height with a placeholder the size of each. A module with one view has no bar.

**What each Guests tab lends it.** RSVPs: a divider and the event chips in the
first row; the slim search and the reply chips in the second; on a phone the
search and the sort select in the second and the reply chips in a third.
Households: the count and the search in the first row, and on a phone the
search alone. Edit: a divider, the mode switch and Add household, icons alone
below 36rem. "Showing n of m" and the tallies stay in the panel, under the bar.
Measured with the third phone row, the phone RSVP stack is 185px of its 200.

**One variant, chosen by the panel.** A view names the narrowest panel its wide
layout fits — the RSVP table's columns and 7rem of Dietary, 45rem for an editor
and 37rem for a viewer; the households' tables, 46rem (40rem without the
Plus-one column) — and draws its narrow layout below it, coming back only a rem
above it (`createCompact` in `ViewBar.tsx`). One variant is drawn, never both
hidden by CSS. Narrow, guest rows stack as blocks and nothing scrolls sideways.

**Households.** Each household is a `group` named by its household, with a
table of its own under one head strip that sticks at layer 2. The strip is a
table with the same `<colgroup>` (Guest, Events at a third, +1 7rem, Code
11rem), hidden from assistive technology; each household table keeps its own
heads, `Th srOnly`, in its layout with no height. The household bar holds at
layer 3 while its household is on screen and lets go at its end: the name in
`--text` (`--text-muted` once deactivated), its state as a status mark, "+1
n/m", then four icon actions with their
names as tooltips — Allow everyone, Allow no one, Copy message, Deactivate (or
Reactivate). Deactivate's confirmation takes the icons' place in the same row.
Narrow, the state is one word, and the
actions sit behind a "⋯"; Deactivate there opens a confirmation dialog,
since a menu closes on choosing. One menu serves the list: each "⋯" is a plain
button that opens it for its own household, on its first item from the
keyboard, and closing gives focus back to that "⋯". A "⋯" pressed while the
last menu is still fading waits for it to go.

**Edit.** A card's header — the name field, the claim code and Delete household,
then the column heads — sticks at layer 2 inside its card and lets go at its
end. It paints the card's `bg-surface/30` composited over `--bg` as one opaque
ground. The editor table is fixed layout with explicit column widths, shared by
the header's head strip, which follows the table's sideways scroll through one
capture-phase listener for the whole editor. An event name too long for its
8rem column is cut short with an ellipsis and becomes a button that opens the
whole name, by touch or keyboard, in the editor's one popover. Narrow, the header holds the name alone, its
label the field's own. Add household hands focus to the new card's name.

**Moving within the stack.** A search, a reply filter, a sort or an event change
made deep in a list brings the list's top back to the stack's foot, focus left
in the field; made with the list already in view, it moves nothing
(`lib/scroll-to-results.ts`). A sub-tab or module change made with the bar
stuck puts the new panel's top at the foot, once, and holds the panel at least
a screen tall until its view's data lands, so the page cannot clamp meanwhile.

**Icon-only controls.** Every control that shows an icon instead of its words
keeps its words as its accessible name and shows them in a tooltip on hover
and on keyboard focus (`ActionTip.tsx`). The tooltip is for the eye only, and
there is one for the whole page: each control carries its words as `data-tip`,
and the shell's `TipLayer` draws a single panel beside whichever one the
pointer rests on (after 300ms, at once within 300ms of the last) or the
keyboard reaches (at once). A touch, a press, Escape, activating the control
or its leaving the page closes it. A list of 300 households, four icons each,
mounts no tooltip machinery until someone hovers.

### A table that scrolls with the page

A long table whose head row must stay on screen — the RSVP table, each
household's table — scrolls with the page, `Table scroll="page"`: its box
clips sideways instead of scrolling, so the document stays the scroller and
the pinned head row sticks to the page under the call site's offset
(`top-[calc(var(--chrome-h)+var(--bar-h,0px))]`, which wins over `pin`'s
`top-0`). A clipped column is gone, so such a table is never drawn narrower
than its columns: below that width the view draws its narrow layout instead.
Page mode is no tab stop and no region; the table is named by its caption or
`aria-labelledby`.

`@shared/ui`'s `pin` variant on `Th` pins the cells; classes at the call site
cannot, because a pinned cell paints the page ground so the rows passing under
it never show through. That only reads right on a table set straight on the
ground, not on a tinted card.

The box-scrolling table (the default) stays for a table that must scroll
sideways at any width — the guest editor, which grows a column per event —
with `pin` on `Th` and `Td` (`top`, `top-start`, `start`) where its box also
scrolls down. Pin a column only where the box can scroll sideways: each pinned
cell costs every scrolled frame.

### A column head that sorts

A sortable head holds a button, and the `th` around it carries `aria-sort` — on
the sorted column only. The button sets `uppercase` itself, because a button
does not inherit a text transform. Beside the label, at 14px and stroke 1.75:
`arrow-up` or `arrow-down` on the sorted head, a faint `chevrons-up-down` on
one that could be. A click sorts ascending, a second click reverses. The sort
belongs to the view, not the address.
