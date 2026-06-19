---
---

Fix the Pinterest moodboard embed rendering on desktop but not on mobile in the
cire guest invite. The board was being falsely hidden by a fixed 2.5s timeout
that raced Pinterest's `pinit_main.js` transform — on mobile (slower script-eval,
render, and network) the transform routinely finished after 2.5s, so a board
that would have rendered was marked failed and replaced by the bare fallback
link. Success is now detected via a `MutationObserver` on the embed container
(anchor losing `data-pin-do` / being swapped out, or an iframe / `data-pin-internal`
node appearing), which cancels the pending failure timer the instant the embed
renders. The failure cutoff is retained for genuine blocks but made generous and
connection-scaled (8s default, 6s on a reported-fast non-data-saver link). The
opt-in consent gate, always-visible fallback link, page-wide shared consent,
`referrerpolicy=no-referrer`, cache-busted script URL, fast `script.onerror`
fallback, and the overflow-scroll layout are all preserved.
