# @shared/ui

## 0.1.1

### Patch Changes

- d326ae3: Add `dietaryPresets` / `dietary_presets` to the log-redaction deny-list.

  Cire stores dietary requirements as keys from a closed vocabulary as well as free
  text. A key is no less revealing than the sentence it replaced — `halal` names a
  religious practice outright, `nuts` a health condition — so it needs the same
  scrubbing `dietary` already had. Structured is not anonymous.

  Also: a `Popover` opened from inside a `Modal` now mounts its panel into the open
  dialog rather than `<body>`.

  `Modal` is `<dialog>` + `showModal()`, so it paints in the top layer, above every
  stacking context in the document — a panel portalled to `<body>` sat behind it at
  any `z-index`, laid out and announced by a screen reader but dead to a pointer.
  Mounting into the dialog inherits its top-layer promotion and leaves Kobalte's
  positioning untouched. A `frame` Modal is `overflow-hidden` and still clips the
  panel; that case is recorded in `popover-in-modal.browser.test.tsx` and tracked
  separately.

## 0.1.0

### Minor Changes

- ac41e37: `Card` gains a `padding` prop, and the libraries themselves go on the scale

  15 call sites across `@pulse/web` and `@musubi/social` were spelling a card's
  padding as `class="p-4"`, `"p-5"` or `"p-6"`. It is `padding="sm" | "md" |
"lg"` now.

  `none` stays the default, and that is not an oversight: a card built from
  `CardHeader` / `CardContent` / `CardFooter` takes its padding from those, and a
  default here would double it. The two shapes are genuinely different cards, and
  a test asserts the composed one picks up no padding of its own.

  The scale codemod had only been run over the six apps, never over `@shared/ui`,
  `@cire/ui`, `@shared/toast` or `@shared/sortable` — so the libraries still
  carried four arbitrary type values of their own, including
  `AvatarFallback`'s `text-[10px]`. They are on the contract's steps now.

- ac41e37: `Modal` animates, and its exit works in every engine rather than only in Chrome

  Entry is `@starting-style` — pure CSS, no JavaScript, from-state taken by the
  browser when the element first renders.

  Exit could not be, and the reason is worth stating because the CSS-only answer
  looks like it should work. `close()` removes a dialog from the top layer
  _immediately_, so an exit transition has nothing left to paint. The platform's
  fix is the `overlay` property with `transition-behavior: allow-discrete`, which
  defers that removal — and `overlay` is **Chrome and Edge only**, unsupported in
  Safari and Firefox. On the surface this component was built for, cire's guest
  site, most traffic is mobile Safari, so a CSS-only exit would mean the dialog
  blinking away for nearly everyone who sees it.

  So `Modal` defers the `close()` call instead: it sets `data-closing`, lets its
  stylesheet run the exit, and closes once the element's animations have finished.
  It waits on `getAnimations({ subtree: true })` rather than a named transition,
  so an app animating the panel with Motion One or the Web Animations API is
  waited out the same way — the hook is animation-library-agnostic without naming
  a library. A reopen mid-exit is tracked by a token, so a stale close cannot land
  on a dialog somebody has just reopened.

  Timing is `--ui-modal-enter` and `--ui-modal-exit`, so an app retimes rather
  than restyles. `prefers-reduced-motion` drops both to 1ms rather than `none`:
  the exit is awaited, and a transition that never started is one there is nothing
  to wait for.

  **Callers must keep the modal mounted across the close** — `Modal` can only
  animate an element that is still in the document. `<Show when={x}>{() => <Modal
open …>}</Show>` unmounts it the instant `x` goes null and the exit silently does
  not play. The docblock and `wiki/architecture/component-library.md` both say so,
  and the fix is to put the `Show` inside the modal.

  Eight new browser tests cover it, including that the dialog stays in the top
  layer while the exit runs, that something is genuinely animating rather than the
  attribute merely being set, that a reopen beats a stale close, and that an
  unmount mid-exit leaves nothing inert.

- ac41e37: `Modal` mounts its children only while it is open, and exports `heldWhileClosing`

  Both came out of converting real overlays.

  **The children are gated.** `Modal` stays mounted so it can animate its exit,
  and that meant a modal which was merely _available_ rendered its body into every
  page offering it. In `cire/host` a live invite preview was rendering twice —
  once in the sticky side pane, once inside a closed dialog — competing for the
  same accessible name. Children mount when `open` goes true and unmount once the
  exit has finished, so an expensive body costs nothing until it is asked for and
  is still there to be animated away.

  **`heldWhileClosing`** is for the other shape: a body that cannot render without
  a value which closing sets to null. Confirming a plan closes the modal
  correctly and unmounts the body on the same tick, so what fades away is an empty
  bordered box. The helper keeps the last non-null value for exactly as long as
  the exit needs it, and is a no-op for a modal whose contents stand on their own.

- ac41e37: `Modal` gains `frame`, and stops leaking the user agent's dialog padding

  `frame` is for a panel that must not scroll: it drops the panel's own padding
  and overflow and makes it a column flex container, so a child can own the
  scrollport while a close button or a sticky action bar stays put beside it. The
  default shape — the panel scrolls, the panel is padded — cannot express that,
  because anything inside a scrollport scrolls away with the content.

  `base:p-0` rather than simply omitting the padding, and that is the part worth
  knowing: the user-agent stylesheet gives every `<dialog>` `padding: 1em`, so a
  component that writes no padding rule ships a 16px band the caller cannot see in
  its own markup. It put cire's sticky action bar 16px above the bottom edge it is
  supposed to sit on.

  Two fixes on the way out of a dialog, both found by the same conversion.
  `close()` now dispatches the `close` event where the environment has no
  `HTMLDialogElement.close` — without it the fallback shut silently and `open`
  desynced, which is the one failure the component's close listener exists to
  prevent. And `getAnimations` is guarded the way `showModal` already was, since
  jsdom has no Web Animations API and the unguarded call was a `TypeError` on
  every close.

- ac41e37: Lift cire's `Field`, `Select`, `Meter` and `Table` into `@shared/ui`, on the token contract

  The last of the primitives that existed twice in cire's two portals and nowhere
  shared. `Field` is the label-hint-error scaffolding — it hands the caller `id`,
  `aria-describedby` and `aria-invalid` through a function rather than rendering
  the control itself, which is what keeps a hint a _description_ instead of
  silently becoming part of the input's accessible name. `Fieldset`, `Select`,
  `Meter`, `meterPct`, `Table`, `Th` and `Td` come with it.

  `Input` and `Textarea` now share one control box with `Select` (`ui/control`),
  so the three line up in a column instead of being three near-misses, and all
  three take `size` — `md` for a form, `sm` for a control inside a table row. The
  prop omits the native `size` attribute rather than shadowing it, so passing a
  character count is a compile error. `Textarea` gains `resize`, which a passed
  `class="resize-none"` could not do reliably: both classes land on the element
  and Tailwind resolves the conflict by stylesheet order, not attribute order.

  Two off-contract values fixed along the way. `Input` and `Textarea` set a ring
  offset from `--color-background`, which is not a contract token and resolves to
  nothing outside the two apps that happen to declare it; `UsernameInput`'s
  "available" message was a fixed `text-green-600` that does not follow the theme.
  Both now read the contract. `UsernameInput` also extends `InputProps` rather
  than the raw element props, so the `size` it forwards reaches the box it names.

  Covered by 30 new tests in the real-Chromium tier — sizes that are genuinely
  different sizes, an `aria-invalid` border a person can see, a label that reaches
  its control, a rejected save that does not take the caret with it, a table that
  scrolls under the keyboard, and a meter whose fill is transformed rather than
  resized. Each primitive has a bench in `@tools/lab`.

- ac41e37: New `Modal`, built on the platform's `<dialog>` + `showModal()` rather than on
  Kobalte.

  **The choice was a measurement, not a preference.** `@cire/invites` and
  `@cire/landing` carry no Kobalte, and importing `@kobalte/core/dialog` costs
  **15.3 KB gzip** on top of a bare Solid bundle (2,270 → 17,564 bytes) against
  **~11.7 KB of headroom** in each — so a Kobalte-backed shared Modal does not
  fit in either, and adopting it would mean re-baselining the guest site's budget
  by roughly 9% on the surface people load on mobile data at a wedding.

  Most of that 15 KB buys behaviour the browser now does natively: `showModal()`
  gives a focus trap, Escape-to-close, background inertness and a `::backdrop`
  pseudo-element. What remains is reactive open/close, a backdrop-click that does
  not misfire, and the accessible name.

  **The top layer is the substantive win.** A `showModal()` dialog renders outside
  the normal flow, so it is immune to the trap that already cost this repository a
  bug: a `transform` on any ancestor becomes the containing block for
  `position: fixed` descendants _and_ a stacking context no `z-index` escapes.
  Motion One leaves its final inline `transform` on everything it animates, which
  is what put cire's RSVP toast under the sheet it fired beneath. All nine
  hand-rolled overlays here are `position: fixed` in a portal, each one an animated
  ancestor away from that. A browser test renders the Modal inside a transformed,
  `z-index: 2147483647` ancestor and asserts it is still the topmost element at its
  own centre — the bug class stops being possible rather than being avoided by
  convention.

  `@musubi/social` and `@pulse/web` keep the existing Kobalte-backed `Dialog`;
  nothing about it changes.

  Also adds a browser test project to `@shared/ui`. Almost everything worth having
  about `<dialog>` is unobservable in a DOM shim — the top layer, the focus trap,
  inertness, `::backdrop` — so a shim assertion that the element exists would pass
  just as happily against a `<div>` wearing the same classes.

- ac41e37: Lift `EmptyState`, `Notice`, `Stat`, `Chip` and `SafeProps` out of the two cire
  portals, re-keyed onto the design-token contract.

  All four existed twice — `cire/host` and `cire/vendor` — with **identical code
  and different docblocks**, each recording its own app's history of the drift
  that produced it. Both histories are worth keeping, so the merged docblocks
  carry both lessons: `EmptyState` says why it centres (seven copies set
  `items-start` _and_ `text-center`, two rules fighting visibly) **and** why it
  has a border at all (a copy without one reads as a list that failed to load,
  not one with nothing in it yet).

  **`Chip`'s tones are renamed to roles.** `live`/`active`/`quoted` became
  `success`/`pending`/`accent`: a shared component cannot know that "quoted" is a
  state a vendor puts an enquiry in, and an app maps its own word onto the role at
  the call site. That is also what stops a second product needing a second set of
  tones. The original values were raw Tailwind palette (`bg-green-500/15`), which
  are fixed sRGB and do not move when the theme flips — a blue chip that reads on
  a dark ground is a bright smear on a light one.

  **`SafeProps` is no longer cire-local.** It omits `innerHTML`, `innerText` and
  `textContent` from an element's props, because dom-expressions assigns
  `innerHTML` as unescaped markup — so any primitive that spreads rest props
  type-checks `<Notice innerHTML={vendorName} />`, which reads like ordinary prop
  passing and is a script tag.

  Adds a Tailwind build and a token mapping to `@shared/ui`'s browser project. The
  package ships no CSS, which is right for the package and useless for a test: an
  unresolvable contract utility emits nothing at all, so without a real build
  every colour assertion compares two empty strings and the suite goes green
  having measured an unstyled document. The mapping is deliberately synthetic —
  it exists so roles can be told apart, since under the contract's neutral
  fallbacks an unmapped library has no brand and `accent-ink` and `ink` are the
  same greyscale.

- ac41e37: Re-key every `@shared/ui` primitive onto the `@shared/design-tokens` contract.
  Fifteen components; `grep -rE '(bg|text|border|ring)-(background|foreground|card|popover|primary|secondary|muted|accent|destructive|input|ring)' shared/ui/src/ui` now returns nothing.

  The `base:` mechanism is unchanged — the built CSS is still
  `:where(.base\:bg-ui-ground){background-color:var(--ui-ground,#fff)}`, so
  component defaults keep zero specificity and a consumer's own class still wins.

  **This fixes a live defect as a side effect.** The destructive `Button` and
  `Badge` hard-coded `base:text-white`, so they never read
  `--destructive-foreground` at all — meaning the dark-mode contrast fix in
  `@musubi/social` and `@pulse/web` was inert for the two components it was
  meant to protect. Both now use `text-ui-on-danger` and pick it up.

  Two mappings worth recording, because the obvious reading is wrong. shadcn's
  `--accent` is a **neutral** in both consuming apps, so `bg-accent` and
  `focus:bg-accent` map to `bg-ui-surface-sunk`, not to `--ui-accent-soft`,
  which means a tint of the accent. And `hover:bg-primary/90` keeps its opacity
  as `hover:bg-ui-accent/90` rather than moving to `--ui-accent-strong`: the
  named token is a different colour from a 90%-opacity primary, and this change
  is not allowed to alter how anything renders. `--ui-accent-strong` stays part
  of the contract for product components that want a real hover colour.

  `bg-black/50` on the dialog scrim stays a literal. A scrim is black in both
  themes; it is not a theme colour and the contract has no role for it.

  One test moved with it: `ProfileSwitcher` picks the confirm button out of two
  "Delete" buttons by variant, so its class check is now `ui-danger`. The
  assertion is unchanged in substance.

- ac41e37: The primitives move onto the contract's size scales, and controls get a radius of their own

  The #1045 re-key moved every primitive's **colours** onto the contract and left
  its **sizes and radii** on Tailwind's defaults — 14 of 23 components still wrote
  `text-sm`, `rounded-md`, `rounded-full`. That is what the apps had been
  overriding: 82 component-override sites between `@musubi/social` and
  `@pulse/web`, and the commonest shapes were all "your default size is not our
  size". 36 utilities are now contract steps, mapped by value through
  `SCALE_MIGRATION` rather than by name.

  **`--ui-radius-control` is new**, and it is a role rather than a size — the
  same way `--ui-focus` is its own colour rather than an alias of the accent.
  How round a _control_ is turns out to be an app-level decision independent of
  how round a card is: musubi's house style is pill CTAs, cire's is a sharp 4px,
  pulse sits between. A shared control picking one of the sized steps gets
  overridden at every call site in at least one app, which is exactly what
  `<Button class="rounded-pill">` ×18 in musubi was. Those 18 are deleted.

  **`@pulse/web` had no type scale mapped at all.** It maps colours and radii, so
  every `text-ui-*` in a shared component was resolving to the contract package's
  neutral fallback — a different type system showing through in the middle of that
  one, and invisible, because a fallback renders legibly. Its seven steps are now
  written down, taken from `pulse/DESIGN.md` and from what the tree actually uses,
  and they land within half a pixel of the contract's own steps. Two tests hold
  them: all seven present, and the list ascending.

  `leading-none` stays Tailwind's in four single-line labels. The contract's
  `none` is 1.1 — a tight line, not literally none — so the two mean different
  things, and the contract now says so where the step is declared.

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

- ac41e37: Table cells get `align`, `tone` and `valign`, and stop colliding with the native attribute

  `Th` and `Td` take alignment, a muted tone and vertical alignment as props. A
  class override was never really an override: two Tailwind utilities on one CSS
  property resolve by stylesheet order rather than by their order in `class`, so
  `<Td class="text-right">` against the component's own `text-left` was a coin
  flip. 21 such overrides in `cire/host` are props now.

  Both types `Omit` the native `align` attribute rather than intersecting it.
  `<td align>` is a deprecated attribute typed `"left" | "center" | "right"`, and
  intersecting narrows the prop to the one value both unions share — so
  `align="end"` failed with `Type '"end"' is not assignable to type '"center"'`,
  which points nowhere near the cause. The same collision `Input`'s `size` has.

  `Table` sets `font-ui-body` itself, which three call sites were adding by hand.

### Patch Changes

- ac41e37: `Modal` guards `close()` the same way it already guarded `showModal()`

  jsdom gives `<dialog>` an `open` property that reflects the attribute, so
  `dialog.open` reads true there — while `close()` is missing entirely. The unmount
  handler's bare `ref.close()` was therefore a `TypeError`, and because it threw
  from a cleanup it took down the whole test file it was tidying up after rather
  than just the modal: eighteen failures in a suite where two were real.

  Both directions now go through a guarded helper — `showModal()` or the `open`
  attribute on the way in, `close()` or removing it on the way out.

- ac41e37: `Modal` degrades instead of throwing where `<dialog>` is unimplemented

  jsdom implements no part of `<dialog>` — `showModal` is `undefined` there, not
  merely inert — so calling it unguarded is a `TypeError` that takes the whole
  render down. `Modal` now falls back to the `open` attribute: a non-modal dialog,
  visible and with its contents reachable, without the top layer, focus trap or
  Escape that the method is what provides.

  That is a test environment rather than a browser, but the same is true of any
  server render, and a component that throws where it cannot do its best work is
  worse than one that degrades.

- ac41e37: `Modal`'s reduced-motion behaviour gets a browser test, and a `prefers-reduced-motion` command to write it with

  The 1ms clamp is load-bearing rather than cosmetic: the exit is _awaited_, so a
  transition that was never started is one there is nothing to wait for. `none`
  would leave `getAnimations()` empty — which happens to work, but takes the close
  down a different path from the one every other engine uses.

  The only assertion that existed for it went with the hand-rolled overlay the
  component replaced, and nothing put it back. Two cases now cover the duration
  and, more usefully, that the awaited exit still resolves — a modal that never
  finished closing under reduced motion would be a dialog nobody could dismiss.
