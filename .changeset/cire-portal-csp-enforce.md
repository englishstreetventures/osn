---
"@cire/host": patch
"@cire/vendor": patch
---

Enforce the Content-Security-Policy on both cire portals.

Each portal's full policy moves from `Content-Security-Policy-Report-Only` to
`Content-Security-Policy`, so the browser now blocks scripts, connections,
frames and form targets the policy does not allow, instead of only reporting
them. The three-directive enforced line it replaces is gone; its directives
are part of the full policy.

The organiser portal's enforced `img-src` adds `https:`, because the registry's
shop link picker shows candidate images from each shop's own host. A second,
report-only header keeps the tight `img-src` (without `https:`), so every image
that loads only because of `https:` still files a report. The vendor portal
enforces its policy unchanged and ships no report-only header.

The organiser portal's events list paints dress-code swatches with
`background-color` instead of the `background` shorthand, so a stored colour
can no longer load an image.
