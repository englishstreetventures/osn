---
"@osn/landing": patch
"@pulse/landing": patch
---

Take motion 13.1.1 (from 12.43.0). The bundled `framer-motion` alias moves to 13.1.1 with it. The four landing and invite surfaces use only `animate`, `stagger` and `inView`, none of which changed signature. Verified through the real-Chromium browser tier rather than the mocked unit tests — see the accompanying `@cire/*` changeset for why that distinction matters here.
