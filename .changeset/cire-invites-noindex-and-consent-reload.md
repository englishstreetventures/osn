---
"@cire/invites": patch
---

Keep the guest invite and gift pages out of search indexes with `X-Robots-Tag: noindex, nofollow` on every server-rendered response; the prerendered legal pages stay indexable. Switching third-party content off now reloads the page only when an embed whose code runs in the page itself (the Pinterest board) rendered, not when only the Google Maps iframe did.
