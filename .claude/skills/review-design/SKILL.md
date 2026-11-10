---
name: review-design
description: Use when reviewing how a branch changes the look of a screen, or sweeping one surface with --full, against the DESIGN.md or wiki page that governs it and the shared component packages @shared/ui, @cire/ui and @osn/auth-ui. Lists every element the diff draws by hand and the component that already draws it, checks tokens, shape, colour and contrast, focus, motion, type and copy, layout and the tests that hold a look, measures every contrast or geometry claim, and reports U-C/H/M/L findings in the four-field format.
---

Review how the current branch changes the look of a screen, or, when
`$ARGUMENTS` is `--full <surface path>`, the whole of one surface. Report where
it departs from its design system and every element it draws by hand that a
shared component already draws.

`$ARGUMENTS` may name the changed workspaces and the branch. Whether or not it
does, start from the diff.

**This is a review: it reports and changes nothing.** No edit to a tracked file,
no commit, no `gh` write. The session that dispatched you fixes what you find.

**The rules live in the documents, not here.** Each surface's look is settled in
its `DESIGN.md` or wiki page, in `wiki/shared/component-library.md` and in
`wiki/shared/design-tokens.md`. This file says how to hold a branch against
them and what to look for; it restates none of their values. Where this file
and a document disagree, the document wins, and you say so on its line in
`## Coverage`.

## Step 0 — Write the report skeleton before you review anything

Do this before the diff, before reading a line of source. The file is the
deliverable: a run that leaves a differently-shaped file has produced nothing,
however good the review inside it. Writing the shape now means the rest of the
run only fills it in.

Copy this verbatim. The report file is `DESIGN-REVIEW.md` unless the task named
another:

```bash
cat > DESIGN-REVIEW.md <<'EOF'
## Design findings

None

## For the tracker

None

## Components

None

## Measurements

None

## Coverage

None

## Sections checked

None
EOF
```

Those six `##` headings are the whole permitted set, and that is their order.
Replace a `None` as you fill its section in; leave it where the section really
is empty. Never add a seventh `##`. The ones that get invented are
`## Summary`, `## Screenshots`, `## Verdict` and `## Scope and method`, and none
of them is allowed: a summary sentence goes at the top of `## Design findings`,
what you saw rendered goes in `## Measurements`, and an environment caveat goes
at the end of `## Sections checked`.

**From here on this file is only ever edited, never rewritten.** Every later
change replaces a `None`, or inserts text under a heading that already exists.
A single write to `DESIGN-REVIEW.md` at the end discards the shape this step
established. If you find yourself about to write the whole file, read it back
first and edit what is there.

**A finding is a bold label, not a heading.** `U-H1` goes on its own line as
bold text inside `## Design findings`, as **Finding format** shows below.
Promoting it to `## U-H1` adds a top-level section and fails the shape check.

**Record each finding the moment you have it**, and fill `## Components`,
`## Measurements`, `## Coverage` and `## Sections checked` file by file as each
one finishes. A run that a usage limit stops keeps what the file holds, and a
reviewer resumed later starts from that file, not from memory.

## When a step cannot run

**No step is a stop.** The step that most often cannot run is Step 5's rendered
look: no Chrome tools, no dev server, or a brief that says you are not alone in
the worktree. Steps 1 to 4 read source, documents and stylesheets from disk and
need none of that, so they run regardless, and a contrast check can still be
measured from token values. Record what did not run, and why, in
`## Measurements` and at the end of `## Sections checked`.

## Step 1 — Resolve the scope and its documents

Resolve the base branch first. A stacked branch does not merge into `main`, and
local `main` lags `origin/main` in the worktree layout:

```bash
BASE=$(git config --get branch.$(git branch --show-current).gh-merge-base || echo main)
DIFF_BASE=$BASE
git merge-base --is-ancestor "$BASE" "refs/remotes/origin/$BASE" 2>/dev/null && DIFF_BASE="refs/remotes/origin/$BASE"
git diff --name-only "$DIFF_BASE"...HEAD
```

With `--full <surface path>`, the scope is the surface's own markup and style
instead: `git ls-files '<surface path>/src'`, less its tests.

Keep that file list. Every file on it gets a verdict in `## Coverage`, including
the ones that draw no screen.

**Map each file to its surface and the document that governs it.** The surface
is the workspace that owns the file: walk up to the nearest `package.json` and
read its `name`. The document comes from the table in the `design-system`
skill's Step 1 (`.claude/skills/design-system/SKILL.md`); read that table, not
the rest of the skill, whose design-skill advice is for whoever builds. The
table goes stale, the filesystem does not, so check it:

```bash
find . -name DESIGN.md -not -path '*/node_modules/*'
```

A surface with no `DESIGN.md` and no wiki page on its look has no locked
system. Say so in `## Coverage`, and hold it to the component library, the
token contract and its own sibling screens.

**Note which shared packages the surface may import**, from the `dependencies`
in its `package.json`: `@cire/ui` serves the cire surfaces alone, and
`@osn/auth-ui` serves `musubi/social` alone. A component the surface cannot
import is not a replacement you can propose.

Write the surfaces and their documents at the top of `## Coverage` now.

## Step 2 — Read the documents, the parts the diff touches

The governing documents run past a thousand lines; read the sections the diff
reaches, found with `grep -n '^#' <document>`. Always read:

- the governing document's component section (`cire/host/DESIGN.md` §7,
  `cire/vendor/DESIGN.md` §Components, `pulse/DESIGN.md` §Component Catalog)
  and the sections on colour, type, shape and motion the changed lines touch;
- `wiki/shared/component-library.md` §The three layers, §Where components live
  and §What a call site may set, and what it may not;
- `wiki/shared/frontend-patterns.md` §Rendering and animation gotchas, the
  layout and motion bugs no unit test sees.

Then read every changed file in full: the whole file is in scope, not only the
changed lines (Finding format says how the tier differs).

## Step 3 — The shared component first

This is the check the lens exists for. A copy drawn by hand passes the lint
gate, because it is built from on-token classes, and it drifts from the
component the day the component changes. For every element the diff draws by
hand, find out whether a shared package already draws it.

**List the hand-drawn elements.** An element is hand-drawn when it is a raw tag
or a class bundle doing a job a component does. Where to look:

| Drawn by hand | Look for |
|---|---|
| a `<button>`, or an `<a>` styled as a pill or a box | `Button` and `buttonClass` (`@cire/ui` has its own variant vocabulary), `proseLinkClass`, the surface's link pill |
| a bordered, rounded, padded box | `Card` and `cardClass` |
| small capitals: `uppercase` with a `tracking-*` step at the small text step | `Eyebrow` for a label over a region; `Chip`'s `caps` treatment for a status word |
| `<details>` and `<summary>` | `Disclosure` |
| a tinted box or line carrying a message | `Notice` (`Note` only where the owner placed one) |
| a pill holding a state word or a tag | `Chip`, `Badge` |
| `<input type="checkbox">`, `<input type="radio">`, a `role="radio"` group | `Checkbox`, `RadioGroup`, `Button`'s `choice` or `glass` variant |
| `<input>`, `<select>` or `<textarea>` with classes of its own, a label and hint stacked by hand | `Input`, `Select`, `Textarea`, `Field`, `controlClass`, `Label` |
| `<input type="file">` | `FileInput` |
| menu, popover, tooltip or dialog markup | `DropdownMenu`, `Popover`, `Tooltip`, `InfoPopover`, `Modal`, `Dialog` |
| a strip of tabs | `SegmentedTabs`, `Tabs` |
| a circle with initials or a face | `PersonAvatar`, `Avatar` |
| a grey placeholder block or a spinner | `Skeleton`, `Loading` |
| a message bubble, thread or composer | `MessageThread` and its parts |
| a footer or a legal page's frame | `site-footer.astro`, `legal-layout.astro` |
| an empty list's message | `EmptyState` |

The table says where to look, not what exists: the packages grow faster than
any list of them.

**Look each one up**, in this order, and stop at the first hit:

1. The package catalogue: `wiki/shared/component-library.md` §Where components
   live and the governing document's component table, then what is actually
   there — `ls shared/ui/src/ui cire/ui/src osn/auth-ui/src`, and the
   `exports` of each package's `package.json`, which give the import path.
2. The class bundle itself, in the packages:
   `git grep -n '<two or three of its classes>' -- shared/ui/src cire/ui/src osn/auth-ui/src`.
   A bundle that lives in a package is that package's component.
3. How the surface's other screens draw the same thing:
   `git grep -ln -e '<Eyebrow' -e 'cardClass(' -- '<surface>/src'`. Sibling screens
   that use a component for it are the evidence a reader can check.

**Record every element in `## Components`**, one line each: the file and line,
what it draws, the component you checked, and the verdict — `U-<id>`, `uses
<Component>`, or `none exists` with the searches that found nothing.

**What is a finding:**

- A hand-drawn copy of a component the surface can import. The Solution names
  the component, its import as the surface's other files write it
  (`import Eyebrow from "@cire/ui/eyebrow"`), and the variant and props that
  match, read from the component's source or its row in the document.
- A shared component restyled at its call site beyond what §What a call site
  may set allows. `shadcn/no-restyle` refuses most of these at lint; a class
  string built elsewhere and passed in is one it does not see.
- Two components for one job: a new component in an app's `src/` that
  duplicates a package's, or each of two surfaces of one product carrying its
  own. The Solution uses the package's, or moves the one component into the
  package, which ships as a pull request of its own
  (`wiki/conventions/stacked-prs.md` §Frontend: one component per pull request).
- A component two surfaces need and no package has: a finding proposing it for
  the package. One that one surface alone needs is not.

A hand-drawn control is often an access gap as well — keys, focus, labels or
ARIA the component would have given it. That part is not a `U-` finding; What
this lens leaves to others says how to split the two.

## Step 4 — Hold every changed file against the documents

Work each section below against every file on the Step 1 list that draws a
screen. A section nothing in the scope reaches gets one line under
`## Sections checked` saying so; every other gets the files and lines you
looked at and the verdict. The grep beside each finds the lines to read; a hit
is a reason to read, never a verdict. Run it both ways: over the diff, for the
lines the branch adds or changes, and over the whole file, for the lines it
does not touch. Under `--full` the diff is empty, so only the second runs.

```bash
git diff "$DIFF_BASE"...HEAD -- <file> | grep -nE '<pattern>'   # the lines the branch adds or changes
grep -nE '<pattern>' <file>                                      # every line of the file
```

### Tokens, never raw values

`rounded-\[|#[0-9a-fA-F]{3,8}|oklch\(|rgba?\(|hsla?\(|[0-9]ms|cubic-bezier\(|style=|<style`

- Colour, radius, spacing, type step, tracking, leading, duration and easing
  come from the surface's tokens and the `ui-*` contract
  (`wiki/shared/design-tokens.md` §The tokens). `shadcn/no-arbitrary-values`
  refuses an arbitrary Tailwind value at lint, so look where it cannot: a
  `style` attribute, a stylesheet, an `.astro` `<style>` block, and a value
  hidden in an allowed `var()` or `calc()`.
- Where the governing document takes its steps from the contract, Tailwind's
  own step is a finding. The cire apps do (`cire/host/DESIGN.md` §3, The
  steps): there `text-xs` stands for `text-ui-xs`, `tracking-wide` for a
  `tracking-ui-*` step, and `leading-none` is kept to the glyphs and short
  labels that section names. A document that keeps Tailwind's steps and names
  only its own off-scale ones (`pulse/DESIGN.md` §Named type tokens) holds its
  surface to those instead.
- A colour that is content, not chrome — a couple's chosen palette, a swatch
  showing the colour it chooses — is data, not a raw value.
- A surface reading another surface's tokens is a finding. Two surfaces keeping
  separate copies of one token on purpose is not: the cire host and vendor
  portals keep their own colours by the owner's choice.

### Shape and size

`rounded|h-|min-h-|size-|px-|py-|p-[0-9]|uppercase`

- A corner paints a role, not a size: a card, a field, a popover and an action
  each take their role's step from the document's corner table
  (`cire/host/DESIGN.md` §4 for every cire app). A box at the wrong role is a
  finding even when its value is on the scale.
- Heights follow the document's steps for the role: a toolbar filter, a form
  field, a composer, the guest site's touch floor.
- An action takes the shape and the case its document gives it. In the cire
  apps an action is a pill (`cire/host/DESIGN.md` §4) and its label is in
  sentence case (§7, Labels), so a label in capitals or `uppercase` on an
  action is a finding there. In Musubi every Button variant is a pill, ghost
  and link included (`musubi/social/DESIGN.md` §Radii). Where the document is silent, the
  surface's sibling screens settle it.

### Colour and contrast

`text-|bg-|border-|ring-|fill-|stroke-|opacity-|dark:|data-theme`

- Every text pair clears its document's contrast floor — 4.5:1 for text, 3:1
  for large text and for the parts of a control — in light and in dark, at
  rest, hovered, focused, open and chosen, on every ground it sits on: the
  page, each card fill, a raised surface, a tinted row. A pair measured under
  its floor is a finding; one not measured is Step 5's to measure.
- In the cire apps, gold words use the readable gold (`--gold-ink`,
  `text-ui-accent-ink`), never the decorative gold `cire/host/DESIGN.md` §2
  keeps off text.
- A new pair, or a moved one, that the surface's contrast test does not hold is
  a finding naming the test to extend (`cire/host/tests/styles/` holds them in
  the host portal).

### Focus

`outline|focus|ring|forced-colors|transition-(colors|all)`

- Where the document says a focus ring never animates — `cire/host/DESIGN.md`
  §4, Focus, for every cire app; `musubi/social/DESIGN.md` §Focus for Musubi —
  `transition-colors` or `transition-all` on anything that takes focus is a
  finding: both fade `outline-color` too, so the ring arrives late. The
  Solution names the properties instead (`transition-ui-colors` in the cire
  apps and Musubi).
- A focus ring that is missing is not this lens's. An element that takes focus
  under `outline-none`, with no outline of its own on focus, shows no focus in a
  contrast theme (forced colours): `outline-none` removes the outline there too,
  and the theme drops a `ring-*` box shadow. That is no visible focus, and goes
  under `## For the tracker` (What this lens leaves to others).

### Motion

`transition|animate|duration-|ease-|@keyframes|startViewTransition|motion`

- Durations and easings come from the document's ladder (`--dur-*`, `--ease-*`
  in the cire apps), never a literal.
- CSS transitions or the View Transitions API, not a JavaScript animation, for
  anything CSS can move; a new animation dependency is a finding.
- The surface's motion law holds. The host portal's container is continuous
  (`cire/host/DESIGN.md` §1): a panel that unmounts and remounts on a tab switch
  breaks it.
- The governing `DESIGN.md` has a motion section. One without it is a Medium
  finding on the document, and every motion the diff adds is then held to the
  nearest sibling surface's rules.
- Motion respects `prefers-reduced-motion` the way the surface's stylesheet
  already does.

When the diff adds or changes a transition, keyframe, view transition, spring or
gesture handler, hold each changed animation to the craft bar in
`.claude/skills/review-animations/STANDARDS.md` and the ten standards at the top
of `.claude/skills/review-animations/SKILL.md`: whether it needs to animate, how
often the user sees it, its easing, duration, origin, the properties it moves
and how it interrupts. Read both files; never invoke the skill. It is marked
`disable-model-invocation`, opens by answering with a fixed greeting, and writes
its own tiers, where this report writes `U-` findings. For a gesture, also read
`.claude/skills/gestures/SKILL.md`; for a claim that an animation drops frames,
`.claude/skills/animation-performance/SKILL.md`.

- **The document is what ships, and the owner chooses.** Hold the animation to
  the duration, easing, transform origin or reduced-motion rule in the
  `DESIGN.md` or its stylesheet: a miss against the document is High, as any
  broken document rule is, unless the branch changes that value in the
  `DESIGN.md` and its pull request body quotes the owner's answer and where it
  was given; a `DESIGN.md` change with no such record is High. Where `STANDARDS.md` asks for something different, do not
  drop it: write a finding for the owner's call, as the paragraph below on a look
  the documents do not settle says, with both values, the document's file and
  line, and the skill's. Say in `## Coverage` which value you held the animation to.
- **A miss no document rules on is Medium**, or Low where it is polish no one
  sees at a glance. A motion on a keyboard action or a high-frequency control is
  Medium; so is an animation of `width`, `height`, `top` or `left` where
  `transform` or `opacity` would do.
- **A skill's code is never the fix.** Its examples use `framer-motion` and
  `motion/react`. The Solution names CSS, the View Transitions API or the
  library the surface already imports, as the second bullet above says.
- Record each animated file under `## Coverage` with the standards you checked.
  A diff with no animation says so there in one line.

### Worst-case content

When the diff draws a component that shows user data, read
`.claude/skills/break-ui/SKILL.md` and `.claude/skills/break-ui/CATALOG.md` as a checklist, never
invoking the skill: it writes a demo toggle into the code, and this review
changes nothing. Walk the changed markup against each case it lists: a long or
unbroken name or email, a one-letter name, a missing field, a huge count, zero
items, non-Latin text, emoji. Report a case that would clip, overflow or break
the layout as a `U-` finding, High when the diff adds the line. Record the cases
you could only reason about as `unmeasured` in `## Measurements`, with the method.

### Type and copy

`<h[1-6]|font-|text-ui-|tracking-|leading-|uppercase|italic`

- Family, step, tracking and leading come from the contract and the document's
  type rules; a display face appears only where the document rations it.
- One role takes one treatment: every eyebrow on a surface at the same
  tracking step, every field label alike.
- **A line earns its place.** A heading, an eyebrow or a label names a control,
  a region a reader moves to, or data. A line that only repeats what the screen
  already says — an eyebrow restating the chosen sub-tab, an eyebrow over a
  title that says the same thing in other words — is a finding: give its file
  and line and quote what it repeats (`cire/host/DESIGN.md` §3 on the portals;
  the owner's rule wherever the document is silent).

### One look per meaning

`aria-pressed|aria-checked|aria-selected|aria-current|aria-expanded|data-state|selected|chosen|active`

- A meaning the document draws one way is drawn that way: the cire portals'
  glass for one of several, the gold wash for a chosen row, the chosen tab's
  weight. A second look for a meaning that has one is a finding, a High on a
  changed line when a document rule draws the meaning, a Medium when only the
  sibling screens do (Finding format).
- The same control in the same role looks alike across screens. Compare with
  the sibling screen that draws it, by file and line.

### Layout

`@media|sm:|md:|lg:|xl:|@container|overflow|truncate|fixed|sticky`

- A component that sits in a pane responds to its own box with a container
  query, not to the viewport with a media query, wherever the document says so
  (`cire/host/DESIGN.md` §5).
- Nothing clips, overlaps or scrolls sideways at a phone width or a desktop
  width; text that can grow has room to wrap or a deliberate truncation.
- The gotchas in `wiki/shared/frontend-patterns.md` §Rendering and animation
  gotchas apply: a `transform` on an ancestor of something `fixed`, `sticky`
  offsets against the scrollport, `overflow: hidden` making a scroll container.

### Boundaries between surfaces

- An edit to `@shared/ui` or `@shared/design-tokens` changes every surface that
  imports it. List them:
  `git grep -l '"@shared/ui"' -- '*/package.json' '*/*/package.json'`. A change
  that would move another product's screens, which the branch's issue does not
  say the owner asked for, is a finding: one product's work leaves the others
  as they look.
- A primitive never imports upward: product colour names, a session or
  `@osn/client` in `@shared/ui` is a finding
  (`wiki/shared/component-library.md` §The three layers).
- Cire's `Note` stands only where the owner placed one (`cire/host/DESIGN.md`
  §7); a new `Note` anywhere else is a finding whose Solution is `Notice`'s
  `accent` tone.

### Tests that hold a look

- A contrast pair, a height, a corner or a position the change sets or moves,
  which the document says a browser test holds, gets that test changed with
  it. Geometry and contrast are checked in real Chromium
  (`wiki/conventions/browser-tests.md`); a layout assertion in a jsdom or
  happy-dom test cannot fail and holds nothing.
- A browser test passes on Linux CI as well as on a Mac: it measures an anchor
  at the moment the code measures it, never reads layout straight after an
  animated open, and gives a wait enough time on a loaded runner.
- A package that gains a `test:browser` script is named in `ci.yml`'s browser
  legs; until it is, CI runs none of its browser tests, and
  `scripts/tests/deploy-workflows.test.ts` fails.

## Step 5 — Look at it rendered, and measure

**Render it only when you may build.** A dev server writes caches and build
output into the checkout, so start one only when the brief says you are alone
in the worktree, or use a server the brief names as already running. Otherwise
the rendered look is `NOT RUN` with that reason, and the measurements below are
taken from token values instead.

**How.** The `design-system` skill's Step 4 holds the command for each
surface's dev server and the lab stories a UI-package component is looked at
through; hosts are in `wiki/conventions/devloop-urls.md`. Prefix each command
with `CLAUDECODE=`, and never run a bare `bun run dev`, which starts every
workspace in every worktree that runs it. Drive the page with the Chrome tools
(`mcp__claude-in-chrome__*`): at a phone width and a desktop width, in light and
dark, in every state the change draws — at rest, hovered, focused, open,
chosen, disabled, empty, loading and in error. Stop every server you started
before you finish.

**Measure; never estimate.** A screenshot shows that something looks wrong; a
number says by how much, and only a number goes in a finding.

- **Contrast.** A ratio holds only between two opaque colours, and
  `contrastRatio` from `@shared/color` checks neither: it ignores alpha, and
  returns `null` for any format but hex, `rgb()`, `hsl()` and `oklch()`, so a
  computed `color(srgb …)`, `oklab()` or `color-mix()` reads as nothing. Never
  pass it a colour you have not flattened.
  - **In the browser**, flatten by painting. Paint the page's ground, then
    every ancestor's `background-color` from the outermost in, then the
    element's own, on a one-pixel canvas, and read back plain `rgb`; paint the
    text colour over that for the other side of the pair. `composite()` and
    `backdropOf()` in `cire/host/tests/styles/chip-contrast.browser.test.tsx`
    do exactly this: run them through the Chrome tools' JavaScript with their
    type annotations removed, reading the surface's own page ground where they
    read cire's `--bg`. The canvas reads every colour format the browser does.
  - **From token values**, with no browser, flatten by sum: each sRGB channel
    is `alpha × colour + (1 − alpha) × ground`. This takes an `oklch()` colour
    with or without alpha over an opaque ground, prints the flattened colour
    and the ratio, and refuses anything else:

    ```bash
    bun -e '
    import { contrastRatio, oklchToRgb, parseColor, parseCssColor } from "./shared/color/src/color.ts";
    const [colour, ground] = ["<text colour, or a translucent ground>", "<the opaque colour under it>"];
    const alpha = (v) => /\/|rgba|hsla|^#(.{4}|.{8})$/i.test(v.trim());
    const c = parseColor(colour), g = parseCssColor(ground);
    if (!c || !g || alpha(ground) || (alpha(colour) && !colour.trim().startsWith("oklch(")))
      throw new Error("unmeasured: a format this cannot read, or a ground that is not opaque");
    const f = oklchToRgb(c), mix = (k) => Math.round((c.a * f[k] + (1 - c.a) * g[k]) * 255);
    const over = `rgb(${mix("r")}, ${mix("g")}, ${mix("b")})`;
    console.log(over, contrastRatio(over, ground));'
    ```

    A translucent ground is flattened first: run it as the colour over the
    ground under it, and use the `rgb()` it prints as the next run's ground.
    Name the tokens and the theme block you read them from. A translucent ink
    passed in unflattened reads as its opaque self, which can be several times
    the contrast it has.
  - A `null`, a refusal, or a ground you cannot trace down to an opaque one is
    `unmeasured`, never a ratio.
- **Geometry.** Read `getBoundingClientRect()` and the computed `height`,
  `border-radius` and padding at each width. Never read a size off a
  screenshot.

Write every number into `## Measurements` as you take it: what, where (file and
line, state, theme, width), how, the number and the floor it is held to.

**A contrast or geometry finding quotes a measured number.** A check you could
not run is not a finding with a guessed ratio: list it in `## Measurements` as
`unmeasured`, with the element, the state and the method that would measure it,
so the session that dispatched you can run it. A number nobody measured, written
as though someone had, is the one fault this lens must not commit.

## What this lens leaves to others

- **Accessibility that the compliance programme tracks** —
  `wiki/compliance/eaa.md`, and the checks `review-security` runs in §EAA: no
  keyboard path to a control, no visible focus (none in a contrast theme
  counts), no programmatic label, a state shown by colour alone, an image
  without alt text, media without captions, a hand-built ARIA widget where a
  Kobalte primitive exists. Such a defect belongs in the private tracker, and a
  `U-` ID is public text, so it gets no `U-` ID. Write it under
  `## For the tracker`, in the four fields, headed by the lens and the tier
  `review-security`'s rubric would give it, and no ID of its own:

  ```
  **For compliance, C-M** — <short title>
  **Issue:** …
  **Why:** …
  **Solution:** …
  **Rationale:** …
  ```

  The dispatching session gives it the next free ID in that tier once every
  reviewer has returned.
- **One element can carry both kinds.** A hand-drawn `role="radio"` group, or
  a hand-built menu, copies a shared component — a `U-` finding — and is a
  hand-built ARIA widget — a hand-off. Write both, on the same file and line.
  The `U-` finding states the look alone: the component it copies, the drift,
  and the component that replaces it. It names no access gap — a missing key
  path, focus, label or ARIA role — because a `U-` finding is filed in public
  and that text would publish a compliance defect. The access gap goes in the
  hand-off.
- **Contrast under the document's floor stays here**, as a `U-` finding: it is
  the design system's own contract, held by its own tests. A shortfall in a
  file the branch changes is fixed on that branch, like every in-scope finding;
  a `U-` issue is filed only for one outside the branch's scope.
- **Security, performance, state and test coverage** belong to their own
  lenses. A defect of theirs you notice goes on one line at the end of
  `## Sections checked`, with no ID.

## Finding format

IDs are `U-C1`, `U-C2`, … Critical; `U-H1`, … High; `U-M1`, … Medium; `U-L1`, …
Low. The counter increments within each tier across the whole report. Each
finding uses exactly this structure:

```
**U-H1** — <short title>
**Issue:** What is drawn, with the file and line, and the rule or component it departs from: the document's path and section, or the component's file.
**Why:** What a person sees: the screen it now differs from, by file and line; the state that reads wrong; the measured number and its floor.
**Solution:** The change: the component with its import, variant and props; the token; the class. Not "follow the design system".
**Rationale:** Why that change holds: the rule it restores, or the component that keeps every screen in step when it changes.
```

Tiers:

- **Critical (U-C)** — the screen fails people in ordinary use: content
  clipped, hidden, overlapping or off-screen at a width the surface supports,
  or text measured below 3:1 in a theme it ships.
- **High (U-H)** — a departure the documents rule out, on a line the diff adds
  or changes: a hand-drawn copy of a component the surface can import, a raw
  value where a token exists, a pair measured under its contrast floor, a
  restyled shared component, a second look for a meaning the document draws
  one way, any other rule of the governing document broken.
- **Medium (U-M)** — the same departures on a line the diff does not touch, in
  a file it changes; on any line, a second look for a meaning that only the
  sibling screens settle, which no document rule names; a decorative line
  where no document rules on it; a look contract no browser test holds; a
  component two surfaces need that no package has.
- **Low (U-L)** — polish no one sees at a glance: a class that repeats what its
  component already sets, a step off its siblings' that no rule names.

In a `--full` sweep every line is in scope, so the tier is the one a changed
line would take.

**A look the documents do not settle, or settle differently from a skill, is the
owner's.** When two answers are defensible and no rule chooses between them, or
the governing document names one value and a skill's checklist another, the
finding says so, names the options in the Solution (the document's with its file
and line), and leaves the choice to the owner; whoever fixes it shows the owner
each option rendered, light and dark, before asking. A branch that followed its
document where a skill differs gets this finding at Low, never High.

If the review finds nothing, write "No design concerns found." at the top of
`## Design findings` — and still fill every other section.

## Report shape

The file already exists — Step 0 wrote it, with the six sections in order.
Keep that. This section says what goes in each one.

`## Design findings` holds the `U-` findings, most severe first, with a summary
sentence at the top if you want one.

`## For the tracker` holds the accessibility defects handed on, in the shape
What this lens leaves to others gives, or `None`.

`## Components` lists every hand-drawn element from Step 3, one line each: the
file and line, what it draws, the component checked, and the verdict.

`## Measurements` lists every number you took, with how you took it, and every
check you could not run, marked `unmeasured`, with the method that would run it.

`## Coverage` opens with each surface and the document that governs it, then
lists **every file** from Step 1, one line each, with a verdict — a finding ID,
`For the tracker`, `clear`, or `not a screen` — and whether it was looked at
rendered or why not.
A file you did not open is not clear; say so and why.

`## Sections checked` lists each Step 4 section with the files and lines you
looked at and the verdict. A section with no file and line beside it was not
checked.

### Check the file before you finish

Once every file is covered, end the file with one line that is not a heading:
`**Review complete.** <n> findings: <tally by tier>; <m> for the tracker.`
Neither count below depends on that line, so the counts pass on a partial file
too. A file without the line is a partial review, and a resumed run finishes
it.

```bash
grep -c '^## \(Design findings\|For the tracker\|Components\|Measurements\|Coverage\|Sections checked\)$' DESIGN-REVIEW.md
grep -c '^## ' DESIGN-REVIEW.md
```

Both must print `6`. Under 6 means a heading was renamed or demoted; over 6
means a section of your own crept in — a summary sentence belongs at the top of
`## Design findings`, a screenshot's lesson in `## Measurements`, an
environment caveat at the end of `## Sections checked`.
