---
"@cire/api": minor
"@cire/db": minor
---

Cire claim-code & guest-session hardening (W5).

- **Tiered claim codes (C1).** Family `public_id` is now `SURNAME-WORD-HASH`:
  uppercased surname (readability only), a uniformly-random EFF-short-wordlist
  word (~10.3 bits, bundled as a frozen data module), and a Crockford base32
  hash (no I/L/O/U, case-insensitive). A new `weddings.code_style` column
  (`simple` 6-char ~40-bit | `secure` 10-char ~60-bit, **default `secure`**)
  drives the generator (`cire/api/src/services/family-code.ts`), replacing the
  old `mintFamilyPublicId`. Migration `0010_wedding_code_style.sql` adds the
  column (back-fills `secure`); an idempotent, tenant-scoped operator function
  (`scripts/remint-family-codes.ts`) re-mints the live wedding's legacy codes.
- **Regenerate-code endpoint (C2).** `POST /api/organiser/weddings/:weddingId/
  families/:familyId/regenerate-code` — owner-gated, verifies family ∈ wedding,
  and atomically (one D1 batch) rotates the code AND revokes the family's
  sessions (wires `sessionService.revokeAllForFamily`).
- **Native Workers rate limiting (C1/C4).** `WorkersRateLimiterBackend` over the
  `CLAIM_RATE_LIMITER` binding (fail-closed on throw); wired for claim,
  account-link, and invite limiters (closes AL-S-L1). In-memory fallback in
  dev/test.
- **Fail-closed IP keying (C4).** Cire's `getClientIp` now delegates to the
  hardened `@shared/rate-limit` helper with `trustCloudflare: true` — keys
  strictly on `cf-connecting-ip`, denies (429) when absent/malformed instead of
  bucketing on a spoofable fallback.
- **CSRF origin guard (C5 / S-L3).** Origin validation on every state-changing
  method (POST/PUT/PATCH/DELETE) against the `WEB_ORIGIN` allowlist; 403 on
  missing/mismatch with a bounded rejection metric.
- **Session rotation on link (C6).** A successful `POST /api/account/link` now
  rotates the guest session (mint new + revoke old in one batch, fresh
  Set-Cookie) — session-fixation defence.
