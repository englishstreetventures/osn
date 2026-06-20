---
"@cire/web": patch
---

Docs-only: archive completed cire wiki TODO items out of the open-work shards.
Moved the done `- [x]` feature items from `wiki/todo/web.md` into
`wiki/changelog/completed-features.md` and the closed security findings from
`wiki/todo/security.md` into `wiki/changelog/security-fixes.md`, verbatim
(branch refs, finding IDs, `[[wiki links]]`, and rationale preserved — a
relocation, not a summary). The shards now lead with their open items; the 3
most recent done items are kept inline in `web.md` for context. Also recorded
one new open item in `web.md`: the Pinterest moodboard live-DevTools deep-dive
follow-up. No code change.
