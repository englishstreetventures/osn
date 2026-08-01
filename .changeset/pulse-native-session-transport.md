---
"@osn/client": minor
"@pulse/app": patch
---

N3 (pulse iOS) — the session cookie cannot survive a Tauri webview, so the
transport moves into Rust.

Pulse serves its document from `tauri://localhost`. A custom-scheme document is
cross-site to every real host, so WebKit refuses to *store* the session cookie —
measured on an iOS 26 simulator against `SameSite=Lax`, `SameSite=None` and no
attribute, checked on the page (`document.cookie` empty, no `Cookie` header on
the next request), on the wire, and in `WKHTTPCookieStore`, which came back
empty. That last one matters: it rules out the obvious workaround of injecting
the cookie from Swift, because the jar itself is unusable, not just the send
path.

osn-api reads the refresh token only from that cookie, so on iOS sign-in appears
to work and the session then dies with the first access token with no way back.

`@osn/client` gains one seam, `sessionFetch`, used by the five routes that
establish or consume the cookie (`/login/passkey/complete`, `/register/complete`,
`/login/recovery/complete`, `/token`, `/logout`). It is plain `fetch` everywhere
except iOS. Nothing else changes: the retry classification, the backoff and the
single-flight guards stay in `service.ts`, which is where they are tested — a
second copy behind a native implementation is how the two drift apart.

Pulse adds a `pulse-session` Tauri plugin that fills that seam on iOS. Rust holds
the policy and the Keychain-backed jar; Swift is pure transport over a
cookie-less `URLSession`. Because a JS-callable "send my credentials" command is
ambient authority, three things fence it in: the caller supplies a path and never
a URL, the path must match a five-entry allowlist exactly, and `Set-Cookie` never
crosses back into JS. The issuer origin comes from `tauri.conf.json` and a bad
one fails app startup rather than the first sign-in.

The allowlist is five routes rather than everything because osn-api already falls
back to the access token's `osn_sid` binding for a native client on every other
cookie-reading route.
