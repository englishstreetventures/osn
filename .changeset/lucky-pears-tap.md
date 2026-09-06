---
"@cire/invites": patch
"@cire/landing": patch
---

Take motion 13.1.1 (from 12.43.0), and the bundled `framer-motion` alias with it.

A motion major is the exact shape of the 2026-07-22 invite-reveal bug, where v10 → v12 drift left `UnlockReveal` stuck at `opacity: 0` and guests saw no events after claiming. That regression was invisible to the unit tests because they all stub the module. It is not invisible now: `tests/designs/InvitePage.browser.test.tsx` drives both `UnlockReveal` packs with the **real** library in real Chromium and asserts the post-animation end state, and it passes on 13.1.1. The SSR stub that keeps motion out of the Worker bundle still holds — the server output contains no `motion-dom` or `framer-motion`.
