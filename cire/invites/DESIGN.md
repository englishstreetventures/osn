# Guest site — design system

The visual system for `@cire/invites` (`invite.cireweddings.com`): a couple's
invitation, its gift page, `/privacy`, `/terms` and the 404. The tokens live in
`src/styles/global.css` and in the palette `@cire/theme` derives; this file
records the rules a change must keep and points to the pages that hold each
part's contract and tests.

Where this file and a wiki page differ, this file ships until the owner
changes it. Where a design skill suggests another value, the owner chooses
(`.claude/skills/design-system/SKILL.md` Step 2). The detail lives in:

- `wiki/cire/cire-invite-designs.md` — the design packs, the claim and welcome
  panel, the hero, the event card and sheet, and what each corner role paints
  (§Corners, labels and motion).
- `wiki/cire/cire-invite-builder.md` §Theme — how the couple's five colours
  become every token, and the contrast floors; §Guest rendering (SSR) — how a
  page is put together; §Organiser UI — what the couple can choose.
- `wiki/cire/cire-envelope.md` — the envelope opening.

The host portal shares its corner roles, its type steps, its motion ladder and
its gold commit button with this site (`cire/host/DESIGN.md` §2–§4); the
colours and the faces here are the couple's own. "The invite is a printed
thing; the portal is the desk it was made on."

---

## 1. What the couple chooses, and what the house keeps

The couple choose the look: a design pack (`classic` or `gala`), five colours,
a tone for each section, the heading and body fonts, and the heading size,
weight and style. The house keeps the floors under any choice: every word's
contrast, the corner roles and the motion below. A choice never lowers a floor;
`derivePalette` moves a colour until it clears its floor rather than warn and
ship an unreadable invite.

---

## 2. Colour

Every colour is a `--color-*` custom property on `<html>`, written per wedding
by `paletteRootVars` (`src/components/invite-theme.ts`) from `derivePalette`
in `@cire/theme`. The two pack shells and the gift page apply it; `/privacy`,
`/terms` and the 404 paint the fallback, the `evergreen` preset spelled out in
`global.css`'s `@theme`, which must equal `derivePalette(evergreen)`.

- **Five seeds, by role**: `ground` (the page), `card` (raised paper), `ink`
  (everything written), `gilt` (the metal) and `bloom` (the festive
  counter-colour). Five presets — `evergreen`, `jewel`, `fog`, `chapel`,
  `garden` — fill any seed left unset.
- **A section sits on a tone** — `ground`, `card` or `raised` — never on a free
  colour.
- **Gold is metal; gold-ink is read.** `--color-gold` is for rules, fills and
  ornament. Words that must be read in gold take `--color-gold-ink`, held to
  4.5:1 on the ground it sits on, and a label on a gold fill takes
  `--color-on-gold`. No gold tint goes under gold words.
- **Shared components read the `--ui-*` contract**, which `global.css` points
  at the palette's own names (`--ui-accent: var(--color-gold)`) and never at
  their values, so the couple's palette reaches `@shared/ui` and `@cire/ui`
  unchanged.
- **Dress-code swatches are content**, the colours guests are asked to wear,
  so no scheme recolours them.

The derivation, its contrast floors and the presets' values:
`wiki/cire/cire-invite-builder.md` §Theme.

---

## 3. Type

| Family             | Variable         | Used for                       |
| ------------------ | ---------------- | ------------------------------ |
| Cormorant Garamond | `--font-display` | headings and the hero's title  |
| Lato               | `--font-body`    | everything else                |

The couple may swap either for another of `FONT_CHOICES` (`@cire/theme`), each
an already-loaded face or a system stack, so no choice adds a font download.

- **Self-hosted, latin and latin-ext only, woff2 only** (`global.css`). A name
  in another script paints in the fallback.
- **Metric-matched fallbacks** on Georgia and Arial hold the box the web font
  will take, so the hero title does not reflow when the font lands.
- **Weights.** Cormorant loads 300, 400, 600 and 700; Lato 300, 400 and 700. A
  boxed label's medium weight draws Lato's 400.
- **The root is 16px, and 17px from 1024px.** The type is in rem, so the one
  step lifts it all at a desk.
- **Shared components take the contract steps**, `--ui-text-xs` (0.72rem) to
  `--ui-text-2xl` (2.5rem), the same seven as the portals.
- **The couple's typography options** — heading size, weight and style, body
  weight and style — reach the pack's headings and the body; a modal's title
  and an event card's name keep the pack's look.

Labels are sentence case at normal tracking; small caps are for what is not a
label (`wiki/cire/cire-invite-designs.md` §Corners, labels and motion).

---

## 4. Shape

The corner roles are the portals': `control` a pill, `field` 14px, `lg` 16px,
`md` 10px, `sm` 6px, `hair` 2px. One role is this site's alone:
`--ui-radius-sheet`, 1.75rem, the top corners of a bottom sheet, rounder than a
card because a thumb reads them as the place to drag.
`cire/vendor/tests/styles/tokens.test.ts` fails if a shared role or step
differs from the host's. What each corner paints here, and the fields, boxes
and checkboxes: `wiki/cire/cire-invite-designs.md` §Corners, labels and motion.

---

## 5. Motion

**Rules for new motion** (the owner, 2026-11-10, englishstreetventures/osn#2164):

- **CSS only** — transitions, keyframes, `@starting-style`,
  `interpolate-size` — or the View Transitions API. No animation library.
- **Every duration and easing is a token** from the ladder below, never a
  literal. `house/no-literal-motion` (`bun run lint`) and
  `scripts/check-motion-literals.ts` (CI, for CSS and Astro) report a literal
  they can see. Neither sees a script's animation options: check those by eye
  (englishstreetventures/osn#2104). A `transition-*` class with no easing
  beside it runs `--ease-out` (below), so one whose job is not an arrival
  names its easing. A literal
  stays only where no token's job fits — choreography longer than
  `--dur-slow`, a loop, a stagger, a time shared with script — with its reason
  beside it (`wiki/conventions/house-lint-rules.md` §Literal motion).
- **A little slower than a motion skill's fast default**, so a guest can feel
  the move: "Some of these could be just a tad slower to allow people to feel
  the animation." Choose the rung by eye, rendered, and write it in this
  section beside the motion it times.
- **A modal dialog may fade out, because it keeps focus until the exit ends;
  every other box that holds controls closes at once** (the owner,
  2026-11-12, englishstreetventures/osn#2197).
- **Under `prefers-reduced-motion: reduce` it changes at once.**

### The ladder

The portals' ladder, value for value, in `global.css`:

```css
--dur-fast: calc(120ms * var(--motion-scale)); /* a hover, a press */
--dur-base: calc(200ms * var(--motion-scale)); /* a panel swap, a choice */
--dur-slow: calc(320ms * var(--motion-scale)); /* a sheet */
--ease-out: cubic-bezier(0.23, 1, 0.32, 1); /* something arriving */
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1); /* something moving between two places */
```

- **It follows the input.** With a fine pointer (`@media (pointer: fine)`) the
  rungs are 90, 150 and 200ms; on touch, the values above. Under the same
  query the site sets `Modal`'s `--ui-modal-enter` to `--dur-slow` and
  `--ui-modal-exit` to `--dur-base`.
- **`--ease-out` is the owner's choice of 2026-11-11** for all four cire apps,
  and their one curve for something arriving (`cire/host/DESIGN.md` §4).
  The contract mapping sets `--ui-ease-out: var(--ease-out)` (the owner's
  choice of 2026-11-12), so `Modal`'s rise and every shared `animate-in`
  entry run it too. An overlay's exit keeps its own curve: `animate-out`
  reads the contract's `--ui-ease-exit`, which no cire stylesheet maps, and
  `Modal` leaves on CSS's `ease-in`.
- **No spring token.** `--ease-spring` and `--ease-glide` are the portals'
  alone; the vendor portal's token test fails if this stylesheet gains one.
- **Tailwind's `ease-out` and `ease-in-out` classes read the house curves**,
  because `global.css`'s `@theme` sets `--ease-out` and `--ease-in-out`. It
  also sets Tailwind's `--default-transition-timing-function` to
  `var(--ease-out)`, so a class that names no easing — a bare
  `transition-opacity` — runs `--ease-out`, never Tailwind's
  `cubic-bezier(0.4, 0, 0.2, 1)`.
- **`--motion-scale`** multiplies each rung, so a motion can be slowed to 0.1×
  and judged frame by frame. Nothing in the app writes it.

### What moves, on which rung

| What                                                                           | Duration                                    | Easing                    |
| ------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------- |
| A hover, a press, a focused control's colours                                  | `--dur-fast`                                | `--ease-out`              |
| A choice being made: the answer pair (`Button` `choice`), a ticked dietary pill | `--dur-base`; its halfway hover `--dur-fast` | `--ease-in-out`; the hover `--ease-out` |
| The event sheet's panel switch: a fade and the last 1.5rem from its own side   | `--dur-base`                                | `--ease-out`              |
| The sheet's badge words after a press (`transition-badge-settle`)              | `--dur-base`                                | `--ease-out`              |
| Respond's label ink following the bloom fill                                   | `--dur-base`                                | `--ease-out`              |
| A block opening under a control (`Reveal` with `pace="slow"`): the dietary section and its "Anything else", the gift page's own amount, a gift's reserve form, the chosen member's email and musubi boxes | `--dur-slow`                                | `--ease-out`              |
| The calendar and maps menus opening (`LinkMenu`, `menu-pop`): scaled up from 0.96 and faded in from the corner at their trigger | `--dur-base`                                | `--ease-out`              |
| A FAQ answer opening (`Disclosure`): its box grows as the answer fades in and drops 0.25rem; its `+` turning | `--dur-slow`; the `+` `--dur-fast`          | `--ease-out`              |
| A dialog — the event sheet, the consent prompt, privacy choices (`Modal`)      | at a desk `--dur-slow` in, `--dur-base` out; on touch 250ms fade and 350ms rise in, 150ms out | `--ease-out` in (through `--ui-ease-out`), CSS `ease-in` out |
| A toast (`@shared/toast`)                                                      | 160ms in and out                            | CSS `ease-out` in, CSS `ease-in` out |

**Choreography longer than `--dur-slow` keeps its own time:**

| What                                                                                | Time                                                       | Easing                                      | Scaled |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- | ------ |
| The bloom fill sweeping across Respond once every member has replied (`SWEEP_DURATION_MS`) | 500ms                                              | `--ease-out`                                | yes    |
| The tick drawing in behind it (`--animate-tick-draw`; the hold that ends its draw, `TOTAL_DURATION_MS`, scales with it) | 340ms, after 180ms                  | `--ease-out`                                | yes    |
| The hero scroll cue: a fade, then a 6px drift down and back twice (`--animate-scroll-cue`) | 600ms fade after 1s, then two 2s drifts: 4.6s of motion | `--ease-out`, then `--ease-in-out`           | yes    |
| The scroll cue leaving on the first scroll                                           | 500ms                                                      | `--ease-out`, the default curve             | yes    |
| The hero photo fading in once it loads                                               | 700ms                                                      | `--ease-out`, the default curve             | yes    |
| The closing band settling into or out of its cap, on a live resize across 1536px     | 500ms                                                      | `--ease-out`                                | yes    |
| The unlock reveal after a claim (`unlock-rise` and `unlock-shimmer` in `src/styles/global.css`, ordered by `src/components/unlock-reveal.ts`) | classic: rises of 450–500ms and a 1.2s shimmer, a 200ms beat, cards 120ms apart after 150ms; gala: 350–400ms and 1s, a 150ms beat, cards 80ms apart after 100ms | the rises `--ease-out`; the shimmer one CSS `ease-in-out`, cut at its keyframes | yes    |
| A swipe between the sheet's panels settling (`settleCurve`, `[data-settling]`)       | a critically damped spring with a 0.3s response, started at the finger's speed: a full panel from rest settles in about 0.4s | the spring sampled into a `linear()` at release; a `cubic-bezier()` with the same first slope where the engine has none | yes    |
| The envelope opening (`@cire/envelope`)                                              | its own timeline: `wiki/cire/cire-envelope.md` §Taps, timeline and breaks | —                    | —      |

The swipe's settle is the one easing written at run time: its curve starts at
the finger's speed, which differs with every release, so the sheet samples the
spring into a CSS `linear()` easing at release and runs it as a transition
(the owner's choice, 2026-11-12, englishstreetventures/osn#2197). Its first
stretch moves at the release speed exactly, the curve stops where a fast flick
would pass the panel's rest, and an engine without `linear()` (Chrome before
113 and Safari before 17.2, both inside the browser floor) gets one
`cubic-bezier()` that leaves at the same speed, never passes the rest, and
runs no further the wrong way than the spring.

Three other easings in these tables are no token, each for a reason: `Modal`'s
exit and the toast run curves their shared packages set (`@shared/ui`,
`@shared/toast`), and the unlock shimmer, choreography longer than
`--dur-slow`, is one CSS `ease-in-out` cut at its keyframes, each cut marked
`motion-literal` in `global.css`.

The unlock reveal closes the code form at once, brings the welcome in with a
shimmer on its heading, then lifts the events section and its cards one by
one. The scroll cue, the card's mark, the sheet, the swipe and the reveal are
described with their tests in `wiki/cire/cire-invite-designs.md` (§The hero
scroll cue, §Event card states, §The event sheet, §Corners, labels and
motion); the reveal's guards against a blank or flashing invite in
`wiki/shared/frontend-patterns.md` §Rendering and animation gotchas.

The blocks under a control open a rung slower than the portals' panels, and
the link menus a rung slower than the portals' menus: a guest is reading, and
the owner asked that these openings be felt. The measurement behind the
blocks' rung, and where focus goes when the reserve form closes, are in
`wiki/cire/cire-invite-designs.md` §Corners, labels and motion.

### What must not move

- **A box that holds controls closes at once, unless it is a modal dialog.**
  `Reveal` (`@cire/ui`) drops its content the moment it closes, and the empty
  wrapper finishes closing behind it; a `Disclosure` closes at once; the link
  menus close at once; the unlock reveal's code form leaves the layout before
  anything rises. A modal dialog — the event sheet, the consent prompt,
  privacy choices (`Modal`) — fades and drops out over `--dur-base` at a desk
  and 150ms on touch: it stays modal through the exit, so focus stays inside
  it until the exit ends and nothing behind it can be reached while it moves.
- **Nothing already open animates on first paint.** A `Reveal` that mounts open
  is open; a `Disclosure` open when it first paints does not fade; a reply on
  file loads with Respond already filled and ticked; the sheet's first panel
  arrives with the sheet and does not slide.
- **The focus ring never fades.** A colour change on anything that takes focus
  uses `transition-ui-colors`, which leaves `outline-color` out, never
  `transition-colors` (`tests/styles/focus-transition.test.ts`).
- **No gold fill eases its opacity under a label.** A translucent gold under
  words is a pair no derivation measures; Respond's hover underlines its label
  instead.
- **The event sheet keeps one height** through a panel switch, a swipe and a
  growing form.
- **Nothing that starts by itself moves for more than five seconds** without a
  way to stop it (WCAG 2.2.2): the scroll cue rests after 4.6s of motion.

### Known breaches

None ships today. A move that ships while it breaks a rule above is listed
here with the rule it breaks and the issue that fixes it, and its row in the
tables carries a † mark. None is a pattern to copy, and each entry goes when
its fix lands.

### Reduced motion

`prefers-reduced-motion: reduce` is one global clamp in `global.css`, not a
branch in each component. On `*`, `*::before` and `*::after` it sets every
animation to one run of 0.01ms that starts already finished (a -1ms delay), and
every transition to 0.01ms with no delay, all with `!important`, which beats an
inline style. So the tick is drawn, the scroll cue is there and still, and a
`Reveal`, a link menu's pop, a panel switch or a swipe's settle lands at once.
Spinners are the exception: a still ring reads as a stalled page, so
`.animate-spin` keeps turning, once every 1.5s.

The clamp reaches no other pseudo-element and no script, so these carry their
own gate:

- `Disclosure`'s fade on `::details-content` is declared only under
  `prefers-reduced-motion: no-preference`;
- `Modal` cuts its own transitions, `::backdrop` included, to 1ms;
- the unlock reveal checks
  `matchMedia("(prefers-reduced-motion: reduce)")` and lands at once;
- the envelope never plays: its boot script does not seal the page while the
  query matches.

A new pseudo-element animation or a script-driven motion needs a gate of its own
(`wiki/shared/frontend-patterns.md` §Rendering and animation gotchas).
`tests/styles/reduced-motion.browser.test.tsx` holds the clamp.

---

## 6. Design packs

Each pack — `classic`, `gala` — owns its shell (`src/designs/<pack>/Document.astro`),
its hero, its layout and its unlock reveal's timing, and draws the shared pieces in
`src/components/`. Every pack imports this one stylesheet and declares no
colour, corner or motion token of its own. Adding one:
`wiki/cire/cire-invite-designs.md` §Adding a design.
