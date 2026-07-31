---
"@cire/web": patch
---

RSVP sheet spacing — action bar seated on the sheet's edge, balanced guest cards.

Three layout defects in the guest RSVP sheet (`RsvpModal` on `AnimatedModal`),
measured in a real browser at 390×844 and 1280×900:

**The action bar floated 41px above the sheet's bottom edge.** The Cancel/Save
row is `sticky bottom-0` and cancelled the panel's bottom padding with
`-mb-[max(2.5rem,env(safe-area-inset-bottom))]`. But a sticky box resolves
`bottom: 0` against the scrollport, so the negative bottom margin doesn't
stretch the bar down into the padding — it *hoists the bar up* by 40px. The
result was an empty band of surface below the bar, with guest content visible
under it. `AnimatedModal` gained a `flushBottom` prop that drops the panel's own
bottom padding, and the bar dropped the negative margin: the bar now owns the
bottom edge and its safe-area padding, sitting flush at every breakpoint.

**The bar permanently clipped the last guest's card.** Same cause: the 40px hoist
overlapped the card above it by 20px on a short sheet, and by up to 100px on a
scrolling one. Scrolled fully to the bottom the overlap remained ~19px, so the
last card's bottom edge could never be seen. It now clears the bar by the form's
own 20px gap.

**Each guest card was top-heavy — 58px above the first control, 21px below.**
A `<legend>` is laid out in the fieldset's top border and the block-start
padding is added *below* it, so `p-5` stacked the legend's line box (26px) and
its `mb-3` on top of another 20px. The card takes `pt-0` now, keeping `px-5
pb-5`; the first control sits ~25px under the border, level with the 20px inset
on the other three sides.

`AnimatedModal`'s default padding branch (no `flushBottom`) is unchanged, so
`DetailsModal`'s spacing is untouched — but see the close-button change below,
which does alter both modals. Regression tests pin the two padding modes, the
bar's lack of a negative bottom margin, and the card's asymmetric padding.

**Close button no longer scrolls out of view.** Same component, adjacent defect:
`AnimatedModal`'s "×" was `absolute` *inside* the panel, which was itself the
scroll container, so on any sheet tall enough to scroll it left the viewport
entirely and the guest was down to Escape or a backdrop tap. The panel is now a
non-scrolling frame (`flex flex-col overflow-hidden`) holding the close button
alongside a `min-h-0 overflow-y-auto` inner scroller that carries the padding.
The button needs no z-index — a positioned box already paints over its
non-positioned in-flow siblings — and gained `bg-surface` + `rounded-full`
because content now passes underneath it as it scrolls. `DetailsModal` gets the
fix for free. This also gives the sticky action bar a containing block that is
the scrollport itself.

**Keyboard scrolling, restored.** Pinning the close button outside the scrollport
cost the sheet its keyboard: focus landed on that button, whose nearest
scrollable ancestor is now the `overflow-hidden` frame and then a `<body>` the
modal deliberately locks, so Arrow and Page keys moved a scrollable sheet 0px
(measured). Focus now lands on the scroll container itself (`tabindex="0"`,
which also puts it in the focus trap) — ArrowDown 0→40px, PageDown 40→594px,
Home back to 0. The close button stays first in DOM, so it is still the first
stop when tabbing round. The scroller also takes `scroll-pt-14`, reserving the
button's 52px footprint so tabbing backwards — which scrolls a target to the top
of the scrollport, exactly where the button sits — can never park a control
underneath it.
