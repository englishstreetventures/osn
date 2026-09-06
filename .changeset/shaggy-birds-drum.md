---
"@osn/landing": patch
"@pulse/landing": patch
---

Take jsdom 30.0.1 (from 29.1.1). It is a test-only dependency — the environment the Astro landing sites' unit tests parse HTML in.

Note what the root `undici` override does to this bump: jsdom 30 declares `undici ^8.9.0`, and the override pins `^7.29.0`, so jsdom runs against an HTTP stack one major older than the one it was written for. That is a floor being used as a ceiling, and it is tracked separately — it is not a property of jsdom 30 and is not fixed here. Reachability is test-only: no deployed Worker or shipped bundle contains undici from this path.
