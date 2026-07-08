---
"@osn/api": minor
"@pulse/api": minor
"@zap/api": minor
"@shared/observability": minor
---

C-H1 — account data export (`GET /account/export`, DSAR Art. 15 / 20 + CCPA).

Self-service, step-up gated (new `account_export` step-up purpose), rate-limited
to 1 export / 24 h / account. Streams the locked NDJSON bundle
(`{"version":1,...}` header → `{"section","record"}` lines → `{"end":true}`
terminator) via a `ReadableStream`, so the response never materialises the full
dataset. osn's own sections (account, profiles, passkeys, sessions,
security_events, recovery_codes counts, email_changes, connections, blocks,
organisations) are read with keyset pagination (`LIMIT 500 WHERE id > :cursor`,
no OFFSET). The internal `accountId` is never emitted (P6 invariant).

The `pulse.*` / `zap.*` sections are fetched over ARC (new `account:export`
scope, registered downstream alongside `account:erase`) from a new
`POST /internal/account-export` on each app and streamed through the outer
envelope line-by-line; a failing bridge degrades to a `{"degraded":...}` line
rather than breaking the stream. Pulse returns rsvps / events-hosted /
close-friends; Zap returns chat memberships only (message ciphertext excluded).

Also builds Zap's inbound-ARC infrastructure from scratch (it previously had
none): `zap/api` gains an `arc-middleware` (`requireArc` + key registry +
`register-service` bootstrap) mirroring Pulse's, closing the latent gap where
osn's cross-service fan-out targeted a Zap `/internal` surface that did not
exist.

`@shared/observability` adds the `account_export` value to the `StepUpPurpose`
metric-attribute union.
