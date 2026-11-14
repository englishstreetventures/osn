# Pulse Design System

Visual language and design decisions for the Pulse events app.

## Design Direction

Pulse takes functional cues from **Eventbrite** (info-dense event cards) with visual warmth from **Luma**, **Partiful**, and **Flighty** (editorial type, warm accents, playful glyphs). The result should feel modern and fun — not corporate.

## Typography

Three font families, all SIL Open Font License 1.1 (free commercial use):

| Role                | Family           | Weight range         | Usage                                                     |
| ------------------- | ---------------- | -------------------- | --------------------------------------------------------- |
| Display / editorial | Instrument Serif | 400 regular + italic | Hero headlines, section headers, stat numbers, map labels |
| UI / body           | Geist            | 400–700              | Navigation, card body, form labels, buttons               |
| Mono / data         | Geist Mono       | 400–500              | Timestamps, stat labels, category tags, eyebrow text      |

**Key type patterns:**

- Hero headline: Instrument Serif, `clamp(32px, 4.4vw, 56px)`, italic accent word
- Section headers: Instrument Serif, 22px, weight 400
- Card titles: Geist, 16.5px, weight 600
- Meta/eyebrow text: Geist Mono, 10.5–11.5px, uppercase, wide tracking
- Date stamps: Geist, mixed weights (9–18px depending on element)

Where the app does not follow this yet: a category pill drawn with `@shared/ui`'s
`Badge treatment="eyebrow"` (Design Decisions §7) is set in Geist at weight 600,
not Geist Mono at 400–500. 600 is the fallback of the contract's
`--ui-weight-title`, which pulse does not map, and the badge takes the page's
family (#2122).

### Named type tokens

Each Pulse surface names its own off-scale type decisions in its own theme block.
None of them belong in the shared `ui-*` contract, which is library-facing — an
app's headline measure and its eyebrow size are that app's, not every consumer's.

`@pulse/landing` — `pulse/landing/src/styles/global.css` (`@theme`):

| Token                    | Utility                | Value     | Sets                                                                                                                  |
| ------------------------ | ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `--text-tag`             | `text-tag`             | `0.6rem`  | The uppercase mono category tag — on a floating chip, on a feature card, above the venue list                         |
| `--text-meta`            | `text-meta`            | `0.65rem` | The mono meta line beneath a chip tag                                                                                 |
| `--text-eyebrow`         | `text-eyebrow`         | `0.72rem` | The mono micro tier the sections are set in: every section eyebrow, and the set time in a venue row                   |
| `--text-copy`            | `text-copy`            | `0.95rem` | Body copy — an FAQ answer, a step description, a feature card, a button label                                         |
| `--text-lede`            | `text-lede`            | `1.05rem` | The line that introduces a block, and anything promoted above copy: a section lede, an FAQ question, a headliner slot |
| `--text-subhead`         | `text-subhead`         | `1.25rem` | A step's own heading, below the section headline                                                                      |
| `--text-glyph-sm`        | `text-glyph-sm`        | `2rem`    | A glyph in a 56px category tile                                                                                       |
| `--text-glyph-lg`        | `text-glyph-lg`        | `3rem`    | A feature card's glyph, and a how-it-works numeral                                                                    |
| `--tracking-mono-wide`   | `tracking-mono-wide`   | `0.14em`  | Mono caps at body length — the location line                                                                          |
| `--tracking-mono-wider`  | `tracking-mono-wider`  | `0.18em`  | Mono caps on a chip tag or a card label                                                                               |
| `--tracking-mono-widest` | `tracking-mono-widest` | `0.28em`  | Mono caps as a section eyebrow                                                                                        |
| `--leading-display`      | `leading-display`      | `1.05`    | Instrument Serif at hero size, and the closing call to action                                                         |
| `--leading-heading`      | `leading-heading`      | `1.2`     | A section headline, set around a third of the hero                                                                    |
| `--leading-copy`         | `leading-copy`         | `1.75`    | Long-form marketing copy at a 40rem measure                                                                           |

`--text-tag` and `--text-meta` sit below the smallest step of any scale available
here — Tailwind's own `text-xs` is 12px, and these are 9.6px and 10.4px.
Snapping them up would change the hero rather than tidy it, which is why they
are named.

The steps from `eyebrow` to `glyph-lg` replace **53 literal `text-[…]`,
`tracking-[…]` and `leading-[…]` values across 23 distinct sizes** in the seven
`src/components/sections/*.astro` files. 23 for one marketing page was itself the
finding: `1.02rem` and `1.05rem` were 0.48px apart and are one step here, as are
`0.72rem` and `0.8rem`, and `1.7`/`1.75`/`1.8` leading.

**They are named rather than snapped to a built-in step, even where one sits
within a pixel.** A built-in `text-*` also sets `line-height`; an arbitrary
`text-[…]` sets font-size alone. So `text-[0.9rem]` → `text-sm` would have
changed the leading too, on every site carrying no `leading-*` of its own — a
second, invisible change, and in different directions on different sites. A
`@theme` entry with no `--line-height` companion emits `font-size` alone, which
is what these are replacing. Built-in _leading_ utilities have no such coupling
and `leading-relaxed` is used directly.

The three tracking steps continue past where the default scale stops (`widest`
is 0.1em). Mono caps at these sizes need one and a half to three times that
before the letters read as spaced rather than collided.

Two things in those files are deliberately **not** on the scale. The five
identical `text-[clamp(1.9rem,4.5vw,3rem)]` section headlines read a size decided
at the viewport, which is what `clamp()` is for and which the arbitrary-value
rule exempts by name. And the literal `font-size` / `line-height` declarations in
the `<style>` blocks of `SiteFooter.astro` and `LegalLayout.astro` are CSS rather
than utilities — a separate piece of work, and not what #1117 scoped.

Nothing enforces this from the linter. `shadcn/no-arbitrary-values` is at
`error`, but `oxlintrc.json` lists `*.astro` under `ignorePatterns`, so oxlint
never parses the files this scale exists for — which is how 53 literals
accumulated behind a green rule. `pulse/landing/tests/named-type-scale.test.ts`
is the guard instead: it fails on a literal type value anywhere under `src/`, and
on a `@theme` entry going missing.

`@pulse/web` — `pulse/web/src/app.css` (`@theme inline`):

| Token                   | Utility          | Value   | Sets                                      |
| ----------------------- | ---------------- | ------- | ----------------------------------------- |
| `--container-hero`      | `max-w-hero`     | `16ch`  | The explore hero headline's measure       |
| `--spacing-accent-word` | `mr-accent-word` | `0.2em` | Optical gap before the italic accent word |

The hero measure is counted in characters rather than rem because a display
line's length is a property of the face it is set in, and the `ui-*` measure
scale is in rem.

## Color System

Built on oklch for perceptual uniformity. Extends the base shadcn token system with Pulse-specific accent tokens.

### Pulse accent — coral/ember family

| Token                   | Value                                                        | Usage                                                         |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `--pulse-accent`        | `oklch(0.68 0.18 38)`                                        | Primary accent (coral) — brand mark, hero italic, CTA buttons |
| `--pulse-accent-strong` | `oklch(0.58 0.19 35)`                                        | Ember — date stamp month, meta-line text, active tab underline |
| `--pulse-accent-soft`   | `oklch(0.95 0.05 45)`                                        | Peach background — soft highlight surfaces                    |
| `--pulse-accent-fg`     | Light: `oklch(0.99 0.004 80)` / Dark: `oklch(0.17 0.008 60)` | Text on accent backgrounds                                    |

### Semantic tokens

| Token            | Value                  | Usage                              |
| ---------------- | ---------------------- | ---------------------------------- |
| `--close-friend` | `oklch(0.66 0.16 145)` | Green ring on close-friend avatars |
| `--badge-live`   | `oklch(0.72 0.17 22)`  | Live event indicator dot           |

### Warm-tinted neutrals

Light and dark modes use **warm-tinted greys** (hue 60–80) instead of pure neutral. This gives the app warmth without explicit color.

### Shadows

Three tiers: `--shadow-sm`, `--shadow-md`, `--shadow-lg` — warm-tinted in light mode, deep black in dark mode.

## Explore Page Layout

Two-pane desktop layout:

- **Events pane** (~56%): scrollable feed — filter rail, sectioned card list
- **Map pane** (~44%): sticky, full-height — heatmap canvas, event pins, time scrubber

Below 1180px, map collapses and events go full-width.

Below 768px (Tailwind's `md`) the page takes its phone layout:

- **Gutters are 16px** (`px-4`) on the brand row, the hero, the events pane and
  the create form's wrapper, and 32px (`px-8`) from 768px up. At 320px the
  signed-in brand line needs 260px of the 288px a 16px gutter leaves.
- **The hero stacks**: the stats sit under the headline, not beside it. Beside
  it, they ran past the screen's edge at 320px.
- **The create form's start and end times stack**, and sit side by side from
  768px up. A `datetime-local` field is 206px wide at its narrowest, so the
  pair side by side needs 424px.

The page never scrolls sideways at any width.
`tools/e2e/tests/support/pulse-explore.ts` holds this and the navigation rules
below at 320, 390, 768 and 1440px, signed in and signed out, and shoots the page
at 320, 390 and 1440px in light and dark.

### Navigation

Horizontal top nav (no sidebar). Two sections:

1. **Brand row**: Logo mark (pulsing coral dot) + "Pulse" wordmark, tab bar (Home / Calendar / Hosting), search, actions
2. **Hero**: Time-of-day greeting, editorial headline with italic accent word, live stats. On a narrow phone the greeting's date wraps to a line of its own

**From 768px up the brand row is one line**: brand, tabs, then the search and
the actions on the right. The search takes the row's spare width up to 360px
(`max-w-90`), and is the first thing to give way when the row is short: at
768px, signed in, it is about 170px wide and its placeholder ends in an
ellipsis. The whole header pins (`sticky`).

**Below 768px the brand row wraps to three lines:**

1. The brand on the left, the actions on the right (bell, Host and avatar, or
   "Continue with musubi").
2. The search, from gutter to gutter.
3. The tabs, last, so the active tab's underline
   (`.explore-tab-active::after`, 15px below the tab) lands on the row's bottom
   border. From 768px up the tab sits centred beside taller controls, so the
   underline sits 5px above the border when signed in.

**The active tab** is marked three ways: `aria-current="page"`, the foreground
text on a `--secondary` fill, and a 2px underline in the ember,
`--pulse-accent-strong`. The coral measures 2.97:1 on the light `--background`,
under the 3:1 a state mark needs; the ember measures 4.48:1 in light and 4.09:1
in dark.

**The search shows focus with an outline**: 2px of `--ui-focus`, 2px out from
the field (4.11:1 on the light `--background`, 5.24:1 on the dark), so the mark
holds in forced-colours mode, where a box-shadow ring vanishes. The search has
no keyboard shortcut.

**Below 768px the header scrolls with the page** instead of pinning. Three lines
and the hero make it about 410px tall at 390px, half of an 844px screen, and
three quarters of a 320×568 screen.

**Focus follows the desktop order.** The markup runs brand, tabs, search,
actions, and the phone lines are placed with `order`, so on a phone the focus
moves tabs, search, actions while the lines read actions, search, tabs. Each
control stands alone, so no meaning depends on the order. One markup order
cannot match both layouts; it matches the desktop's, where the row reads in
markup order.

The owner chose this arrangement (#2135). Rejected: tabs
and search sharing the second line, which leaves the search 62px wide at 320px;
collapsing the tabs into a menu, which needs a component that does not exist;
and the search as an icon, which hides the field.

### Event Cards

Horizontal card: a media column beside the body, 180px wide from 768px up and
112px below. Featured cards stack at every width: 220px of media above the body.

**Media area**: Category-derived gradient placeholder (or image), date stamp (month/day/weekday), status tag (live/filling fast).

**Body area**: Time meta-line (mono), title (600 weight), venue + neighborhood, host row with avatar, dashed footer with category and status.

**Below 768px a card keeps its media beside the body**, in the 112px column.
At 320px that leaves the body 142px of text, and 212px at 390px. A card is
215–235px tall at 320px, 256px when its venue and footer both wrap, so a
568px-tall screen shows more than two, and the featured card stays the one
large card. The live tag reads "Live" there: "Happening now" is 106px wide and
sits 10px in, which needs 116px. From 768px up it reads "Happening now".

*Measured 2026-11-11 — element boxes on the page `ExploreCard.phone.browser.test.tsx` renders, `bunx --bun vitest run --project browser` in `pulse/web`, headless Chromium, macOS*

**The text shows whole at every width:**

- The time, venue and host lines wrap rather than clip, and a word too long for
  its line breaks (`overflow-wrap: anywhere`).
- The time never splits from its AM or PM.
- The venue and neighbourhood run as one line of text with a `·` between them,
  in `--foreground` at 20%, a word space either side. The time line's day and
  time have the same `·`, in the line's own colour.
- A separator `·` is tied to the word before it by a no-break space, so a
  wrapped line ends in the dot and never starts with one. The owner chose this
  on 2026-11-11 (#2161), over a 3px drawn dot, which no text rule can tie to a
  word.
- The clock and pin icons keep their size and sit centred on their text's first
  line; the host's avatar starts level with its first line.
- The footer's category and status wrap to two lines when one does not fit, and
  the status stays flush right on either line.
- The title is the one line that may be cut: it stops at two lines and ends in
  an ellipsis (`line-clamp-2`).

The owner chose this arrangement (#2161, 2026-11-11). Rejected: stacking the
media above the body below 768px, as the featured card does, which makes a card
302–323px tall at 320px, under two to a 568px screen, and leaves the featured
card looking like the rest.

*Measured 2026-11-11 — the same page and command, with the non-featured card at `grid-cols-1 md:grid-cols-[180px_1fr]` and its media at `h-[140px] md:h-full md:min-h-[140px]`*

`pulse/web/tests/explore/ExploreCard.phone.browser.test.tsx` holds, on the
explore page with five events at 320 and 390px, the 112px column, the "Live"
tag, and the list's rules for wrapping, the time, the separator dots, the icons
and avatar, the footer and the title. For the dots it also narrows a line until
the dot no longer fits after its word, and checks the word moves down with it. One event is built to break them: a venue that is one
unbroken word and a status too long to sit beside its category. At 1440px it
holds the 180px column and "Happening now". It shoots the page at all three
widths in light and dark.

**Placeholder system**: 8 gradient classes (`ph-1` through `ph-8`) with overlay pattern and category glyph — used when events lack an image.

### Map

- SVG-based stylized map (not real tiles) — neighborhoods, water features, park
- Canvas heatmap overlay — radial gradients from event coordinates, intensity weighted by time proximity
- Category-colored pins with glyph icons
- Time scrubber: range slider (0–23h) with serif hour display
- Hover popups on pins
- Legend card showing heat scale

## Component Catalog

| Component             | File                                 | Props                                                                                     |
| --------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `ExploreNav`          | `explore/ExploreNav.tsx`             | `query`, `onQueryChange`, `eventCount?`, `liveCount?`                                     |
| `FilterRail`          | `explore/FilterRail.tsx`             | `active`, `onSelect`                                                                      |
| `ExploreCard`         | `explore/ExploreCard.tsx`            | `event: EventItem`, `featured?`, `hovered?`, mouse handlers                               |
| `ExploreMap`          | `explore/ExploreMap.tsx`             | `events: EventItem[]`, `hoveredId?`, `onHoverEvent?`                                      |
| `ExplorePage`         | `explore/ExplorePage.tsx`            | (route component)                                                                         |
| `Icon`                | `components/Icon.tsx`                | `name`, `size?` (promoted from `explore/`; includes `globe`, `instagram`)                 |
| `VenueDetailPage`     | `pages/VenueDetailPage.tsx`          | (route component — `/venues/:orgHandle/:venueHandle`)                                     |
| `VenueLineupTimeline` | `components/VenueLineupTimeline.tsx` | `slots`, `timezone`, `heading?` — vertical mono-time timeline, headliner weight by `role` |
| `VenueEventCarousel`  | `components/VenueEventCarousel.tsx`  | `events`, `heading?` — CSS scroll-snap carousel with chevron paging                       |

## Design Decisions

1. **No sidebar** — horizontal tabs feel less corporate; the hero section gives the page personality
2. **Warm neutrals** — oklch hue 60–80 on all greys; distinguishes Pulse from generic shadcn apps
3. **Editorial serif** — Instrument Serif for headlines creates the Luma/Partiful editorial feel
4. **Glyph placeholders** — events without images get category-colored gradients + serif glyphs instead of grey boxes
5. **Heatmap over real tiles** — stylized SVG map avoids tile provider dependency; heatmap shows where activity clusters
6. **Card ↔ map hover sync** — hovering a card highlights its map pin and vice versa
7. **Category badges are eyebrows** — a category pill takes `@shared/ui`'s
   `Badge treatment="eyebrow"` (small caps, a step down in size, tracked to
   match) rather than upper case and tracking spelled out beside it. The three
   only work together, so they travel as one name

## Onboarding illustrations

The first-run flow (`/welcome`) introduces six themed SVGs in `pulse/web/src/assets/onboarding/`. They follow these rules so theme tokens drive every accent — no hard-coded colours, dark-mode automatic.

| Illustration           | File                            | Token usage                                                                                                                       |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Welcome pulse rings    | `welcome-pulse.svg`             | `--pulse-accent`, `--pulse-accent-soft`, `--pulse-accent-strong`. Rings animate via `.pulse-ring` keyframes in `onboarding.css`.  |
| Editorial map          | `value-map.svg`                 | `currentColor` for blocks, `--pulse-accent` family for pins + heat blob. Same vocabulary as `ExploreMap.tsx`.                     |
| Interest constellation | `interests-glyphs.svg`          | Instrument Serif glyphs; selectable chips render their own per-category glyph from `CategoryGlyph.tsx` (also `currentColor`).     |
| Location pin           | `location-pin.svg`              | Pin animates with `.location-pin-drop` (drop + bounce) and `.location-pin-ring` (radiate).                                        |
| Notifications ember    | `notifications-ember.svg`       | Coral envelope with two staggered radiating rings.                                                                                |
| Finish date stamp      | inline JSX in `Step6Finish.tsx` | Same date-stamp vocabulary as the Event Card; today's date is driven by `Date.toLocaleDateString` so the image is always current. |

Authoring rules:

- Use `currentColor` for primary strokes that should track text colour.
- Use `var(--pulse-accent*)` for the editorial accent — never inline `oklch(...)`.
- All animation is CSS keyframes only (no Lottie/Rive). Honour `prefers-reduced-motion` — see `onboarding.css` for the canonical opt-out rule.
- Per-category glyphs live as inline JSX paths in `CategoryGlyph.tsx`, not as separate SVG files. Single import, single recolour surface via `currentColor`.

Greeting copy on the welcome step uses the institutional headline ("Welcome to Pulse") with a softer personalised subhead ("Glad you're here, {displayName}.") so a missing displayName degrades to just the headline rather than a literal "Hi there".

## Motion

These rules govern `pulse/web`. The landing site's motion is in
`wiki/pulse/pulse-landing.md`.

- **Durations and easing come from the shared tokens, by job**
  (`wiki/shared/design-tokens.md` §Motion): `--ui-dur-fast` (120ms) for a hover,
  a press or a small panel arriving; `--ui-dur-base` (200ms) for a panel swap,
  such as the onboarding step, and the share sheet leaving; `--ui-dur-slow`
  (320ms) for something crossing the screen, such as the share sheet rising;
  `--ui-dur-exit` for an overlay closing, other than the share sheet below
  `md`. `--ui-ease-out` is for an arrival, `--ui-ease-in-out` for a move
  between two places, `--ui-ease-exit` for an overlay closing, other than the
  share sheet below `md`, and `--ui-ease-sheet` for that sheet rising and
  leaving. A literal duration,
  delay or curve fails `house/no-literal-motion` unless it carries a
  `motion-literal:` comment giving its reason. Loops and choreographed
  illustrations, such as the onboarding rings and the pin drop, are the cases
  that do.
- **CSS only.** Transitions and keyframes, no animation library, no Lottie or Rive.
- **Anything that takes focus fades colours without the outline.** The app has
  no `transition-ui-colors` utility yet; until it does, a control names the
  properties it fades, so the focus mark never arrives late. A bare
  `transition` fades `outline-color` too, and so does `transition-shadow` on a
  ring. The explore tabs fade `color` and `background-color`, and the search
  box fades its `border-color` while its focus outline shows at once.
- **Entrances are short and quiet**: opacity with an 8px rise, as the onboarding
  step does (`onb-step-in`). The share sheet below `md` is the exception
  ("The share sheet slides", below).
- **Only illustrations loop**: the onboarding illustrations, the brand mark's
  pulsing dot (§Navigation) and the live dot beside the hero's greeting and on a
  live card. A looping animation is illustration, never a control or a loading
  state, and it stops under `prefers-reduced-motion: reduce`, holding a still
  frame (`onboarding.css` and `explore/explore.css` hold the rule).
- **Every keyframe and every infinite animation has a reduced-motion rule.**
- **A button presses.** While a pointer or a held Space presses one of
  `@shared/ui`'s `Button`s, it scales to 0.97 over `--ui-dur-fast` on
  `--ui-ease-out` and eases back when let go, the owner's decision on #2034
  (2026-11-14). It is the button's own: a call site adds no class for it and
  sets no `transition-*`, `duration-*` or `ease-*` on a `Button`, which would
  replace its timing. No press while a button is disabled, busy or
  `aria-disabled`, nor at `size="inline"`, and under reduced motion no scale
  at all (`wiki/shared/component-library.md` §Press). The app's own controls,
  such as the filter chips and the explore tabs, do not scale.
- **Overlays grow and shrink.** Pulse maps no scale token, so `@shared/ui`'s
  Dialog (but the share sheet, below), Popover and menus open from the
  contract's 0.96 and close to 0.98
  (`wiki/shared/design-tokens.md` §Motion), and under reduced motion show and
  hide at once. The menus are the shared default look: a menu's separator is a
  1px `--ui-hairline` fill with no border.
- **The share sheet slides.** Up to 640px the share dialog is a `Dialog`
  sheet, and below `md` `@shared/ui` slides every sheet: up from its own
  height below the bottom edge over `--ui-dur-slow` (320ms), back down over
  `--ui-dur-base` (200ms), both on `--ui-ease-sheet`, at full opacity and with
  no scale, its scrim fading on the same pace. Closed part-way up it turns
  round from where it is. The owner chose it for every sheet ("B: slide up",
  #2045, 2026-11-13). Under reduced motion it shows and hides at once; on a
  browser older than Chrome 117, Firefox 129 or Safari 17.5 it appears at once
  and still slides out.

Where the app does not follow this yet: these controls fade their focus mark
with the colour: `FilterChip.tsx`, `ShareEventButton.tsx`,
`CalendarEventCard.tsx` and `routes/series/[id].tsx` (bare `transition`).

`tools/e2e/tests/support/pulse-explore.ts` holds the explore header to these
rules: what its tab and search box fade, and its two loops stopping under
reduced motion.
`tools/e2e/tests/support/pulse-menus.ts` holds both avatar menus' separators
at 390 and 1440px in both schemes, and holds those menus and "More filters"
opening from 0.96.
`pulse/web/tests/styles/share-sheet-motion.browser.test.tsx` holds the share sheet at
390px under pulse's stylesheet: its first frame its own height below the
edge, at full opacity and unscaled, over a clear scrim.

## Future

- Friend avatar clusters on cards (needs social graph API integration)
- RSVP counts in card footer (needs list-level enrichment endpoint)
- Price display (needs schema addition)
- Real map tile integration (Mapbox/MapLibre) replacing SVG prototype
- Dark mode toggle in nav (design supports it; token system is ready)
