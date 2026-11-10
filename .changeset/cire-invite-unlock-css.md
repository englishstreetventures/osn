---
"@cire/invites": patch
---

The guest invite's unlock reveal runs on CSS keyframes instead of the `motion` library. The code form lifts away, the welcome rises with its heading's shimmer, and the events rise with their cards one after another, on the same times, curves and distances in both design packs. One sequence (`components/unlock-reveal.ts`) orders the steps for both packs; each step's timing is a per-pack custom property in `global.css`. The events section and cards no longer keep an inline `transform` after the reveal, and the code form keeps only an inline `opacity: 0`, which sign-out clears.

`motion` stays a dependency for the event sheet's swipe spring, and is now the only import the SSR stub covers.
