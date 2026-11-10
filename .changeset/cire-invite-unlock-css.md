---
"@cire/invites": patch
---

The guest invite's unlock reveal runs on CSS keyframes instead of the `motion` library. The code form now closes at once instead of fading and lifting away, so its field and button never take input in a box that is going away; the welcome rises with its heading's shimmer, and the events rise with their cards one after another, on the same times and distances as before in both design packs. Every rise now runs on the house `--ease-out` curve, gala's included, in place of gala's own curve; the two differ by less than a frame. One sequence (`components/unlock-reveal.ts`) orders the steps for both packs; each step's timing is a per-pack custom property in `global.css`. The reveal leaves no inline style on the code form, and the events section and cards keep no inline `transform` after it. `LoginSection` drops its `formRef` prop, which only the reveal used.

`motion` stays a dependency for the event sheet's swipe spring, and is now the only import the SSR stub covers.
