---
"@cire/ui": patch
"@cire/invites": patch
---

Guests see the dietary section, the gift page's own amount, a gift's reserve form and the chosen member's email and musubi boxes grow open instead of dropping in between two frames, and the calendar and maps menus pop open from their trigger.

Each block opens through `@cire/ui/reveal`: its height grows from nothing as it fades in, on the slow rung of the site's ladder (320ms on touch, 200ms at a desk), and it closes at once, because it holds fields. A block that is open when its state is restored — a reply on file, a household reopened from its session — paints open, with no motion. When the reserve form closes with focus inside it — Cancel, or Confirm once the reservation lands — focus goes to the card's Reserve or Change button, or to the gift's title when another household took the last one. A refused claim that leaves the form open puts focus back on Confirm.

`Reveal` takes a `pace` of `"base"` (the default) or `"slow"`. It now clips at its wrapper, whose edge grows with the opening, rather than at the row inside it, which Chromium sizes against the wrapper's own height and so lags behind it; and it keeps 4px of room inside the clip, so a focus ring at the content's edge stays whole, the "Anything else" field's included. That room takes no taps, shut, opening or open, so a tap on the bottom of the control above a `Reveal` reaches it.

The link menus scale up from 0.96 and fade in from the corner at their trigger, on `--dur-base` and `--ease-out`, and close at once.
