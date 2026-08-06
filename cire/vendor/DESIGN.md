# Vendor portal — design system

The visual system for `@cire/vendor` (`vendor.cireweddings.com`).

**It is the host portal's system.** `cire/organiser/DESIGN.md` is the document —
the colour law, the type ration, the shape/depth/motion scale, the layout rules,
the component contracts. Read that first; this file records only where this
portal differs, and why.

The two are two doors into one product, and a vendor who also hosts a wedding
moves between them in one session. A green that is a shade off between the two
reads as a bug in whichever one they opened second.

---

## What is shared, and how it stays shared

The ramps in `src/styles/global.css` are **copied**, value-for-value, from
`cire/organiser/src/styles/global.css` — not imported. A cross-package CSS
import would make Tailwind scan the other package's source for classes, which
costs a build and couples the two scanners.

Copies drift, so the copy is asserted:
`src/styles/tokens.test.ts` reads *both* stylesheets and fails if any token in
either ramp differs. A deliberate divergence goes there as an exception with a
reason, not as a silently different green.

The same file also carries the host portal's own contract — every text pair over
4.5:1, every UI pair over 3:1, translucent tokens composited over their real
ground before measuring, and the two hand-duplicated light blocks held equal.

`src/lib/` carries three verbatim ports: `theme.ts` / `theme-boot.ts`,
`auto-size.ts`, `sliding-pill.ts`. They are generic and have their own tests.

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
the same split `cire/organiser` made.

### Haptics: three names, not five

`commit`, `reject`, `dismiss`. The host portal's vocabulary has `pickup` and
`step` because it has drag-to-reorder; this portal has neither, and a name with
no call site is a name the next person will find a use for.

### Storage keys: `cire.vendor.*`

Not `cire.host.*`. `localStorage` is partitioned by origin and the two portals
are two hosts, so they could not share a value even if the names matched — a
shared name would only promise a continuity it cannot deliver.
`src/lib/theme.test.ts` pins this, because the obvious way to add a preference
here is to paste one from the host portal.

### Navigation: a two-tab strip, no command palette

The host portal has seven modules, sub-tabs and a rail, which is what makes a
⌘K palette worth its weight. This portal has two views. A palette over two
destinations is chrome for chrome's sake, and it was deliberately **not**
ported. `ViewTabs` uses the same `createSlidingPill` the host portal's tab
strips use.

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

`src/components/ui/` is a **subset** of the host portal's set, plus two.

Ported, contract-identical: `Button` (+ `buttonClass`), `Card` (+ `cardClass`,
`CardEyebrow`), `Notice`, `EmptyState`, `Field` (+ `Input`, `Textarea`,
`Select`, `Fieldset`), `props.ts`.

**Not ported:** `Meter`, `Stat`, `Table`, `CardCta`. No surface here has a bar, a
headline figure or a table. An unused primitive is a thing to keep in sync for
nothing; port one when a surface needs it, and take its test with it.

**Added here:**

| Part | Why |
| --- | --- |
| `Chip` | A pill naming a state — a listing that is live or a draft, an enquiry open/quoted/closed. Two call sites that had drifted to different sizes, and both reached for the raw Tailwind palette (`text-blue-400`, `text-green-400`) — fixed sRGB that does not move when the theme flips. The tones are ramp tokens. The host portal writes its role badge longhand in `TopBar`; this is the shape it would take if it adopted one. |
| `Loading` | `<p role="status" class="… animate-pulse …">`, written out on five surfaces — five chances to forget the role, and a spinner nobody announces is a blank screen. `status`, not `alert`: something starting to load is not urgent. |
| `Checkbox` (in `Field.tsx`) | A checkbox and its word as one clickable row, for the service-category grid. The label wraps the control rather than pointing at it by id — the one place nesting is better, since the whole row is the hit target and a `for`/`id` pair would need an id invented per category key. |

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
