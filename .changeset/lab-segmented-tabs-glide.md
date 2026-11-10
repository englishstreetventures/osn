---
"@tools/lab": patch
---

The `SegmentedTabs` stories set the portals' `--ease-glide` on their panels, in the `cubic-bezier` form the portals fall back to, so the glass glides in the lab on the portals' curve. It runs at the touch pace, 320ms, even with a mouse, where the portals take 200ms.
