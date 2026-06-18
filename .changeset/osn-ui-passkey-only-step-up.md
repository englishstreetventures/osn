---
"@osn/ui": minor
---

`<PasskeysView>` / `<StepUpDialog>`: add a `passkeyOnly` mode and new-device help.

- `<StepUpDialog>` gains a `passkeyOnly` prop. When set, the OTP ("email me a
  code") factor is suppressed entirely and the passkey ceremony auto-starts on
  mount, with a retry affordance on failure. This is for hosts where
  transactional email is degraded (e.g. an osn-api running with
  `OSN_EMAIL_OPTIONAL=true`) so the user is never offered a code that will never
  arrive. Every passkey-management gate accepts a passkey step-up, so the flow
  stays fully functional without email.
- `<PasskeysView>` forwards `passkeyOnly` to its step-up dialog and now renders a
  collapsible **"Signing in somewhere new?"** help disclosure that explains the
  three real ways onto a device with no passkey yet (backed-up/synced passkey,
  password-manager cross-device QR, recovery code) — surfacing the existing
  cross-device path without building a new system.

No server changes; the add/rename/delete passkey endpoints already accept a
passkey step-up token.
