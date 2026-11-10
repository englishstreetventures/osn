# @tools/lab

## 0.3.43

### Patch Changes

- 3abdb2b: `Button` gains two opt-in props; a button that uses neither draws as before.

  `variant="link" size="inline"` is a link set inside a sentence: underlined at
  rest, in the sentence's own size, line height and weight, adding no height to
  the line. An `<a>` wearing `buttonVariants({ variant: "link", size: "inline" })`
  wraps with the text, and its focus ring closes round each line. A standalone
  `link` still underlines on hover only.

  `busy` marks a wait the button started. While busy it keeps keyboard focus, sets
  `aria-busy` and `aria-disabled`, refuses activation (a click, Enter, Space, and
  the form submission they would make, with or without an `onClick`), dims as a
  disabled button does except while focused from the keyboard, where it stays at
  full strength so its focus ring keeps its contrast, and draws the 20px `Orb`
  before the label the caller passes. The orb loads as a chunk of its own,
  fetched only by a page holding a `Button` that carries a `busy` prop.

  `ButtonProps` is now a union: `inline` goes with `link` only, and `busy` is not
  accepted at `icon` or `inline`. A caller holding a variant and a size in
  variables narrows them per member. The box classes (`inline-flex`, gap, no
  wrap, type step, weight) move from the base string into each box size; every
  existing variant and size keeps the same class set, except that `sm` drops the
  `text-ui-base` its own `text-ui-sm` overrode. No computed style changes.

  The lab's `shared/ui/Button` gains `Inline` and `Busy` stories, and its
  Playground a `busy` control.

- bceeafe: `Field` takes `labelTreatment`, `"caps"` by default or `"plain"`. A field that
  does not pass it draws exactly as before, so cire's forms do not change.

  `plain` draws the label as `Label` draws it by default: the words as written,
  full ink, weight 500, the control type step. The hint, the errors, the gaps and
  the wiring (`id`, `aria-describedby`, `aria-invalid`) are the same in both, and
  `labelHidden` wins over either. `Label` and the plain label take their classes
  from one file, `label-classes.ts`, so the two cannot drift; `Label` draws as
  before.

  `Field` now reads its `hint` once and holds it, so a hint written as JSX is
  built once rather than on every read. It still follows a hint that changes or
  goes away, and the DOM it draws is unchanged.

  The lab's `shared/ui/forms` gains `PlainLabels` and `FieldPlayground`.

- 4ce452e: Add `Orb` (`@shared/ui/ui/orb`): a dotted sphere drawn into a canvas that moves
  while something is in progress, in one of nine states at 20 or 64px. Its ink
  is the text colour it inherits, so it reads on whatever ground that text is set
  for. It moves for five seconds at most, then holds one still frame; it holds
  that frame from the start under `prefers-reduced-motion: reduce` and follows a
  change of that preference. It stops drawing off screen and in a hidden tab,
  keeps every orb on one animation loop and one clock, sizes its bitmap from the
  box it measures, and caps it at two device pixels per CSS pixel. The canvas is `aria-hidden`; it
  belongs inside a control whose own label says what is happening. `Button`'s
  `busy` draws it.

  The drawing engine is upstream's thinking-orbs engine (MIT), vendored byte for
  byte into `shared/ui/vendor/thinking-orbs/` at a pinned commit. The export
  points TypeScript at a types-only `src/ui/orb-api.ts`, so a consumer's type
  check never reads the engine.

  The lab gains `shared/ui/Orb` (`States`, `InButtons`, `Playground`) and an
  `Orb` row on the `shared/ui` overview.

  `scripts/verify-vendored-anti-slop.sh` becomes `scripts/verify-vendored.sh
  <tree> [base-ref] [repo-root]`, which checks any vendored tree; CI's
  `script-tests` job runs it on every tree `scripts/vendored-trees.txt` lists.

- Updated dependencies [3abdb2b]
- Updated dependencies [bceeafe]
- Updated dependencies [4ce452e]
  - @shared/ui@0.12.0

## 0.3.42

### Patch Changes

- Updated dependencies [e71aee5]
  - @shared/design-tokens@0.5.0
  - @shared/ui@0.11.1

## 0.3.41

### Patch Changes

- Updated dependencies [f2c7a76]
  - @shared/ui@0.11.1

## 0.3.40

### Patch Changes

- d3fe597: Overlays leave faster and smaller than they arrive, and each motion token says what it is for. `tokens.css` adds `--ui-dur-exit` (80ms), `--ui-scale-enter` (0.96), `--ui-scale-exit` (0.98), `--ui-distance-enter` (24px) and `--ui-distance-exit` (8px), each with a one-line job comment, and `CONTRACT_SCALAR_TOKENS.motion` lists them. `animate-out` runs `--ui-dur-exit`; `zoom-in` and `zoom-out` replace `zoom-in-95` and `zoom-out-95` and read the scale tokens. Under `prefers-reduced-motion: reduce`, `animate-in` and `animate-out` run nothing: the old reduced-motion rule matched no overlay, so `Dialog`, `Popover` and the default `DropdownMenu` still moved.

  In `@shared/ui`, `Dialog`, `Popover` and both `DropdownMenu` looks take their scale from the tokens; `Popover`, `Tooltip` and the default menu grow from their trigger. `Tooltip` opens after 400ms, goes at once with no exit (the pointer can still cross onto it), and a neighbour opened within 300ms of another closing carries `data-instant` and does not animate. `Modal` exits in 150ms by default (was 200ms), sinking 8px to 0.98 rather than 24px, and its backdrop fades out with it. Musubi's `DESIGN.md` names the shared overlay motion; the lab's motion story reads the new duration.

- Updated dependencies [d3fe597]
  - @shared/design-tokens@0.4.0
  - @shared/ui@0.11.0

## 0.3.39

### Patch Changes

- 11685a5: Musubi's stylesheet takes on the base rules its screens were missing. Readable small text (handles, statuses, hints, "Loading…" lines) moves from `text-subtle` to `text-muted-foreground`, and `--subtle` darkens to `#8d8d8d` in light so the icons and ornaments that keep it clear 3:1 on every ground; the contrast contract now holds `--ui-ink-tertiary` without a waiver. Text fields take an 8px corner (`--ui-radius-field`) while buttons stay pills. A bare `border` draws the hairline instead of ink; a bare-bordered field keeps its ink edge. Every element reached from the keyboard gets the house focus outline, the account-menu triggers included, drawn inside the box where a row would clip it (the bottom bar, section tabs, the profile switcher). `transition-ui-colors` replaces `transition-colors`, so the outline lands at once. The theme menu is now `@shared/ui`'s `DropdownMenu` with radio rows, so it matches the account menu and a screen reader hears which theme is on. The current bottom-bar tab draws a bar along its top edge as well as full ink. The legal pages sit on Musubi's type scale: the body through `.prose-legal`, the title, date and draft notice through the scale's own steps. Discover's suggestions are `Card`s; the organisation page's loading blocks and the search fields' "@" sit on the scale. `@osn/auth-ui`'s `DESIGN.md` records how those base rules reach its views in Musubi. The lab drops its copy of `transition-ui-colors`, which it now takes from Musubi's stylesheet, and its radius stories say Musubi's fields are 8px.

## 0.3.38

### Patch Changes

- Updated dependencies [6c81633]
  - @shared/ui@0.10.3

## 0.3.37

### Patch Changes

- Updated dependencies [6dbdb99]
  - @shared/ui@0.10.2

## 0.3.36

### Patch Changes

- 9ff12cf: `cire/ui/SkeletonOutline` stories: bars for a legend line and a sentence that wraps, a framed table's rows with blocks, a glyph and a sortable head drawn as words, a stacked phone row with a switch, each beside the same markup loaded, and a playground with width, motion scale and a loaded switch.

## 0.3.35

### Patch Changes

- 29b6067: The `cire/ui/Button` stories show the `glass` and `bar` variants and the `form` size, and a new "the portals' pills" story sets the portals' two pill tokens beside a panel without them; the corner captions read the 28px icon circle. The portals' pills story draws `bar` at rest, open and at `sm`, beside an open `quiet` row action.
- 40ded7d: A `cire/ui/DietaryPresets` story group: the wrapped pills with two ticked, the phone's scrolling track and nothing ticked, in cire's light and dark mapping.
- 122bc70: `cire/ui/Skeleton`'s in-place story draws the host portal's own sizes: the RSVP table's legend room, head row and 56px rows a hairline apart, and the overview's band over its 344px cards. The row story and the playground's heights are the host's too.

## 0.3.34

### Patch Changes

- 9d3a9a1: The lab gains `cire/ui/Skeleton`: each stand-in in cire's dark and light mapping, captioned with its painted corner and fill; the shapes in place on the RSVP page's view bar and table and in a grid of cards; and a playground with what it stands in for, a height and the pulse's pace.
- 9d2302b: The lab shows `cire/ui/MessageThread`: a thread on the host's page and in the vendor's card, long messages, a tapped time, the info menu, an undelivered message, the empty, loading and failed states, and the reply box, in cire's light and dark mappings.
- Updated dependencies [5be7d49]
  - @shared/ui@0.10.1

## 0.3.33

### Patch Changes

- 7693c74: Add `cire/ui/PersonAvatar` stories: a photo from a drawn fixture, each stand-in, a ringed stack and the account trigger, on both of cire's ramps.
- d32340d: Add `cire/ui/SignInPanel` stories: idle, connecting, each sign-in error line and an unknown marker, each in its card on both of cire's ramps.
- d7f132f: Add `cire/ui/Wordmark` stories: at rest in a mock top bar, live hover and focus with the ring's gap to the divider, and the boot bar's copy laid over the real mark.

## 0.3.32

### Patch Changes

- 770d7c8: `shared/ui/forms` shows every control size, with a disabled select; `InkFields` shows the ink fill on three guest palettes with each face and a textarea; `SelectChevron` shows the chevron at every size, beside a long value and sized to its content.
- a20eead: `cire/ui/FileInput` shows the picker in one story per state — `Empty`, `FileChosen`, `Focused` (rendered with keyboard focus, one theme at a time) and `Disabled` — in cire's light and dark mapping.
- 3507ec6: The overlays stories show one menu holding every kind of row — radio, check, switch, link and disabled — open on load, in the shared default look and in the `accent` variant under cire's mapping, dark and light.
- cb3db28: A `cire/ui/SegmentedTabs` story for each meaning of the glass strip, in cire's dark and light mapping, with icons, icon-only labels, a refused choice, a scrolling strip of counts, and a reply filter whose replies show as their dots beside "All".
- Updated dependencies [770d7c8]
- Updated dependencies [3507ec6]
  - @shared/ui@0.10.0

## 0.3.31

### Patch Changes

- 10289c8: The `cire/ui/Button` States story shows the answer pair unchosen, chosen and chosen while locked, and says the chosen one wears a 2px ring; the Variants story says how an `outline` answers the pointer.
- 9536104: A `cire/ui/Prose link` story: `proseLinkClass` in each tone inside a sentence, wrapping in a narrow paragraph, inside a warn and an accent `Notice`, and its focus ring.
- b88d319: The `cire/ui/Button` stories gain `round`: in the variant grid under Chrome, a Round story at its three sides, disabled at each side, and its pill corner at swatch size.
- d158559: `shared/ui/forms` gains `CheckboxBoxes` and `RadioBoxes`: every state of each part — checked, unchecked, disabled, named only by `aria-label`, a two-line label holding a link, a description and a note, a row and a column of radios — drawn under the lab's mapping and native under cire's, light and dark.
- Updated dependencies [d158559]
  - @shared/ui@0.9.0

## 0.3.30

### Patch Changes

- f0bb687: `cire/ui/Note` lab stories show the note at each size, and a playground, in cire's light and dark mapping.
- 466b521: The cire Card stories lead their cards with `Eyebrow`, the label every cire app now uses.
- db781eb: The feedback stories show every `Chip` tone outlined, the tag treatment, a chip leading with a mark and every combination under cire's two ramps; the playground gains the variant, the treatment and the danger tone.
- f6a7516: The feedback stories show every `Notice` tone at every size, the inline line under a field, the accent tone, the same set under cire's two ramps, and every tone's box with no fill; the playground gains a size control.
- 7dc0fd8: `Chip`'s note on why `danger` is outlined by default gives the reason that still holds and cire's measured figure. The lab's cire mapping draws cire's darker light-theme error red.
- Updated dependencies [7dc0fd8]
- Updated dependencies [db781eb]
- Updated dependencies [f6a7516]
  - @shared/ui@0.8.0

## 0.3.29

### Patch Changes

- 91cdded: The `cire/ui/Card` lab stories show each padding step, each fill and each tone in cire's light and dark mapping, captioned with what the browser painted.
- 18ab625: A `cire/ui/Card` lab story shows the plain, accent, eyebrow and interactive cards in cire's light and dark mapping.
- 80da778: `cire/ui/Disclosure` lab stories show each tone closed and open, a card disclosure holding rows, and a closed disclosure nested in an open one, in cire's light and dark mapping, each captioned with the turn the browser painted on its marker.
- 3b4d071: `cire/ui/Eyebrow` lab stories show both tones and every element the label renders as, in cire's light and dark mapping, captioned with the painted letter-spacing and colour.
- 951b8a1: The lab defines the cire apps' `transition-ui-colors` utility, so a cire app component's story fades its hover colours as the app does.

## 0.3.28

### Patch Changes

- 1b05223: A `cire/ui/Button` story group: every variant at every size inside cire's light and dark mapping, the `disabled`, `aria-disabled` and chosen states, and the corner claims measured from the painted button — the 32px icon circle, the 14px field corner, a caller's corner winning. cire's `--ui-*` mapping moves into `stories/cire-ui/cire-mapping.ts`, which the theming story now reads too.
- 94a7824: The design-system stories show the new `field` radius role: the radius gallery lists it, the role section labels the input `rounded-ui-field`, and the theming story maps cire's soft-shapes radii (pill buttons, 14px fields, 16px cards). The lab depends on `@cire/ui`, so its stories can render cire's components.
- Updated dependencies [94a7824]
  - @shared/design-tokens@0.3.9
  - @shared/ui@0.7.5

## 0.3.27

### Patch Changes

- Updated dependencies [cca20c1]
  - @shared/ui@0.7.4

## 0.3.26

### Patch Changes

- 8f9ffab: Install the third-party `stageshow` skill pinned to its upstream commit, and keep its example source out of the lint run.

## 0.3.25

### Patch Changes

- a471666: Move `solid-js` from 1.9.15 to 1.9.18. In 1.9.18 a module-level `lazy()`
  keeps its loaded component across an unmount, so a remounted lazy panel
  renders at once instead of a microtask later. The Settings tab test now waits
  for the router to write the fragment, which lands when the navigation's
  transition settles rather than with the panel. `@solidjs/router` stays at
  1.0.0: 1.0.1 is newer than the install's minimum release age.
- Updated dependencies [a471666]
  - @shared/ui@0.7.3

## 0.3.24

### Patch Changes

- ef3d36d: Dependency bumps within the caution window: `effect`, `@effect/platform-bun`,
  `@effect/platform-node`, `@effect/sql-d1` and `@effect/opentelemetry` 4.0.7
  (with the matching root overrides for `@effect/platform-node-shared`,
  `@effect/sql-d1` and `@effect/sql-sqlite-do`), `jose` 6.2.14, `astro` 7.4.4,
  `@astrojs/solid-js` 7.1.0, `@opentelemetry/*` 0.223.0 and 2.12.0,
  `@growthbook/growthbook` 1.8.0, `@solidjs/start` 2.0.6, `cropperjs` 2.3.1,
  `lucide-solid` 1.59.0, `motion` 13.5.1, `vitest` and the `@vitest/*` packages
  5.0.5 (which clears the moderate dev-server file-read advisory). The root
  overrides for `@opentelemetry/core` (`^2.12.0`) and `seroval` (`~1.6.11`, which
  clears two moderate serialisation advisories) rise with them. `wrangler` stays on 4.149.0, which
  `@cloudflare/vite-plugin` pins exactly. `solid-js` stays on 1.9.15 (see the cire
  changeset for why).
- Updated dependencies [ef3d36d]
  - @shared/color@0.3.6
  - @shared/design-tokens@0.3.8
  - @shared/ui@0.7.2

## 0.3.23

### Patch Changes

- Updated dependencies [1b2c026]
  - @shared/ui@0.7.1

## 0.3.22

### Patch Changes

- f8b31e1: `Table` takes `scroll="page"`: the frame clips sideways instead of scrolling, so a pinned head row sticks to the page under the call site's offset; page mode has no tab stop and no region, and the table names itself. `label` is required in box mode only. `Table` also takes `frame="none"`, `Th` takes `srOnly` for a head kept for assistive technology under a visible copy, and `DropdownMenuItem` types `disabled`. The dropdown menu's content, item, label and separator, and `PopoverContent`, take `SafeProps`, so none accepts `innerHTML`, `innerText` or `textContent`; `DropdownMenuContent` types `onCloseAutoFocus`, and `PopoverContent` `onCloseAutoFocus` and `onInteractOutside`, for a menu or popover opened from a plain button. The lab shows a table scrolling with the page.
- Updated dependencies [f8b31e1]
  - @shared/ui@0.7.0

## 0.3.21

### Patch Changes

- 1798332: The lab's story test fails when a story file imports a stylesheet, which would re-theme every story in the lab. The README and registry comment say where UI-package components' stories live (`src/stories/shared-ui/`, `osn-auth-ui/`, `cire-ui/`), and that a story with its own design language sets the `--ui-*` contract inline on a wrapper instead.

## 0.3.20

### Patch Changes

- 9e9801c: Move to TypeScript 7.1 (`typescript@7.1.0-beta`). The Astro landing sites drop `astro check` and `@astrojs/check` and type-check with `tsc -p . --runExternalCode` and `@astrojs/ts-content-mapper`, which checks every `.astro` page and component; `astro` moves to 7.4.2.

## 0.3.19

### Patch Changes

- 355b956: Type-check with Bun's built-in checker. Each package's `check` script is now `typecheck` and runs `bun check` in place of `tsc --noEmit`, with the test tsconfigs checked the same way. Packages that still need `astro check` keep it. No source changes.
- Updated dependencies [355b956]
  - @shared/color@0.3.5
  - @shared/design-tokens@0.3.7
  - @shared/ui@0.6.2

## 0.3.18

### Patch Changes

- 18b1291: Dev dependency update: happy-dom 21.0.4, clearing a high advisory in its earlier release.
- Updated dependencies [18b1291]
  - @shared/ui@0.6.1

## 0.3.17

### Patch Changes

- Updated dependencies [5c0c03e]
  - @shared/ui@0.6.0

## 0.3.16

### Patch Changes

- 5ab88f0: Build with vite 8.3.3 (range `^8.3.3`), which clears the advisory on vite 8.2.0
  through 8.2.3.
- Updated dependencies [5ab88f0]
  - @shared/ui@0.5.1

## 0.3.15

### Patch Changes

- 745c4ea: `@shared/ui` gains `Tooltip` (`@shared/ui/ui/tooltip`): a short label that
  explains itself on hover. One `text` string feeds both copies — hidden text
  inside the trigger, which a screen reader reads once, and a panel a mouse user
  sees on hover, which is `aria-hidden` and which the trigger does not point at.
  The trigger is a plain inline-block `<span>`, so it adds no tab stop. The lab
  shows it under shared/ui/overlays.
- Updated dependencies [745c4ea]
  - @shared/ui@0.5.0

## 0.3.14

### Patch Changes

- fa0f54a: Name the GitHub organisation `englishstreetventures` in the `repository` URL and in the comments and tests that cite a repository or issue.

  Comments and tests that pointed at an issue in the private tracker now state the constraint without the reference.

- Updated dependencies [fa0f54a]
  - @shared/color@0.3.4
  - @shared/design-tokens@0.3.6
  - @shared/ui@0.4.4

## 0.3.13

### Patch Changes

- Updated dependencies [ddece0f]
  - @shared/ui@0.4.3

## 0.3.12

### Patch Changes

- bed407f: Give the lab's headless story render test a 30 s limit, so a loaded CI runner no longer fails it at the 5 s default.

## 0.3.11

### Patch Changes

- 6b5f538: Refresh the eligible Effect libraries to 4.0.3 and align the Vitest family at
  5.0.3. Update the affected schema, tracing, and test integrations for the stable
  Effect API; refresh the eligible WebAuthn, Three.js, and Nitro consumers.
- Updated dependencies [6b5f538]
  - @shared/color@0.3.3
  - @shared/design-tokens@0.3.5
  - @shared/ui@0.4.2

## 0.3.10

### Patch Changes

- Updated dependencies [4aaec17]
  - @shared/color@0.3.2
  - @shared/design-tokens@0.3.4
  - @shared/ui@0.4.1

## 0.3.9

### Patch Changes

- Updated dependencies [e3a0858]
- Updated dependencies [891cf37]
  - @shared/ui@0.4.0

## 0.3.8

### Patch Changes

- Updated dependencies [6ae0a17]
  - @shared/ui@0.3.2

## 0.3.7

### Patch Changes

- 7f0b645: Set package author to English Street Ventures Pty Ltd, license to UNLICENSED, and repository URL.
- Updated dependencies [7f0b645]
  - @shared/color@0.3.1
  - @shared/design-tokens@0.3.3
  - @shared/ui@0.3.1

## 0.3.6

### Patch Changes

- 14b3f56: Add `Switch` (`@shared/ui/ui/switch`), an on/off control for a change that
  takes effect at once: a native `<input type="checkbox" role="switch">` inside
  its label. It is controlled, so it shows only the
  value it is given; `readOnly` keeps it focusable and at full contrast for
  someone who may read a setting but not change it, and `busy` holds it
  read-only and announced as busy while a change saves. The lab's form stories show each state.
- Updated dependencies [14b3f56]
  - @shared/ui@0.3.0

## 0.3.5

### Patch Changes

- 4e951c1: Pin the third-party `webgpu-threejs-tsl` skill to the upstream commit it was
  installed from, and check the installed tree against its lock on every pull
  request.

  `skills-lock.json` now records `ref` — commit `af2319bd` of
  `dgreenheck/webgpu-claude-skill`, whose `skills/webgpu-threejs-tsl` folder is
  byte-identical to ours — written by the pinned CLI itself. The install recipe
  in `wiki/conventions/agent-tooling.md` names the CLI version (`skills@1.7.0`),
  a `--before` date that puts the CLI's own dependencies under the same
  three-day soak as `bun install`, and a commit SHA for the source.

  `scripts/check-skills-lock.ts` recomputes the CLI's folder hash, which the CLI
  itself never checks again, and fails on an unpinned entry, a folder edited
  after install, or a folder with no lock entry.

  No file any package ships changes. `@tools/lab` is named because it is the
  surface the skill serves, and the gate requires a changeset because the
  comments in `oxlintrc.json` and `lefthook.yml` change: both said the CLI
  checks the hash on update, which it does not.

## 0.3.4

### Patch Changes

- Updated dependencies [b229bf5]
  - @shared/design-tokens@0.3.2
  - @shared/ui@0.2.4

## 0.3.3

### Patch Changes

- 76aa4f6: Point code comments at the wiki's new layout. The wiki now has one folder per
  product (`osn/`, `musubi/`, `pulse/`, `cire/`, `zap/`) and `shared/` for what
  applies to all of them, so references such as `wiki/systems/rate-limiting.md`
  now read `wiki/shared/rate-limiting.md`. Comments only; no behaviour changes.
- Updated dependencies [76aa4f6]
  - @shared/design-tokens@0.3.1
  - @shared/ui@0.2.3

## 0.3.2

### Patch Changes

- Updated dependencies [82a106a]
  - @shared/ui@0.2.2

## 0.3.1

### Patch Changes

- Updated dependencies [f3b4cd1]
  - @shared/ui@0.2.1

## 0.3.0

### Minor Changes

- 21f3cff: Make the design system explorable in the lab.

  A new `design-system/` story group under `tools/lab/src/stories/`, five files,
  fourteen stories: the colour roles, the type/tracking/leading/measure scales,
  radius, elevation, the focus ring, motion, and the theming demonstration.

  Two things separate these from a token table rendered in HTML.

  **They measure what the browser painted, not what the stylesheet claims.**
  `measure.ts` reads computed style and re-reads it on a `MutationObserver` for
  `<html>`'s `class` — so the numbers beside every swatch are the current theme's
  real values, and the contrast story puts a live ratio and a pass/fail beside all
  43 pairs `contrastPairs()` generates. The conformance harness reads the
  stylesheet and cannot see a token an app set at runtime, a subtree that
  redefined one, or which theme the toggle is on. This can. It shows musubi's two
  waived pairs failing in red, because a waiver suppresses an assertion rather
  than the defect.

  **The theming story renders the same components under three mappings at once** —
  musubi's, cire's, and every token set to `initial` so the package fallbacks show
  — side by side, with only the musubi column following the light·dark toggle.
  That is the whole claim `@theme inline` makes: `bg-ui-surface` resolves at the
  element, so a subtree that redefines a token is followed. It is the property the
  contract rests on and the one thing no static table can show.

  Groups and membership are derived from `CONTRACT_COLOR_TOKENS` and
  `CONTRACT_SCALES` rather than typed out, so a token added to the contract lands
  in a group — or in a visible `unsorted` row, never silently nowhere.

  Also corrects the last of the `--osn-*` → `--ui-*` rename: the glob form
  `--osn-*`, which the suffix allowlist could not match, survived in twelve prose
  sites including `tokens.css`'s own integration example.

### Patch Changes

- 21f3cff: First pass of the `@shadcn/lint` migration: 183 of 530 call sites cleared.

  `no-arbitrary-values` sites move onto the contract's scales, and `no-restyle`
  sites either drop a class the component already applies or switch to a variant
  that already exists. Neither rule is at `error` yet — the remaining 347 sites
  are in a second pass, and a rule goes to `error` only when its count is zero.

  Where a `no-restyle` site genuinely needs a variant that does not exist, the
  call site is left alone and the proposal recorded rather than guessed at. Those
  land with the variant, not before.

  One test changed. `ResponsiveDialogContent` was overriding `DialogContent`'s
  radius with `rounded-card`, and `musubi/social/src/App.css` maps
  `--ui-radius-lg: var(--radius-card)` — so the component's own default already
  resolved to musubi's 16px and the override restated it. The wrapper drops it and
  the test now asserts `rounded-ui-lg`, which is the class that has to keep
  resolving to 16px for the two to stay equivalent.

- 21f3cff: Final `@shadcn/lint` pass over the Pulse surfaces and the lab: `no-restyle` and
  `no-arbitrary-values` both reach zero there.

  **Two `shared/ui` defects the migration found by being blocked on them.**

  `DropdownMenuTrigger` was a bare Kobalte re-export with no styling and no focus
  treatment at all, so an avatar-as-trigger — the account menu in both the Pulse
  header and the explore nav — had no focus ring a call site was allowed to give
  it. It now takes a `treatment`, `bare` by default so the `as={Button}` spelling is
  untouched, and `pill` for the trigger that is itself the control. The ring and
  the radius are one choice because they cannot disagree: a rectangular focus ring
  around a circular avatar is the defect, not a variation on it. Both call sites
  render identically — Pulse maps `--ui-focus` to its own `--ring` and
  `--ui-radius-pill` to `9999px`.

  `DialogClose` had been given a concrete `ComponentProps<"button">`, which
  dropped Kobalte's polymorphic `as` from the type while leaving it working at
  runtime. Its own doc comment names `<DialogClose as={Button}>Cancel</DialogClose>`
  as the pattern the `bare` treatment exists to serve, and `tools/lab` is the only
  consumer of it repo-wide, so the type regression broke that package's typecheck
  and nothing else. Both are polymorphic again.

  Pulse's arbitrary values become named entries in each app's own theme block
  rather than the library-facing contract: `@pulse/landing` gains `--text-tag`,
  `--text-meta`, three `--tracking-mono-*` steps and `--leading-display`;
  `@pulse/web` gains `--container-hero` and `--spacing-accent-word`. The two hero
  font sizes are named rather than snapped — 9.6px and 10.4px both sit below the
  scale's smallest step, so rounding them up would change the eyebrow rather than
  tidy it. Verified against the built CSS, since a wrong `@theme` entry emits no
  rule at all rather than an error.

  `tools/lab`'s radius maps gain `--ui-radius-sheet`, which the contract had
  added without them catching up.

- 21f3cff: Split `@osn/ui` into `@shared/ui` and `@osn/auth-ui`, and re-key the design-token
  contract from `--osn-*` to `--ui-*`.

  `wiki/architecture/osn-and-musubi.md` states the discriminator: if an independent
  implementation must use the same string to interoperate, it is OSN; otherwise it
  is not. A `Button` fails that test — nobody has to spell it the way we do — so
  the primitives were never OSN's, and the old page carved them out by hand
  ("it keeps its name because `@pulse/web` and `tools/lab` consume it as well")
  rather than applying the rule. The carve-out is gone.

  | Was                                 | Is                                        | Holds                                                                   |
  | ----------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
  | `@osn/ui/ui/*`, `@osn/ui/lib/utils` | `@shared/ui/ui/*`, `@shared/ui/lib/utils` | The primitives: `Button`, `Card`, `Modal`, `Field`, `Table`, `cn()`     |
  | `@osn/ui/auth`, `@osn/ui/auth/*`    | `@osn/auth-ui`, `@osn/auth-ui/*`          | The auth views: `SignIn`, `Register`, `PasskeysView`, `StepUpDialog`, … |

  `@osn/auth-ui` stays under `osn/` because every view in it is the client half of
  a named ceremony in the spec — its shape is fixed by the protocol, not by our
  styling — and it now depends on `@shared/ui` like any other consumer. Its
  subpaths flatten (`@osn/ui/auth/SignIn` → `@osn/auth-ui/SignIn`), and the
  package's bare specifier is the barrel that `@osn/ui/auth` used to be.

  The token prefix moves with it. `--ui-surface` becomes `--ui-surface`,
  `bg-ui-ground` becomes `bg-ui-ground`, `.ui-toast` becomes `.ui-toast`, and
  `--ui-modal-enter` becomes `--ui-modal-enter`. A prefix naming the system a
  component is _not_ part of was the last thing asserting the old shape. Apps map
  the new names in exactly one place each, the contract block in their global
  stylesheet.

  The rename was driven by an explicit allowlist of the contract's own token
  suffixes rather than a blanket `osn-` → `ui-` substitution, because the same
  compound shape carries protocol identifiers that must not move: `osn-access`,
  `osn-step-up`, `osn-kid`, `osn-pairwise-salt`, the `osn-api`/`osn-social`
  Cloudflare project names. A missed token fails safe by staying `osn-`; a
  mangled audience string would not.

  One string is deliberately left spelled the old way: `ProfileOnboarding`'s
  `localStorage` key. Every browser that has already dismissed that prompt holds
  it under `@osn/ui:profile_onboarding_dismissed`, and renaming the key would show
  the prompt again to exactly the people who said no.

- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
  - @shared/ui@0.2.0
  - @shared/design-tokens@0.3.0
  - @shared/color@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [d326ae3]
  - @shared/ui@0.1.1

## 0.2.0

### Minor Changes

- ac41e37: Make the design system explorable in the lab.

  A new `design-system/` story group under `tools/lab/src/stories/`, five files,
  fourteen stories: the colour roles, the type/tracking/leading/measure scales,
  radius, elevation, the focus ring, motion, and the theming demonstration.

  Two things separate these from a token table rendered in HTML.

  **They measure what the browser painted, not what the stylesheet claims.**
  `measure.ts` reads computed style and re-reads it on a `MutationObserver` for
  `<html>`'s `class` — so the numbers beside every swatch are the current theme's
  real values, and the contrast story puts a live ratio and a pass/fail beside all
  43 pairs `contrastPairs()` generates. The conformance harness reads the
  stylesheet and cannot see a token an app set at runtime, a subtree that
  redefined one, or which theme the toggle is on. This can. It shows musubi's two
  waived pairs failing in red, because a waiver suppresses an assertion rather
  than the defect.

  **The theming story renders the same components under three mappings at once** —
  musubi's, cire's, and every token set to `initial` so the package fallbacks show
  — side by side, with only the musubi column following the light·dark toggle.
  That is the whole claim `@theme inline` makes: `bg-ui-surface` resolves at the
  element, so a subtree that redefines a token is followed. It is the property the
  contract rests on and the one thing no static table can show.

  Groups and membership are derived from `CONTRACT_COLOR_TOKENS` and
  `CONTRACT_SCALES` rather than typed out, so a token added to the contract lands
  in a group — or in a visible `unsorted` row, never silently nowhere.

  Also corrects the last of the `--osn-*` → `--ui-*` rename: the glob form
  `--osn-*`, which the suffix allowlist could not match, survived in twelve prose
  sites including `tokens.css`'s own integration example.

### Patch Changes

- ac41e37: Split `@osn/ui` into `@shared/ui` and `@osn/auth-ui`, and re-key the design-token
  contract from `--osn-*` to `--ui-*`.

  `wiki/architecture/osn-and-musubi.md` states the discriminator: if an independent
  implementation must use the same string to interoperate, it is OSN; otherwise it
  is not. A `Button` fails that test — nobody has to spell it the way we do — so
  the primitives were never OSN's, and the old page carved them out by hand
  ("it keeps its name because `@pulse/web` and `tools/lab` consume it as well")
  rather than applying the rule. The carve-out is gone.

  | Was                                 | Is                                        | Holds                                                                   |
  | ----------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
  | `@osn/ui/ui/*`, `@osn/ui/lib/utils` | `@shared/ui/ui/*`, `@shared/ui/lib/utils` | The primitives: `Button`, `Card`, `Modal`, `Field`, `Table`, `cn()`     |
  | `@osn/ui/auth`, `@osn/ui/auth/*`    | `@osn/auth-ui`, `@osn/auth-ui/*`          | The auth views: `SignIn`, `Register`, `PasskeysView`, `StepUpDialog`, … |

  `@osn/auth-ui` stays under `osn/` because every view in it is the client half of
  a named ceremony in the spec — its shape is fixed by the protocol, not by our
  styling — and it now depends on `@shared/ui` like any other consumer. Its
  subpaths flatten (`@osn/ui/auth/SignIn` → `@osn/auth-ui/SignIn`), and the
  package's bare specifier is the barrel that `@osn/ui/auth` used to be.

  The token prefix moves with it. `--osn-surface` becomes `--ui-surface`,
  `bg-osn-ground` becomes `bg-ui-ground`, `.osn-toast` becomes `.ui-toast`, and
  `--osn-modal-enter` becomes `--ui-modal-enter`. A prefix naming the system a
  component is _not_ part of was the last thing asserting the old shape. Apps map
  the new names in exactly one place each, the contract block in their global
  stylesheet.

  The rename was driven by an explicit allowlist of the contract's own token
  suffixes rather than a blanket `osn-` → `ui-` substitution, because the same
  compound shape carries protocol identifiers that must not move: `osn-access`,
  `osn-step-up`, `osn-kid`, `osn-pairwise-salt`, the `osn-api`/`osn-social`
  Cloudflare project names. A missed token fails safe by staying `osn-`; a
  mangled audience string would not.

  One string is deliberately left spelled the old way: `ProfileOnboarding`'s
  `localStorage` key. Every browser that has already dismissed that prompt holds
  it under `@osn/ui:profile_onboarding_dismissed`, and renaming the key would show
  the prompt again to exactly the people who said no.

- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
  - @shared/ui@0.1.0
  - @shared/design-tokens@0.2.0
  - @shared/color@0.2.0

## 0.1.24

### Patch Changes

- Updated dependencies [894a26f]
  - @osn/ui@1.13.0

## 0.1.23

### Patch Changes

- a12d743: Say what the sign-up email address is for, beside the Email field.

  The address does three jobs and the form named none of them: it verifies the
  account by six-digit code (no account row exists until the code is accepted), it
  is the emailed-code way back into an account whose passkeys are all gone, and it
  receives security notices. The second is the one that should steer which address
  a person types, and it was the least visible.

  `InfoPopover` — the circled-glyph button that was already doing this job on
  `@pulse/web`'s create-event form — moves to `@osn/ui` as
  `@osn/ui/ui/info-popover`, so `Register` can use it too. Two new props: `glyph`
  picks the character (`?` still the default, so the seven `@pulse/web` call sites
  are unchanged) and `placement` picks the side. `Register`'s Email label gets an
  `i` that opens above the label, because Kobalte's default `"bottom"` would open
  the panel over the input the reader is about to type into.

  `@pulse/web` keeps both call sites and behaviour; its copy of the component and
  that copy's test both move to `@osn/ui`, so the coverage travels with the file
  rather than disappearing.

  `PopoverContent` now carries `data-kb-top-layer`, which fixes a bug for every
  popover rather than only this one. A Kobalte `Dialog` is modal by default and
  sets `aria-hidden="true"` on everything outside itself, reaching nodes portalled
  to `<body>` afterwards through a `MutationObserver`. `PopoverContent` portals to
  `<body>`, so any popover opened from inside a dialog was visible on screen and
  missing from the accessibility tree. That attribute is the exemption Kobalte
  itself uses for `ToastRegion`. It sits on the component rather than behind a
  prop, so no call site has to remember it. Dismissal is unchanged — the toggle
  and Escape tests pass with it in place, and each still fails when its dismiss
  action is removed.

  Two of the five moved tests asserted nothing and were rewritten rather than
  carried over. The toggle test ended in `expect(!content || closedParent ||
  expandedParent).toBeTruthy()`, where `expandedParent` matches while the popover
  is still open — it passed either way; and the Escape test fired the key and then
  ended in a comment. Both now read Kobalte's disclosure state directly
  (`aria-expanded`, plus `data-closed`/`data-expanded` on the panel), which is what
  the exit animation keeping the panel mounted had made awkward to assert. Four
  more tests cover the chosen glyph, `type="button"`, keyboard reachability, and a
  click that does not submit the surrounding form — that last one with a positive
  control, so it cannot pass in an environment that dispatches no submit at all.

- Updated dependencies [a12d743]
  - @osn/ui@1.12.0

## 0.1.22

### Patch Changes

- Updated dependencies [2c2f120]
  - @osn/ui@1.11.4

## 0.1.21

### Patch Changes

- 55a8dc6: Vendor the third-party `webgpu-threejs-tsl` skill (`dgreenheck/webgpu-claude-skill`)
  so WebGPU and TSL guidance reaches every agent session working in `@tools/lab`,
  remote and CI included. `npx skills add` puts the text in
  `.agents/skills/webgpu-threejs-tsl/` with a `.claude/skills/webgpu-threejs-tsl`
  symlink to it and a root `skills-lock.json` holding the hash the CLI wrote at
  install time and checks on update.

  No file any package ships changes, so no package is a wholly honest name for
  this; `@tools/lab` is the surface the skill exists to serve, and the gate
  requires a changeset because the commit touches `oxlintrc.json` and
  `lefthook.yml` — two of the files that decide whether a guard runs at all.

  Those two, and three more, keep our tooling out of someone else's text:
  `oxlintrc.json` ignores `.agents` and the symlink path both — oxlint walks
  through the link and reports the same file under its second name — both lefthook
  pre-commit commands exclude `.agents/**`, and `skill-eval.yml`'s quality loop now
  skips a symlinked skill, because a finding we fix in the installed folder
  either stops the next `npx skills update` or is thrown away by it. The same workflow's trigger paths gain `.agents/skills/**`
  and `skills-lock.json`, so an update — which touches nothing under `.claude/` —
  still reaches the review gate. `.github/CODEOWNERS` gains rules for both
  paths again, as it must whenever such a tree exists: it is someone else's
  instructions running with full agent permissions. The changeset allowlist in
  `scripts/changeset-required.sh` never lost its two arms — they were left in
  place and labelled retired — so the change there is to the comments that say
  why they exist, plus a test case per arm.

## 0.1.20

### Patch Changes

- Updated dependencies [98fd9ee]
  - @osn/ui@1.11.3

## 0.1.19

### Patch Changes

- Updated dependencies [f9cffd9]
  - @osn/ui@1.11.2

## 0.1.18

### Patch Changes

- @osn/ui@1.11.1

## 0.1.17

### Patch Changes

- Updated dependencies [4b73ff4]
  - @osn/ui@1.11.0

## 0.1.16

### Patch Changes

- @osn/ui@1.10.12

## 0.1.15

### Patch Changes

- @osn/ui@1.10.11

## 0.1.14

### Patch Changes

- 13d8ee3: Separate OSN, the system, from Musubi, our implementation of it.

  OSN is now the headless core — identity, the social graph, authorisation and
  the OpenID Connect issuer — with no user interface, runnable by anyone for
  their own private social graph. Musubi is our implementation and the product
  built on it: the social app, its marketing site, the brand, and the
  `musubi.social` instance we host.

  `@osn/social` becomes `@musubi/social` and `@osn/landing` becomes
  `@musubi/landing`, both moving to a new top-level `musubi/` workspace
  directory. The backend packages, `@osn/ui`, the shared packages and every
  wire-level identifier — the `osn-access` and `osn-step-up` token audiences,
  `/.well-known/jwks.json`, claim names, the pairwise subject derivation and the
  ARC token format — keep the OSN name, because an independent implementation has
  to match them to interoperate. That is the rule the split now runs on: if
  another implementation must use the same string, it is OSN; otherwise it is
  Musubi.

  The remaining packages change only in the references they carry. Two of them
  were resolving the moved package by filesystem path rather than by package name
  — `tools/lab/src/lab.css` and `tools/metrics/src/metrics.css` both `@import`
  the social app's stylesheet — and would have failed to build without the
  update.

  Two repository guards learned about the new directory: `fmt` and `fmt:check`
  hardcode the list of workspace directories oxfmt walks, and
  `scripts/validate-changesets.sh` builds its known-workspace-name set from a
  hardcoded `find`. Neither would have reported anything unusual; the format
  check would simply have stopped covering two packages.

  Cloudflare Pages project names (`osn-social`, `osn-social-dev`, `osn-landing`)
  are deliberately unchanged — renaming a Pages project attached to a live apex
  is a deploy operation, not a rename.

- Updated dependencies [13d8ee3]
  - @osn/ui@1.10.10

## 0.1.13

### Patch Changes

- Updated dependencies [b2b6b70]
  - @osn/ui@1.10.9

## 0.1.12

### Patch Changes

- Updated dependencies [b78deb7]
  - @osn/ui@1.10.8

## 0.1.11

### Patch Changes

- Updated dependencies [e16a48a]
  - @osn/ui@1.10.7

## 0.1.10

### Patch Changes

- @osn/ui@1.10.6

## 0.1.9

### Patch Changes

- d96da64: Clear six new high advisories and refresh a lockfile that had drifted behind its own ranges.

  `fast-uri` 3.1.5 → 3.1.7. Four high advisories against 3.1.5 landed on 2026-09-02 (GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp — two SSRF, two host confusion) and the pre-push `bun audit` gate went red. Taking 3.1.6, which is what those four advisories name as fixed, would have left two more: 3.1.7 also fixes GHSA-qw65-cvwx-89v3 (authority injection via an unvalidated port in `serialize()`) and GHSA-58mr-gqgx-xq4g (host confusion via unbalanced IP-literal brackets), neither of which is in the public advisory database yet, so no audit tool reports them. Reachability is the Astro language server only — `ajv` appears once in the lockfile, under `@astrojs/check`, and no deployed Worker or shipped bundle contains it. `smol-toml` 1.6.1 → 1.8.0 is the same shape: 1.7.1 carries the fix for GHSA-7w5x-hrqm-74c2, also absent from the database.

  The rest is lockfile lag. The dependency sweep in this stack raised every declared range, but `bun.lock` stayed behind versions those ranges already admitted: `esbuild` 0.28.2, `postcss` 8.5.26, `picomatch` 4.0.7, `sharp` 0.35.4 (libvips 1.3.3), `js-yaml` 4.3.2, `ws` 8.21.3, `devalue` 5.9.2, `happy-dom` 20.12.2, `@cloudflare/workers-types` 5.20260903.1. Two are worth knowing about rather than just taking: `ws` 8.21.1 **lowers the `maxBufferedChunks` and `maxFragments` defaults** and counts empty fragments toward the limit, which is a behaviour change inside a patch and touches Zap's WebSocket surface; `picomatch` 4.0.5–4.0.7 are all matching-semantics fixes, so glob-driven config can shift.

  `astro` 7.2.9 → 7.2.10 is the one with deployed consequences. It fixes an SSR manifest placeholder not being replaced when the server build is minified, which caused a runtime `Invalid URL` crash at server boot. It is pinned to 7.2.10 rather than left to float: 7.3.0 and 7.3.1 clear the three-day soak but not the fourteen-day rule for a minor, so they wait.

  Two overrides were correcting themselves in the wrong direction and are fixed here. `undici` was pinned `^7.29.0` while `jsdom` 30 declares `undici ^8.9.0` and `unifont` 0.7.5 declares `^8.0.0` — a floor being used as a ceiling, holding both consumers a whole major below what they were written for and cutting the tree off from undici 8 security fixes. Raised to `^8.9.0` (resolves 8.10.1). Because top-level `miniflare` 4 pins undici at exactly 7.28.0 and the wrangler-nested miniflare 5 alpha pins 7.29.0, this was verified rather than assumed: type check, the full test suite, the Miniflare D1 tier, all four Worker builds, and a real `wrangler dev --local` boot of `osn-api` on workerd, which serves 200 on `/health`, `/.well-known/jwks.json` and `/` with no errors. `postcss` and `picomatch` were likewise below what `vite` 8.2.2 asks for (`^8.5.26` and `^4.0.5`), a floor gap opened by raising vite earlier in this stack.

  Also: the `protobufjs` override matched nothing in the lockfile and is removed, and `bunfig.toml`'s note on the removed `fast-uri` soak exclusion claimed the package "parses URIs on the request path via ajv", which is not true of this tree and would have mispriced exactly the decision this changeset had to make.

  One source change, in `cire/api/tests/index.test.ts`: `@cloudflare/workers-types` 5.20260903.1 makes `recordException` a required member of `Span`, so the test's `StubSpan` gains it, typed off the interface rather than restated so the next daily types release cannot drift it.

- 00ed19f: Take the latest in-range release of 28 dependencies, raising each declared floor to what the lockfile already resolves to. Runtime: effect 3.22.1, elysia 1.4.30, @effect/platform 0.97.1, solid-js 1.9.15, @solidjs/router 0.16.3, @solidjs/start 2.0.4, @kobalte/core 0.13.13, motion 12.43.0, astro 7.2.9, @astrojs/solid-js 7.0.2, @astrojs/cloudflare 14.2.5, @simplewebauthn/server 13.3.3, @upstash/redis 1.38.3, @growthbook/growthbook 1.7.0, cropperjs 2.2.0. Tooling and types: vite 8.2.2, vitest 4.1.11 (with @vitest/browser, @vitest/browser-playwright and @vitest/coverage-istanbul), wrangler 4.127.1, miniflare 4.20260730.0, happy-dom 20.12.0, turbo 2.10.12, lefthook 2.1.12, portless 0.15.6, @types/leaflet 1.9.22, @types/three 0.185.4.

  No source change. Every gate passes unchanged, including the Miniflare D1 tier and the real-Chromium browser tier.

  Two consequences of the wrangler bump that the version list does not show, recorded here so they are accepted rather than discovered. Wrangler 4.127.1 nests `miniflare@5.20260828.0-alpha` — an alpha build of the local Workers runtime — under both itself and `@cloudflare/vite-plugin`, so `wrangler dev` and the vite plugin now run on a prerelease. The top-level `miniflare` stays stable at 4.20260730.0, so the `test:d1` tier is untouched. The three-day `minimumReleaseAge` soak still applies to the alpha and `minimumReleaseAgeExcludes` is empty, so nothing here skips the gate. Separately, raising `vite` to 8.2.2 raises what vite requires: it now asks for `postcss ^8.5.26` and `picomatch ^4.0.5`, both above the floors the root overrides pin. Those floors are corrected in a later PR in this stack rather than here, because they need a lockfile refresh.

- Updated dependencies [d96da64]
- Updated dependencies [00ed19f]
  - @osn/ui@1.10.5

## 0.1.8

### Patch Changes

- 853367f: Pin browserslist to ^4.28.8 via a root override, clearing two high-severity advisories (GHSA-c83g-rgw3-j3cx unbounded query-cache growth, GHSA-73wf-gq98-2v4g crash and prototype write on untrusted browserslist-stats.json). Both affect <= 4.28.6, and the tree resolved 4.28.2 transitively through the @babel/core that vite-plugin-solid and @astrojs/solid-js pull in. Every package listed here sits on that chain. Build output is byte-identical.
- Updated dependencies [853367f]
  - @osn/ui@1.10.4

## 0.1.7

### Patch Changes

- @osn/ui@1.10.3

## 0.1.6

### Patch Changes

- db8e5f9: Gate every component-lab story in CI. `tools/lab/tests/stories.test.tsx` imports
  every file the registry globs match and renders each story that can run
  headless, so a bench that has silently stopped mounting fails the build instead
  of appearing as an error row in the sidebar that nobody opens. A story that
  needs a real browser opts out with `headless: false` in its `meta`; both
  three.js stories do.

  Also scope the Turborepo `test`, `test:d1` and `test:browser` caches with a
  subtractive `inputs` list, so a markdown-only edit no longer busts a package's
  test cache.

## 0.1.5

### Patch Changes

- Updated dependencies [70ac0f3]
  - @osn/ui@1.10.2

## 0.1.4

### Patch Changes

- @osn/ui@1.10.1

## 0.1.3

### Patch Changes

- Updated dependencies [5159096]
  - @osn/ui@1.10.0

## 0.1.2

### Patch Changes

- @osn/ui@1.9.1

## 0.1.1

### Patch Changes

- 1648d97: Bench `@shared/toast` and `@shared/sortable` in the component lab, and stop the
  lab swallowing a story's arrow keys.

  Drag feel, the shift/settle animation, grip hover/focus and painted toast colour
  are invisible to every test tier we have — happy-dom computes no layout, so a
  drag test can only assert numbers against stubbed rects. `bun run dev:lab` now
  carries **shared/sortable** (drag feel, multi-container isolation, the keyboard
  path) and **shared/toast** (tones, positions, stacking, actions and promises,
  overflow). Both are co-located `*.story.tsx` with no lab imports, so they stay
  ordinary files in their own package.

  The lab's arrow-key story navigation now bails on `event.defaultPrevented`, which
  `@shared/sortable`'s grip already sets. Without that the lab stepped to the next
  story on every attempted row move, which made the keyboard half of that package —
  the half with no other way to be exercised by hand — untestable there. Any story
  that owns the arrows gets the same protection.

- Updated dependencies [3dfde85]
  - @osn/ui@1.9.0

## 0.1.0

### Minor Changes

- 7a75d6c: Run the component lab behind portless like every other dev server: `bun run dev:lab` now answers on `https://lab.localhost`, and a branch worktree gets its own copy of it. Also puts `PORTLESS` in turbo's `globalPassThroughEnv` — strict env mode was stripping it, so the documented `PORTLESS=0` fallback never reached any app.
- 7a75d6c: Add the component lab: a Vite + Solid scratchpad on port 4400 that finds every `*.story.tsx` in the monorepo, renders it with live args, and ships three.js / canvas helpers for spiking WebGL and HTML-in-canvas work. Comes with a catalogue of every `@osn/ui` component and the Pulse icon set. `bun run dev:lab`.
