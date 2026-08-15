---
"@cire/invites": patch
---

Import the `ImageCrop` type both invite pages already use.

The classic and gala `InvitePage.tsx` both name `ImageCrop` in the
`footer.imageCrop` field of `InviteCustomisationResponse` but never import it, so
neither file has type-checked since the type was introduced. Nothing failed at
runtime — Astro strips types at build — and `@cire/invites` ships no `check`
script, so neither the build nor CI ever looked.

Adds the missing `import type { ImageCrop } from "../../components/image-crop"`
to both. The module was already there, with tests.
