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

`src/lib/` carries three verbatim ports: `theme.ts` / `theme-boot.ts`,
`auto-size.ts`, `sliding-pill.ts`. They are generic and have their own tests.
`form-field.ts` holds the host's `FORM_FIELD_CLASS` (`h-8.5`): every form field
here is 34px, as host §4 ("One form-field height") sets. This portal has no
button in a row with a field, so it carries no `FORM_ACTION_CLASS`.

---

## The deltas

### Measure: 68rem, not 100rem

`page-frame`'s default `--page-max`. The host portal earns 100rem with a module
rail and a side-by-side invite preview; this portal has neither. A listing form
stretched across a widescreen is a form nobody can scan.

The login and claim pages set their own much narrower measures (26rem, 40rem)
through the same knob.

### Type: no italic

The host portal ships Cormorant's italics because its invite preview uses them.
There is no invite preview here, so only the roman is downloaded. Cormorant is
rationed to the wordmark, an organisation's name, and the name on a claim
invite.

Lato is gone. It was the guest site's body face and this is not the guest site —
the same split `cire/host` made.

### Haptics: three names, not five

`commit`, `reject`, `dismiss`. The host portal's vocabulary has `pickup` and
`step` because it has drag-to-reorder; this portal has neither, and a name with
no call site is a name the next person will find a use for.

### Storage keys: `cire.vendor.*`

Not `cire.host.*`. `localStorage` is partitioned by origin and the two portals
are two hosts, so they could not share a value even if the names matched — a
shared name would only promise a continuity it cannot deliver.
`tests/lib/theme.test.ts` pins this, because the obvious way to add a preference
here is to paste one from the host portal.

### Navigation: a two-tab strip, no command palette

The host portal has seven modules, sub-tabs and a rail, which is what makes a
⌘K palette worth its weight. This portal has two views. A palette over two
destinations is chrome for chrome's sake, and it was deliberately **not**
ported. `ViewTabs` uses the same `createSlidingPill` the host portal's tab
strips use.

The strip is a pill track — track, sliding highlight and tabs all `rounded-pill`
— with small-caps labels, as a tab strip's are. The host portal's segmented
view tabs are 6px, because they sit in a view bar beside pill-shaped chips, and
the 6px box is what tells a segmented control from a chip there. This
strip has no chips beside it, so the pill reads as one control.

Nor is the strip an ARIA `tablist`. The tab pattern promises a panel that is a
sibling of the strip plus roving arrow-key focus, and neither is true — these
swap the whole page and push history. Two buttons, with `aria-current` naming
the one you are on.

### Account: a link out, not a panel

The host portal's profile menu opens an in-portal security view. Passkeys and
recovery codes are bound to the `musubi.social` RP ID, so every ceremony has to
run on musubi's own origin anyway — a local screen whose every button then
redirected would be a hop that exists only to be got past. The row is an
anchor to `PUBLIC_OSN_ACCOUNT_URL`, `target="_blank"` and `rel="noopener"`.

---

## Components

This portal holds no parts of its own: every part comes from the two packages
the host portal draws on (host §7).

- Shared with the host portal: `Button`, `buttonClass`, `proseLinkClass` (the
  link inside the claim page's warning keeps the readable gold, as host §7 says
  of a link inside a tinted `Notice`), `Card`, `cardClass`,
  `cardBoxClass`, `Eyebrow` and `eyebrowClass` from `@cire/ui`; `Notice`,
  `EmptyState`, `Field`, `Fieldset`, `Input`, `Textarea` and `Select` from
  `@shared/ui`.

**Not used here:** `Meter`, `Stat`, `Table`, `CardCta`. No surface here has a bar,
a headline figure or a table.

**Used here and not in the host portal:**

| Part | Where | Why |
| --- | --- | --- |
| `Chip`, `ChipTone` | `shared/ui/src/ui/chip.tsx` | A pill naming a state — a listing that is live or a draft, an enquiry open, quoted or closed. The tones are ramp tokens, never the raw Tailwind palette, so the chip moves when the theme flips. Its word is a badge, so it stays in small caps. Filled, its tint is 8% of the tone, so the word clears 4.5:1 on the light ramp; the host portal draws its badges, tags and run-sheet flags with the same part, outlined where a badge sits beside text (host `DESIGN.md` §7). |
| `Loading` | `cire/ui/src/loading.tsx` | `<p role="status">` with a pulse, for a surface waiting on its data, so no surface can forget the role: a spinner nobody announces is a blank screen. `status`, not `alert`: something starting to load is not urgent. Its words are a status line, so they stay in small caps. |
| `Checkbox` | `shared/ui/src/ui/checkbox.tsx` | A Kobalte checkbox and its word as one clickable row, for the service-category grid. It takes its word as `label` and draws its box at the 6px step. |

**Corners here** follow host §4. The small steps this portal writes itself: the
profile menu at 10px (a menu); at 6px its rows' highlight and the wordmark's
hover wash (a nav highlight). The quote form nested in the enquiry thread's
card is 6px too, drawn from the card's box (`cardBoxClass({ fill: "none",
nested: true })`) with its own 16px padding. The login card and the thread's
message bubbles take the 16px card corner. The round marks — the avatar, the
haptics switch — are `rounded-full`.

**Cards here** take a step of `cardClass` (host §7): an enquiry in the inbox is
the interactive card at `sm`, and the sign-in card is `xl` on the wash with the
`lip` (`LOGIN_CARD_CLASS`, `src/lib/login-card.ts`). Every label that leads a
card or a section is `Eyebrow`, and the two `.astro` pages' is `eyebrowClass`.
`tests/components/surfaces.browser.test.tsx` draws the inbox row, the quote form
and the sign-in card in Chromium at 390 and 1440px, light and dark, measures
each box and the quote form's label, and writes each picture to
`e2e-artifacts/cire-surfaces/vendor/`.

`tests/components/soft-shapes.browser.test.tsx` renders the dashboard's listing
editor in Chromium at 390 and 1440px, light and dark, and measures the computed
corners: "Save listing" and "← All organisations" pills, every text field and
select in the listing editor 34px at 14px, short of a pill, the description
textarea 14px, the editor card 16px, the
listing's status chip a pill, a category checkbox's box 6px. It writes each
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
