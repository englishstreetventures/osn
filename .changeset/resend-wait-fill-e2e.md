---
"@tools/e2e": patch
---

The Musubi surface checks (`musubi-surfaces.ts`: `at()` and `gapBetween`) wait out every animation that ends but two: a loading pulse, and the fill behind `CheckEmailView`'s "Resend in …s", which runs for the whole wait, so a flow on the "Check your email" screen never stalls for 30 or 120 seconds.
