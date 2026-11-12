---
"@cire/ui": patch
"@cire/host": patch
"@cire/vendor": patch
---

The glass in every segmented strip glides to the chosen choice instead of bouncing past it. Its place moves on `--ease-glide`, a new spring in both portals that goes 3% past and settles, against the house spring's 8%; its width and height ease out, so it never grows past the tab it lands on. Both run on `--dur-slow`, 320ms on touch and 200ms at a desk, a little slower than before so the move can be felt. A second tap mid-move starts from where the glass is, and a reader who turned motion down still sees it jump.
