---
"@cire/api": patch
"@cire/web": patch
"@cire/organiser": patch
"@cire/theme": patch
---

Code-quality sweep (cire side).

- IB-S-L1 (#152): the CSS-colour allow-list (CSS-injection gate) now has a
  single source of truth in the new zero-dependency `@cire/theme` package;
  `@cire/api` (write-time validation) and `@cire/web` (render-time check)
  both import it, so the two sides can no longer drift.
- Organiser a11y: import-summary table gains an accessible header for the
  row-label column; sheet-picker tablist made programmatically focusable.
- Dead exports removed: `VARIANT_NAMES`, `isFontChoice` (@cire/api).
- `TurnstileWidget` script-load flow restructured to async/await (guest web).
- Retention sweep: documented-deliberate sequential fallback annotated for
  the linter instead of tripping `no-await-in-loop`.
