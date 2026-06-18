---
"@cire/organiser": minor
---

Organiser portal: a **Security** section for managing devices / passkeys.

Signed-in organisers can now reach a top-level "Security" nav item (`#security`)
that renders the shared `@osn/ui` `<PasskeysView>`: list passkeys, rename, remove
(the last-passkey removal is refused server-side), and **Add passkey** to enrol a
new device. It also explains how to get onto a brand-new device (synced passkey,
password-manager cross-device QR, or recovery code).

Step-up for the sensitive actions runs the **passkey** ceremony, never OTP —
`passkeyOnly` is forced on because cire's osn-api runs with
`OSN_EMAIL_OPTIONAL=true` (Cloudflare email degraded), so an emailed code would
never arrive. The WebAuthn ceremonies are wired with `@simplewebauthn/browser`;
`accessToken` + `activeProfileId` come from the existing `useAuth()` context.
