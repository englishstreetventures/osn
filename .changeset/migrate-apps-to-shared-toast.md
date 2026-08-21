---
"@osn/ui": minor
"@osn/social": patch
"@pulse/web": patch
---

Move every app off `solid-toast` and onto `@shared/toast`.

Call sites are unchanged — `toast.success(message)` / `toast.error(message)` — but each
app now maps its own design tokens onto the package's `--toast-*` contract, so toasts are
the surface of the app they appear in rather than the library's white pill. `@osn/ui`
drops its `solid-toast` peer dependency for a workspace one, so consumers no longer have
to supply the implementation themselves.

`osn/social` and `pulse/web` alias the shadcn ramp (`--popover`, `--destructive`,
`--border`, `--ring`) and add a success green per ramp, since neither had a success token;
both values clear 4.5:1 on their own ramp's popover.
