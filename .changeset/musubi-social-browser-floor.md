---
"@musubi/social": patch
---

Add a test that fails when the repo's declared browser floor (the new root
`.browserslistrc`: Chrome and Edge 111, Firefox 114, Safari 16.4) stops matching
the target this app's Vite build compiles to. Test-only; the build output is
unchanged.
