---
"@osn/api": patch
---

Dev auth ergonomics for the multi-frontend monorepo:

- `OSN_ORIGIN` now accepts a comma-separated list of accepted WebAuthn origins
  (parsed in `index.ts`; `AuthConfig.origin` widened to `string | string[]` and
  passed straight to `@simplewebauthn`'s `expectedOrigin`). Lets pulse (1420),
  social (1422), cire organiser (4322) and the SDK example (5173) all run passkey
  ceremonies against one OSN API. Backward compatible — a single origin still
  works.
- Local-only OTP visibility: registration / step-up / email-change now emit a
  debug log of the OTP code, gated strictly on a local environment (`OSN_ENV`
  unset or `"local"`). Never logs in staging/production. Makes email-OTP dev
  flows testable without a real inbox (the `LogEmailLive` transport records the
  body but deliberately never logs the code).
