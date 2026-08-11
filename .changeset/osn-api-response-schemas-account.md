---
"@osn/api": patch
---

Declare response schemas for the passkey, step-up, recovery, cross-device, email-change and security-event routes.

Twenty-one operations now carry a `response` map and an `operationId`, so the generated OpenAPI document describes what each one actually returns instead of an untyped body. Every schema is taken from the service's real return type, because Elysia deletes any key a response schema omits — an incomplete schema is silent data loss, not a documentation gap.

Two details worth naming:

- The WebAuthn registration options declare `extensions`, which `@simplewebauthn/server` fills with `credProps` unconditionally. Omitting it would have stripped the extension and broken enrolment in the browser.
- `POST /login/cross-device/:requestId/status` is a union of four shapes discriminated by `status`, only one of which carries a session.

Enum-ish WebAuthn members stay plain strings: those vocabularies grow, and an unrecognised value would fail response validation and take down the ceremony.

New tests pin the full key set of the registration options, the passkey list and the security-event list, so a future schema edit that drops a field fails a test rather than a client.
