---
"@cire/host": patch
---

Rebuild the host portal's read surfaces on the shared primitives, and take the three big write panels out of the first load.

The Overview, the module read views and the tables were each drawing their own box, alert, empty message and progress bar. They now compose `Card`, `Notice`, `EmptyState`, `Table`, `Meter` and `Stat` instead. The Overview moves to `Card` with `CardEyebrow` and `CardCta`, and reads its figures through `Meter` and `Stat`; nine files drop bespoke alert markup for `Notice`; three take `EmptyState`; three take `Table`. Getting Started's progress rail becomes the shared `Meter` too, so it animates on a transform like the Overview's rather than on a width. Same information on screen, one visual language behind it, and one place to change any of it.

The second half is weight. The portal mounts as a single `client:only` island, so nothing paints until the whole island arrives — including the invite builder with every design in `@cire/invite-designs`, and the events editor with solid-dnd. Neither is on the path to the page an organiser lands on, and a viewer cannot open either at all. Those two and the guests editor are now `lazy()` behind a `Suspense` fallback, which takes initial-load JS from 569,541 to 399,999 bytes raw and from 159,060 to 115,098 gzipped. Pointing at one of those sub-tabs — a hover, or a keyboard focus — starts its fetch, so the click that follows usually mounts a module that is already in. The read views stay eager on purpose: they are small, and a rail click that pauses is the worse trade.
