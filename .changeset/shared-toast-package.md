---
"@shared/toast": minor
---

Add `@shared/toast` — an internal SolidJS toast package, replacing `solid-toast`.

The API the apps use is unchanged (`toast.success(message)` / `toast.error(message)`),
with an options object added: `duration`, `id`, `dismissible`, a per-toast `action`, and
`politeness`. `toast.promise`, `toast.loading`, `toast.info`, `toast.warning`,
`toast.dismiss` and `toast.remove` round out the surface.

Three things the replaced library could not do:

- **The container sets no `z-index`.** `solid-toast` spread a hardcoded `z-index: 9999`
  onto the container's inline style, which silently beat any class a caller passed and
  parked toasts above the cire consent banner. The layer is now the consumer's, via
  `class`.
- **Styling without `!important`.** Colours come from `--toast-*` custom properties an
  app maps onto its own tokens once, so overriding no longer means out-shouting inline
  defaults.
- **The container is portalled to `<body>`**, so an ancestor's `transform` can no longer
  make itself the containing block for the fixed container and trap the toast below
  page-level overlays.

Tone is carried by a differently-shaped glyph plus an `sr-only` word rather than by hue
alone; errors announce `assertive`, everything else `polite`.
