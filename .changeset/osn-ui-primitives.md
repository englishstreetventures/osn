---
"@shared/ui": minor
---

Lift `EmptyState`, `Notice`, `Stat`, `Chip` and `SafeProps` out of the two cire
portals, re-keyed onto the design-token contract.

All four existed twice — `cire/host` and `cire/vendor` — with **identical code
and different docblocks**, each recording its own app's history of the drift
that produced it. Both histories are worth keeping, so the merged docblocks
carry both lessons: `EmptyState` says why it centres (seven copies set
`items-start` *and* `text-center`, two rules fighting visibly) **and** why it
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
