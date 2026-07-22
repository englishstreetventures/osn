---
"@cire/web": patch
---

Fix guests seeing no events after a successful claim: the unlock reveal was written for Motion One (v10) but runs on motion v12, which ignores the removed `easing` option and reverts elements to base styles when a keyframe animation finishes — leaving the events section at its `opacity-0` base forever. Reveal steps now persist their end state as inline styles, use the v12 `ease`/`startDelay` option names, and are guarded so a throwing or stalled animation (or a failed motion-chunk import) can never hide the invite. Also escapes the code input's `pattern` hyphen (Chrome v-flag rejected the pattern) and bakes `PUBLIC_OSN_ISSUER_URL` into the guest-site deploy build so the Pulse account-link island stops dialling localhost in production.
