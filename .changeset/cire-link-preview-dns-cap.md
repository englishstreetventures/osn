---
"@cire/api": patch
---

Cap the DNS lookups one registry link preview can make at 12. Each lookup is
two DNS-over-HTTPS requests, so a preview now makes at most 28 outbound
requests of its own however many image hosts the page lists. Before this, a
page naming hundreds of hosts made the preview resolve each one in turn. A host
past the budget is refused without a query and never offered as an image, and
the preview logs one warning when that happens.

The page scan also stops collecting at 32 candidates per band (social-card
images and `image_src` links, as `<img>` tags already did), skips any candidate
URL over 2,048 characters, and decodes only as much of a title as it keeps, so
a hostile page no longer costs more CPU than a Workers Free invocation gets.
