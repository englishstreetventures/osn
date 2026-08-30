# @shared/toast

## 0.1.1

### Patch Changes

- 70ac0f3: Drop the unused `@testing-library/jest-dom` devDependency from every package that declared it but imports no matcher, now that `vite-plugin-solid` no longer injects its setup file. Guard the suppression markers in CI, and list the marker file under turbo's `globalDependencies` so an edit to it can no longer be served from cache.

## 0.1.0

### Minor Changes

- 3ce5044: Add `@shared/toast` — an internal SolidJS toast package, to replace `solid-toast`
  (unmaintained since 2023). No consumer changes yet; the migrations follow.

  The API is what the apps already call — `toast.success(message)` /
  `toast.error(message)` — plus the options object they had no way to reach:
  `duration`, `id`, `dismissible`, a per-toast `action`, `politeness`. With
  `toast.promise`, `loading`, `info`, `warning`, `dismiss` and `remove`.

  Three things the library it replaces could not do:

  - **The container sets no `z-index`.** `solid-toast` spread a hardcoded
    `z-index: 9999` onto the container's inline style, which beat any class a caller
    passed. The layer is the consumer's, via `class`.
  - **Theming without `!important`.** Colours come from `--toast-*` custom
    properties an app maps onto its own tokens once, so overriding no longer means
    out-shouting inline defaults.
  - **The container is portalled to `<body>`**, so an ancestor's `transform` cannot
    make itself the containing block for the fixed container and trap the toast
    below page-level overlays.

  Tone is carried by a differently-shaped glyph plus an `sr-only` word rather than
  by hue alone; errors announce `assertive`, everything else `polite`. The store
  owns the auto-dismiss clock and the queue is capped, so a toast that never renders
  still expires and a runaway raise cannot grow the queue without bound.
