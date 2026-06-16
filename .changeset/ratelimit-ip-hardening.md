---
"@shared/rate-limit": minor
"@osn/api": patch
---

Harden client-IP resolution for rate limiting (S-M34).

`getClientIp` now accepts an optional `ClientIpOptions { trustedProxyCount?, trustCloudflare?, socketIp? }` and resolves the keying IP under an explicit trust policy that **fails closed**:

- `trustCloudflare` → trust `cf-connecting-ip` only (never falls back to `x-forwarded-for`); missing/invalid → unresolved.
- `trustedProxyCount > 0` → take the entry N-from-the-right of `x-forwarded-for` (spoofing-resistant); missing/short/malformed → unresolved.
- otherwise (direct/dev) → trust the transport socket peer (`socketIp`) only; absent/invalid → unresolved.

New exports: `UNRESOLVED_IP`, `isUnresolvedIp(ip)`, `isValidIp(value)`, and the `ClientIpOptions` type. The legacy no-options call form (`getClientIp(headers)`) is preserved and marked `@deprecated` — it keeps the old left-most-XFF / `"unknown"` behaviour so consumers can migrate incrementally; the hardened behaviour is opt-in via the options argument.

`@osn/api` adopts the hardened path at its auth + profile rate-limit call sites: the composition root reads `TRUSTED_PROXY_COUNT` (validated integer, default 0 = direct/socket-peer mode), wires Bun's `server.requestIP` as `socketIp`, and emits a startup warning when a non-local deploy leaves it unset. Requests whose IP is unresolved are denied (429) rather than sharing a single bucket. Session-IP persistence uses the same resolved IP.
