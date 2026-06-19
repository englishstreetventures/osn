---
---

Cire wedding-invite hero: fix the backdrop image being permanently invisible on
the SSR guest site, and add two per-wedding organiser-configurable hero options.

- **Visibility fix (`@cire/web`)** — the server-rendered hero `<img>` started at
  `opacity:0` and revealed only via `onLoad`, but on the SSR guest site the
  browser's `load` event commonly fired before the Solid island hydrated, so the
  reveal never ran; a re-arm effect also reset the image to hidden on the
  same-url on-mount revalidation, which never re-fired `load`. `InviteHeader.tsx`
  now reveals an already-`complete` image on mount (ref + `naturalWidth` check)
  and re-arms only when the resolved backdrop `src` actually changes. A real
  load failure still falls back to the gradient via `onError`.
- **Hero image style (`blurred` | `regular`)** — organiser choice between the
  soft `hero-bg` backdrop (default, today's look) and the sharp full-bleed `hero`
  variant.
- **Hero title backdrop (`none` | `solid`)** — organiser choice between just the
  radial scrim (default) and a translucent legibility panel behind the title
  block for busy/sharp photos. (Auto contrast-check deferred — see wiki future.)
- **`@cire/db`** — two NOT-NULL-defaulted columns (`hero_image_style`,
  `hero_title_backdrop`) on `wedding_invite_customisations` + forward-only
  migration `0017_hero_display_options.sql` (no backfill).
- **`@cire/api`** — both fields threaded through `inviteService` reads + the
  `PUT /invite/theme` save and the route schema, surfaced as a `heroDisplay`
  object; unknown values rejected with 400.
- **`@cire/organiser`** — Blurred/Regular and None/Solid toggles in
  `InviteBuilder.tsx`, saved with the existing theme save.

All `@cire/*` packages are version-less (changeset-ignored), so this carries no
version bump.
