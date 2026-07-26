---
"@shared/observability": minor
"@osn/api": minor
"@osn/client": minor
"@osn/ui": minor
"@osn/social": minor
---

Wire recovery codes into the settings UI, and fix the generate call that could never succeed.

`generateRecoveryCodes` in `@osn/client` posted an empty body and no step-up token, so `POST /recovery/generate` answered 403 `step_up_required` every time. It now forwards the token, and `RecoveryCodesView` runs the passkey/OTP ceremony that mints it — the same `StepUpDialog` flow `PasskeysView` uses.

Binds the generate gate to a purpose (S-M1). `POST /recovery/generate` now requires a step-up token minted with `purpose: "recovery_generate"`, so a token from another ceremony — an email change, a passkey delete — cannot be replayed against the one action that destroys an account's whole existing set. `StepUpDialog` gained a `purpose` prop and `@osn/client` forwards it through both `/complete` routes; a purposeless token is refused, with no legacy fallback.

Adds `GET /recovery/status`, which reports how many codes an account has left and when the set was minted. It carries counts only, never a code, so it needs no step-up — gating it would be circular, since the answer is what tells a user whether starting a ceremony is worth it. The view leads with it, and says outright when an account has no codes at all.

`RecoveryCodesView` is now mounted in Settings → Security in `@osn/social` (it previously rendered nowhere).
