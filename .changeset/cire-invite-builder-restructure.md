---
"@cire/organiser": minor
---

Restructure the invite builder so the customisation options map onto the guest
invite instead of onto the API:

- One card per guest-page section, in the order guests scroll them (Typography
  → Hero → Our Story → Code Entry & Welcome → Events Section → the copyable
  invite message, flagged as not part of the guest page). Each card owns
  everything about its section — image, copy, accent/background colours, and a
  live preview — so a section's colours no longer live in a separate "Theme"
  block five fieldsets away.
- Section previews are driven by the live copy buffers as well as the pickers,
  so typing a new heading updates the preview instantly; the hero's WYSIWYG
  preview now also reflects the picked accent colour, heading font, and
  Background-tinted title panel alongside the image + sliders.
- One "Save invite" action in a sticky bottom bar replaces the separate "Save
  copy" / "Save theme" buttons (whose split left the hero sliders saving from a
  button five fieldsets below them). It PUTs the text body then the theme body;
  errors surface next to the button, and a text-half failure stops before the
  theme PUT.
