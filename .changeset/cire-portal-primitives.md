---
"@cire/organiser": patch
---

Give the host portal a set of shared primitives, and two motion utilities to move with.

The portal's modules had grown by copy-paste, and the copies had drifted. Thirteen hand-written error blocks carried three different paddings. The guest table and the RSVP table disagreed on the size and padding of a column head. All seven "nothing here yet" boxes set `items-start` and `text-center` at once — two rules fighting, and the fight visible on screen. `src/components/ui/` now holds one answer for each of those shapes: `Button`, `Card`, `Notice`, `EmptyState`, `Table`, `Meter` and `Stat`.

They are deliberately small. There is no `clsx` or `tailwind-merge` in this package, so a passed `class` appends rather than overrides — anything that wants a different colour or padding wants a new variant, not a longer class string at the call site. None of them carry a focus ring, because `global.css` already gives every element a `:focus-visible` outline. `Button` does not fire a haptic either: the portal's haptic vocabulary answers the moment a change _takes_, and a press that opens a dialog or starts a request that later fails has nothing yet to confirm.

Alongside them, two utilities the shell already needed. `createAutoSize` animates a panel between its own heights and holds nothing at rest, so a resized window or a changed font never leaves a stale pixel height behind. `createSlidingPill` moves a single highlight between tabs instead of cross-fading one per tab, which is what makes the module rail read as one control rather than a row of them.
