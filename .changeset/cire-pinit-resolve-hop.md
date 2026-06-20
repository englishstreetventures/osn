---
"@cire/api": patch
---

Fix `pin.it` Pinterest board resolution failing on every short link. Pinterest
changed `pin.it` to redirect through its first-party URL shortener
(`pin.it/<id>` → 308 `api.pinterest.com/url_shortener/<id>/redirect/` → 302
`www.pinterest.<tld>/<user>/<board>/`), but `resolvePinUrl`'s redirect-follow
allowlist was `pin.it`-only, so the chain was abandoned at the middle hop and
the short link fell back unresolved — guests only ever saw the fallback link,
never the embedded board. Broadened the SSRF-safe redirect-follow allowlist to
include `api.pinterest.com` + the Pinterest board hosts (still a strict
first-party allowlist; off-allowlist redirects still stop the chain). Adds a
regression test for the real two-hop chain.
