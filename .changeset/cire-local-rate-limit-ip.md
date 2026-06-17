---
"@cire/api": patch
---

Fix local dev 429s on every rate-limited route (preview-code, claim, account-link,
invite writes).

The `Bun.serve` local entry (`src/local.ts`) has no Cloudflare edge in front of
it, so requests arrive without a `cf-connecting-ip` header. After the W5
fail-closed IP-keying hardening, `rateLimitMiddleware` treats an unresolved IP as
`UNRESOLVED_IP` and returns 429 before the counter is consulted — so every gated
route 429'd on the first request locally.

The local entry now injects the socket peer (`server.requestIP(...)`, falling back
to `127.0.0.1`) as `cf-connecting-ip` so per-IP limiting resolves a real key.
Production (`src/index.ts`, behind Cloudflare) is unaffected and keeps the
fail-closed posture — Cloudflare sets the real header at the edge.

Also corrects the stale `cire/CLAUDE.md` note that called the local dev server
`wrangler dev` (it's the `Bun.serve` entry; wrangler is `dev:wrangler`).
