# Vendor portal — design system

The visual system for `@cire/vendor` (`vendor.cireweddings.com`).

**It is the host portal's system.** `cire/host/DESIGN.md` is the document —
the colour law, the type ration, the shape/depth/motion scale, the layout rules,
the component contracts. Read that first; this file records only where this
portal differs, and why.

The two are two doors into one product, and a vendor who also hosts a wedding
moves between them in one session. A green that is a shade off between the two
reads as a bug in whichever one they opened second.

---

## What is shared, and how it stays shared

The ramps in `src/styles/global.css` are **copied**, value-for-value, from
`cire/host/src/styles/global.css` — not imported. A cross-package CSS
import would make Tailwind scan the other package's source for classes, which
costs a build and couples the two scanners.

Copies drift, so the copy is asserted:
`tests/styles/tokens.test.ts` reads the host portal's stylesheet beside this
one and fails if any token in either ramp differs. A deliberate divergence goes
there as an exception with a reason, not as a silently different green.

The same file also carries the host portal's own contract — every text pair over
4.5:1, every UI pair over 3:1, translucent tokens composited over their real
ground before measuring, and the two hand-duplicated light blocks held equal.

It also holds all four cire apps — this portal, the host portal, the guest site
and the marketing site — to one corner scale and one motion ladder. It reads
each app's `src/styles/global.css` and fails if a corner role (`control` 999px,
`field` 14px, `lg` 16px, `md` 10px, `sm` 6px, `hair` 2px, `pill` 999px), a
`--radius-*` step, `--toast-radius` (10px wherever `@shared/toast` loads) or a
line of the `--dur-*` ladder, its `pointer: fine` block or the easings differs,
or if the base-layer rules that draw an unchecked native checkbox or radio
(host §4, Checkboxes and radios) differ in any app.
The one gap is by design: this portal renders no `Modal`, so it sets no
`--ui-modal-*` timing. `turbo.json` names the other three stylesheets as the
test task's inputs, so a change to any of them re-runs this suite rather than
replaying a cached pass. What each corner paints is host §4.

The theme and haptics preference, the theme boot script, touch feedback and
the auto-sized frame are `@cire/ui`'s (`lib/theme`, `lib/theme-boot`,
`lib/haptics`, `lib/auto-size`), shared with the host portal and tested there.
`src/lib/` holds only this portal's wiring: `preference-keys.ts` (the storage
keys and the boot script), `preferences.ts` and `touch-feedback.ts`. The
sliding pill is `@cire/ui`'s too. This portal declares the spring
(`--ease-spring` and its `@supports` block, host §4), because its glass strip
slides on it.
Every form field here takes `@shared/ui`'s `size="form"` and is 34px, as host
§4 ("One form-field height") sets; `tests/styles/form-field.test.ts` holds
it. A button beside one would be `Button`'s `form` size; this portal has none.

The one pill language (host §4) holds here as it does there: this stylesheet
sets the two pill tokens `@cire/ui`'s `Button` reads, `--pill-ground` and
`--pill-sm-height` (`tests/styles/pill-tokens.browser.test.tsx` measures
both), and `--elev-2` carries the inner lip, so its menus are the host's
floating depth. Its primary button is gold, as the host's is (host §2).

---

## The deltas

### Measure: 68rem, not 100rem

`page-frame`'s default `--page-max`. The host portal earns 100rem with a module
rail and a side-by-side invite preview; this portal has neither. A listing form
stretched across a widescreen is a form nobody can scan.

The login and claim pages set their own much narrower measures (30rem, 40rem)
through the same knob; the login page's is `@cire/ui`'s `SignInCard`, shared
with the host portal.

### Type: no italic

The host portal ships Cormorant's italics because its invite preview uses them.
There is no invite preview here, so only the roman is downloaded. Cormorant is
rationed to the wordmark, an organisation's name, the name on a claim invite,
and an account's initial (`PersonAvatar`, host §3).

Lato is gone. It was the guest site's body face and this is not the guest site —
the same split `cire/host` made.

### Haptics: three names, not five

`commit`, `reject`, `dismiss`: the `names` `src/lib/touch-feedback.ts` passes
to `createHaptics`, which plays no other. The host portal's vocabulary has
`pickup` and `step` because it has drag-to-reorder; this portal has neither, and a name with
no call site is a name the next person will find a use for.

### Storage keys: `cire.vendor.*`

Not `cire.host.*`. `localStorage` is partitioned by origin and the two portals
are two hosts, so they could not share a value even if the names matched — a
shared name would only promise a continuity it cannot deliver.
`tests/lib/preferences.test.ts` pins this, because the obvious way to add a preference
here is to paste one from the host portal.

### Navigation: a two-tab strip, no command palette

The host portal has seven modules, sub-tabs and a rail, which is what makes a
⌘K palette worth its weight. This portal has two views. A palette over two
destinations is chrome for chrome's sake, and it was deliberately **not**
ported. `ViewTabs` is `@cire/ui`'s `SegmentedTabs`, the glass strip every
segmented control in both portals is (host §7): one 28px track, a frosted
highlight that slides on `--ease-spring`, sentence-case labels, the chosen one
in readable gold at medium weight.

Nor is the strip an ARIA `tablist` (`semantics="current"`). The tab pattern promises a panel that is a
sibling of the strip plus roving arrow-key focus, and neither is true — these
swap the whole page and push history. Two buttons, with `aria-current` naming
the one you are on.

### Account: a link out, not a panel

The host portal's profile menu opens an in-portal security view. Passkeys and
recovery codes are bound to the `musubi.social` RP ID, so every ceremony has to
run on musubi's own origin anyway — a local screen whose every button then
redirected would be a hop that exists only to be got past. The row is the
shared menu's link row (`DropdownMenuItem as="a"`) to `PUBLIC_OSN_ACCOUNT_URL`
with `target="_blank"`, which adds `noopener noreferrer` itself. The menu is
the shared `DropdownMenu` on its accent look, as every portal menu is (host
§7), and ends on the build's version as the host's account menu does.

---

## Components

This portal holds no parts of its own: every part comes from the two packages
the host portal draws on (host §7).

- Shared with the host portal: `Button`, `buttonClass`, `proseLinkClass` (the
  link inside the claim page's warning keeps the readable gold, as host §7 says
  of a link inside a tinted `Notice`), `Card`, `cardClass`,
  `cardBoxClass`, `Eyebrow`, `eyebrowClass`, `Wordmark` and
  `WordmarkPlaceholder` (the top bar's way home and the boot bar's copy),
  `SignInCard` and `SignInPanel` (the login page), `PersonAvatar` with
  `avatarTriggerClass` (the account trigger, and its placeholder while the
  menu's code loads), and `MessageThread` (an enquiry's messages and reply box,
  host §7, An enquiry thread) from `@cire/ui`; `Notice`,
  `EmptyState`, `Field`, `Fieldset`, `Input`, `Textarea` and `Select` from
  `@shared/ui`.

**Not used here:** `Meter`, `Stat`, `Table`, `CardCta`. No surface here has a bar,
a headline figure or a table.

**Used here and not in the host portal:**

| Part | Where | Why |
| --- | --- | --- |
| `Chip`, `ChipTone` | `shared/ui/src/ui/chip.tsx` | A pill naming a state — a listing that is live or a draft, an enquiry open, quoted or closed. The tones are ramp tokens, never the raw Tailwind palette, so the chip moves when the theme flips. Its word is a badge, so it stays in small caps. Filled, its tint is 8% of the tone, so the word clears 4.5:1 on the light ramp; the host portal draws its badges, tags and run-sheet flags with the same part, outlined where a badge sits beside text (host `DESIGN.md` §7). |
| `Loading` | `cire/ui/src/loading.tsx` | `<p role="status">` with a pulse, for a surface waiting on its data, so no surface can forget the role: a spinner nobody announces is a blank screen. `status`, not `alert`: something starting to load is not urgent. Its words are a status line, so they stay in small caps. |
| `Checkbox` | `shared/ui/src/ui/checkbox.tsx` | A native checkbox and its word as one clickable row, for the service-category grid. It takes its word as `label` and `box="native"`, so its box is the browser's own, as every cire box is (host §4, Checkboxes and radios). |

**Corners here** follow host §4. The small steps this portal draws: the
wordmark's hover wash at 6px (a nav highlight, `Wordmark`); the profile menu's panel and
rows take the shared menu's 10px and 6px. The quote form nested in the enquiry thread's
card is 6px too, drawn from the card's box (`cardBoxClass({ fill: "none",
nested: true })`) with its own 16px padding. The login card takes the 16px card
corner. The thread's messages and reply box are `MessageThread`'s, drawn as host
§7, An enquiry thread, says; this portal adds no corner of its own to them. The round marks — the avatar, the
haptics switch — are `rounded-full`.

**Cards here** take a step of `cardClass` (host §7): an enquiry in the inbox is
the interactive card at `sm`, and the sign-in card is `@cire/ui`'s
`signInCardClass`, `xl` on the opaque surface with the lit top edge, the same
as the host portal's. Every label that leads a
card or a section is `Eyebrow`, and the two `.astro` pages' is `eyebrowClass`.
None repeats the heading under it (host §3, An eyebrow over a heading): the top
bar's tabs already say "Listings" and "Enquiries", so the listing editor's
heading (the organisation's name) and the inbox's stand alone. The sign-in and
claim pages keep "Cire · Vendor portal": neither has a top bar, so it is the
only line naming the site. The claim card keeps "You've been invited to
claim", the label of a card that holds only the listing's name.
`tests/components/eyebrows.browser.test.tsx` reads the inbox's and the listing
editor's headings in Chromium and pictures both at 390 and 1280px, light and
dark, in `e2e-artifacts/cire-eyebrows/vendor/`.
`tests/components/surfaces.browser.test.tsx` draws the inbox row, the quote form
and the sign-in card in Chromium at 390 and 1440px, light and dark, measures
each box and the quote form's label, and writes each picture to
`e2e-artifacts/cire-surfaces/vendor/`.

`tests/components/soft-shapes.browser.test.tsx` renders the dashboard's listing
editor in Chromium at 390 and 1440px, light and dark, and measures the computed
corners: "Save listing" and "← All organisations" pills, every text field and
select in the listing editor 34px at 14px, short of a pill, the description
textarea 14px, the editor card 16px, the
listing's status chip a pill, a category checkbox the browser's own box. It writes each
screenshot to `e2e-artifacts/cire-soft-shapes/vendor/`. `bun run --cwd cire/vendor
test:browser` runs it; `test:run` runs the unit project alone.

Both house rules from the host portal apply unchanged: anything spread onto an
element takes `SafeProps` (so `innerHTML` cannot reach a primitive), and colour
never carries a meaning on its own.

---

## The one design law, here

> **The container is continuous; only its contents change.**

`VendorApp` holds one `createAutoSize` frame around the whole panel. Switching
view, picking an organisation, and opening an enquiry are all content swaps
inside it: the frame animates between heights and the new contents fade up
(`panel-in`), and nothing in the top bar moves.

`createAutoSize` holds nothing at rest — no pixel height survives the
transition — so a resized window or a late font never fights a stale number.
