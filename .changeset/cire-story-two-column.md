---
"@cire/web": patch
---

Restyle the guest invite's "Our Story" section into a two-column editorial layout
(`InviteHeader.tsx`). On laptop/desktop (`md` and up) the story photo sits on the
LEFT and the eyebrow / heading / body block on the RIGHT, vertically centred with
a comfortable gap and left-aligned copy; the section grows to `max-w-[960px]` to
give the two columns room. On mobile (below `md`) the photo is `hidden md:block`,
so it is not even laid out — guests see only the full-width, centred text block.
When the wedding has no story image the grid collapses to a single full-width
centred column at every breakpoint (data-attribute-driven, so nothing leaves an
empty half). The existing `buildSrcSet` thumb/card variant usage, the `--invite-*`
theme vars, and the `Show when={showStory()}` emptiness gating are all unchanged.
