---
"@osn/ui": minor
"@osn/social": patch
"@pulse/web": patch
---

Move `@osn/*` and `@pulse/web` off `solid-toast` and onto `@shared/toast`, and
drop the dependency from the workspace.

Call sites are unchanged — `toast.success(message)` / `toast.error(message)` —
but each app now maps its own design tokens onto the package's `--toast-*`
contract, so toasts are the surface of the app they appear in rather than the
library's white pill. `@osn/ui` drops its `solid-toast` peer dependency for a
workspace one, so consumers no longer have to supply the implementation
themselves.

Both apps alias the shadcn ramp (`--popover`, `--destructive`, `--border`,
`--ring`) and add a success green and a warning amber per ramp, since neither had
either token; every value clears 4.5:1 on its own ramp's `--popover`. Warning is a
real amber rather than the muted ink it started as — a lab bench showed `warning`
and `info` rendering identically, which leaned the whole distinction on the glyph
shape alone.

With this, `solid-toast` is gone from every `package.json` and from the lockfile.
