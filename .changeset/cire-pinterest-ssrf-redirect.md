---
"@cire/api": patch
---

Harden the `pin.it` resolver against an SSRF allowlist-bypass on redirect.

The import-time `resolvePinUrl` loop checked the SSRF allowlist only on the
INITIAL url. Once a `pin.it` short link issued a 3xx, the loop assigned the
redirect target to `current` and re-fetched it on the next iteration WITHOUT
re-validating the host — so a first-party `pin.it` link that redirected
off-allowlist (to a private IP, cloud-metadata endpoint, or attacker host)
would be fetched by the Worker.

Fix: re-validate every hop. After resolving a redirect's `Location`, we first
try to canonicalise it (a real pinterest board ends the chain successfully);
otherwise we only continue following while the next URL is STILL an `https://`
`pin.it` / `www.pin.it` host. The moment the chain leaves the allowlist and
isn't a board, we stop and fall back to the original url — the off-allowlist
host is never fetched. The initial guard now also requires `https:` (plain-http
`pin.it` inputs pass through without a fetch). Added tests asserting
off-allowlist and private/metadata redirect targets are never fetched.
