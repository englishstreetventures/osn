---
"@osn/social": patch
---

Stop shipping the WebAuthn registration ceremony to every visitor.

`src/lib/webauthn.ts` held both the assertion (sign-in / step-up) and
attestation (passkey enrolment) ceremony runners in one module, and
`@simplewebauthn/browser`'s single-entry barrel meant Rollup grouped its
`startAuthentication` and `startRegistration` bodies into one vendor chunk
regardless of source-level organisation. That chunk reached the entry bundle
through the always-mounted security-events banner, so every visitor paid the
parse cost of the enrolment flow even though it only runs from the
rarely-opened Security settings tab.

The runners now live in separate modules, `webauthn-ceremony.ts` (assertion)
and `webauthn-registration.ts` (attestation), and `vite.config.ts` marks the
`@simplewebauthn/browser` barrel side-effect-free and manually chunks its two
method files apart so the source-level split survives bundling. The banner's
chunk now pulls in only the assertion code; the registration code lands in
its own chunk reached solely through the Security tab's existing lazy
import, and no longer appears in any chunk the entry bundle loads eagerly.
