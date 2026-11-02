---
"@cire/host": patch
"@cire/invites": patch
"@tools/e2e": patch
---

Move `playwright` from 1.62.1 to 1.64.1 in `@cire/host` and `@cire/invites`,
and `@playwright/test` from 1.62.1 to 1.64.1 in `@tools/e2e`. The browser-test
tier and the E2E suite both drive Chromium 156.0.8078.4 (revision 1248).

Chromium 156 serialises a one-value `background-size` with its implied `auto`
height, so the `InviteClosing` crop-layer browser test accepts `200%` or
`200% auto`, and still fails on a second length.

The `InviteHeader` scroll-cue browser tests scroll only after the resize has
landed and two frames have drawn the mounted hero. Scrolled straight after the
mount, the page moved with no `scroll` event, and the gala first-scroll test
failed in most full runs of the tier on Chromium 156.
