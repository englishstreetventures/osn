---
"@cire/landing": patch
---

The landing site's stylesheet skips `@shared/ui`'s `Button`, which no page on it draws, so its built CSS carries none of `Button`'s classes: 1,354 bytes less, 173 gzipped across `dist/_astro`. No class a built page uses is dropped.
