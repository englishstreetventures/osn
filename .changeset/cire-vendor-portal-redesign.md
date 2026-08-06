---
"@cire/vendor": patch
---

Bring the host portal's redesign across to the vendor portal.

The vendor portal was still on the pre-redesign look: a dark-only palette, a
Google Fonts `<link>` on all three page shells, and hand-written Tailwind class
constants duplicated between surfaces. This ports the parts of #372–#378 that
apply to it.

**Foundation.** The two OKLCH ramps from the host portal, value-for-value —
dark on bare `:root`, light via both `prefers-color-scheme` and an explicit
`data-theme`, with a three-state (`system` / `light` / `dark`) preference and a
zero-import boot script inlined before first paint so a chosen light theme never
shows a frame of dark. `tokens.test.ts` asserts the contrast contract (alpha
composited over the real ground) *and* that both ramps stay identical to
`@cire/organiser`'s, since they are duplicated rather than imported. Motion
tokens, the radius scale, one focus ring, `tabular-nums`, and a global
reduced-motion kill switch come with them.

**Type.** Schibsted Grotesk and Cormorant Garamond are now self-hosted at build
time via Astro's Fonts API. Lato is gone — it was the guest site's face. The
`<link>` to `fonts.googleapis.com` mattered most on `/claim`, which is opened
straight from an emailed invite and told Google about every vendor who followed
one before rendering a word.

**Primitives.** `components/ui/`: `Button`, `Card`, `Notice`, `EmptyState`,
`Field` (+ `Input`, `Textarea`, `Select`, `Fieldset`, `Checkbox`), plus a `Chip`
and a `Loading` this portal needed. `SafeProps` keeps `innerHTML` off anything
that spreads onto an element. The `Meter`, `Stat` and `Table` primitives were
deliberately not ported — no vendor surface has a bar, a figure or a table.

**Chrome.** One sticky row replaces the masthead and the row of four bare text
buttons under it. The Listings/Enquiries toggle is a real segmented control with
a single travelling highlight (`createSlidingPill`), and sign-out moved into an
avatar menu, so "leave" is no longer one mis-click from "switch view". The menu
carries the theme and haptics controls; account management links out to musubi,
because passkeys are bound to that RP ID and an in-portal panel would only be a
hop to get past. The panel below animates between content heights
(`createAutoSize`) so nothing in the chrome moves on a view swap.

**Fixes found on the way**

- The quote form's live-formatted amount sat inside the input's `<label>`, so
  the box announced itself as "Quote amount $1,200.00" and re-announced the
  whole thing on every keystroke. It is a `hint` now — a description, not a name.
- The enquiry status chips used raw Tailwind palette values (`text-blue-400`,
  `text-green-400`) that do not move with the theme; on the light ramp they were
  smears. They are ramp tones now.
- The "no organisations yet" empty state told vendors to create one in their OSN
  account with nothing to click. `OSN_ACCOUNT_URL` was already in `lib/osn.ts`;
  it is a link now.
- Message bubbles distinguished sender by alignment alone; each now carries an
  `sr-only` "You wrote"/"They wrote", and timestamps are `<time>` elements.
- Relative timestamps could render "-1m ago" when the server clock ran ahead of
  the browser's. Clamped at zero.
- A rejected save left its message only in a toast that had since faded; the
  listing form and the enquiry thread now keep it on the surface too.

**Hardening.** The CSP drops `fonts.googleapis.com` and `fonts.gstatic.com`
from `style-src`/`font-src` now that nothing links them, and `headers.test.ts`
asserts their *absence* rather than their presence — so re-adding a `<link>`
without re-adding the origin fails the suite instead of silently falling back to
Georgia under enforcement.

This branch also put `astro check` on the package and fixed the type errors it
had been hiding — but `cire-vendor-type-check` landed the same thing on main
first, in parallel, down to the same `apiBase` value. That work is main's, not
this branch's; what survives here is the larger surface for the gate to cover.

**Review fixes.** The account menu is the package's only Kobalte consumer — 87 KB
raw / 28 KB gzip — and porting it eagerly would have put that on a `client:only`
island's critical path for a menu most sessions never open. It is `lazy()` now,
behind an avatar placeholder that shares the real trigger's class and contents so
the swap moves nothing, warmed on idle and on pointer-enter/focus, with a click
routed through `autoOpen` so a press landing before the chunk is not swallowed.
Measured after the change: `ProfileMenu` is its own 28.0 KB gz chunk and the
`VendorApp` entry contains no Kobalte at all. The three page shells also preload
only the `latin` subset — `<link rel=preload as=font>` bypasses `unicode-range`,
so the bare form was downloading `latin-ext` unconditionally to render chrome
that is English.
