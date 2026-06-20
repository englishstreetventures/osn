---
"@cire/web": patch
---

Re-enable the Pinterest moodboard embed on mobile. The desktop-only capability
split in `PinterestBoard.tsx` (a `matchMedia` touch check that showed a
no-embed link-out card and never loaded the widget on phones/tablets) is
removed — every device now gets the same consent gate → embed → always-visible
fallback link. The split was added because the widget "repeatedly failed on
mobile", but the dominant cause was unembeddable `pin.it` short links stored
verbatim, now fixed (import-time resolution incl. the api.pinterest.com hop +
a prod backfill). The success-detection observer + connection-scaled cutoff
make the embed self-healing on slow mobile and the fallback link is the safety
net. Removes the dead touch-detection + `setPinterestTouchForTest` test helper;
adds a matchMedia-mocked-touch regression suite proving the embed renders on a
coarse-pointer device. Consent gate (ePrivacy opt-in) unchanged on every
device.
