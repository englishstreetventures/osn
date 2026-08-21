---
"@cire/invites": patch
---

Fix the flash after a guest submits their claim code. The unlock reveal wrote the events section's inline `opacity: 1` before starting its entrance animation, so the browser painted one full-brightness frame of the whole invite that the animation then dropped back to zero — the events blinked in, vanished, and faded in again. Event cards had it worse: nothing hid them, so the stagger's start delay left them at full opacity until Motion committed its first frame. Both are now hidden before the section can paint and only settle on their inline end state once the animation has finished.

The reveal also no longer runs ahead of the cards. They come from a lazy-loaded component, so on a cold cache — a guest opening their invite for the first time on a phone — the chunk was often still in flight when the claim resolved, and the choreography animated an empty section while the cards slammed into the layout unanimated a moment later. The events step now waits for them, under the form's fade-out and with its own cap, so a slow chunk costs nothing and a chunk that never arrives still reveals the invite.
