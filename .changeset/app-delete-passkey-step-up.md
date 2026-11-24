---
"@osn/api": minor
"@osn/client": minor
"@osn/auth-ui": patch
"@musubi/social": patch
"@shared/observability": patch
"@tools/lab": patch
---

Removing an app's data takes a passkey. `pulse_app_delete` and `zap_app_delete` at `/internal/step-up/verify`, and `cire_app_delete` at `POST /step-up/requests/:id/confirm`, now admit a passkey step-up alone (`appDeleteAllowedAmr`, fixed in `context.ts`), and a passkey added by an emailed link, an authenticator code or recovery only once it is 72 hours old. The confirm route answers a passkey inside that hold `403 { error: "passkey_held", hold_ends_at }`; `createAppStepUpClient().confirm` resolves it as `{ status: "held", holdEndsAt }`.

`StepUpDialog` offers the passkey alone for the three purposes. Musubi's confirm page always tells a person with no such passkey to add one in Settings and start again from the app in 3 days, and names the day and time a held passkey's hold ends.

Every passkey enrolled from a restricted recovery session is stamped `recovery`, and so is an account's first passkey enrolled within 72 hours of any recovery, so it waits out the same hold; a first passkey from sign-up stays `webauthn`.

`osn.auth.step_up.verified` gains a bounded `purpose` attribute, and `osn.auth.recovery.cooldown` an `app_delete_refused` outcome.

The lab's `osn/auth-ui/StepUpDialog/AppDataRemoval` story shows the sheet for removing an app's data, and the playground offers `cire_app_delete`.
