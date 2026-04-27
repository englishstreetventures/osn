---
"@osn/api": minor
"@osn/db": minor
"@pulse/api": minor
"@zap/api": minor
"@osn/client": minor
"@osn/ui": minor
"@osn/social": minor
"@pulse/app": minor
"@shared/observability": patch
---

Add `GET /account/export` (C-H1, GDPR Art. 15 + Art. 20, CCPA right-to-know).

Streaming NDJSON bundle — identity-domain sections from `osn/db` direct, plus
ARC fan-out into `pulse/api` (rsvps, events_hosted, close_friends, settings) and
`zap/api` (chat membership only — message ciphertext excluded by design, the
server has no key). Step-up gated (passkey or OTP), 1 export per 24 h per
account, 32 MB resident memory budget with truncation tombstones, and a
`dsar_requests` audit row written for every request.

UI surfaced on both `@osn/social` (Settings → Privacy & data) and `@pulse/app`
settings; both apps share the `<DataExportView />` component from `@osn/ui` and
the `createAccountExportClient` helper from `@osn/client`. Zap will get the same
affordance once it ships a client.
