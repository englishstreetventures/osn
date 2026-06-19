---
---

Cire wedding-invite hero + theme-builder polish (all `@cire/*` — version-less):

- **Blurred hero backdrop (`@cire/web` + `@cire/api`)** — the uploaded hero image
  now renders as a soft, full-bleed blurred backdrop behind the hero title.
  `cire/api` gains a bounded `hero-bg` image variant whose blur radius is a
  server-side constant (`VARIANT_BLUR`, ~28 in Cloudflare-Images terms; only
  `hero-bg` is blurred — `hero`/`card`/`thumb` stay sharp), applied via the Images
  binding `.transform({ width, blur })`. `InviteHeader.tsx` points the hero
  backdrop `<img>` at the `hero-bg` variant and strengthens the title scrim a touch
  for readability over a brighter blurred photo. The variant allowlist stays
  bounded — blur/width are never client input.
- **"Invisible hero" fix (`@cire/web`)** — the hero `<img>` had an `onLoad`-only
  opacity gate with no failure path, so a failed image load left a permanently
  invisible 0-opacity image over the gradient. Replaced with a
  pending/loaded/error lifecycle: fades in on load, and on `onError` unmounts so
  the base gradient shows through; re-arms when the backdrop URL changes.
- **Live theme preview (`@cire/organiser`)** — the theme colour/font pickers
  previously showed no effect in the portal until saving + opening the guest URL.
  Added a compact, labelled mini-invite preview beside the controls, styled with
  the same `--invite-*` CSS variables the guest invite consumes and driven live by
  the picker signals, via a small local mirror of the guest mapping
  (`lib/invite-theme-preview.ts`) — no cross-package import, no Effect/web
  internals.
