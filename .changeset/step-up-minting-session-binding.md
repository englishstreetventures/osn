---
"@osn/api": patch
"@shared/observability": patch
"@pulse/api": patch
---

A step-up token is now bound to the session that minted it. `POST /step-up/passkey/complete`, `POST /step-up/email/:requestId/status` and `POST /step-up/totp/complete` stamp the family of the caller's live session into the token as `osn_fam`, and every gate that spends a token, `POST /internal/step-up/verify` included, refuses one whose family has no live, unrestricted, unexpired session of the account left, or that carries no `osn_fam`, before it claims the token's single-use id. A token minted on a device that has since signed out, been revoked or been swept is refused at every gate, whoever presents it, another live session of the account and Pulse included; a renewal keeps the family, so the minting session's silent refresh does not end it. The refusal counts as `osn.auth.step_up.verified{result="session_ended"}`, a new label on `StepUpVerifyResult`.

`POST /internal/step-up/verify` takes a required `profile_id`, the profile the calling service verified its own caller as, and refuses a token that is not of the account owning it; it spends `pulse_app_delete` only for `pulse-api` and `zap_app_delete` only for `zap-api`, and accepts no `account_delete`. Pulse's `DELETE /account` sends its caller's profile id. `issueStepUpToken`, `completeStepUpPasskey`, `completeStepUpTotp` and `stepUpEmailStatus` take a `MintingSession` (`{ accountId, familyId }`) in place of the account id; `verifyStepUpForExternalPurpose` takes the profile id; `verifyStepUpToken` always takes the expected account; and every step-up verifier now needs `Db` and can fail with `DatabaseError`, which `DELETE /account`, `GET /account/export` and `POST /internal/step-up/verify` answer as a 500.
