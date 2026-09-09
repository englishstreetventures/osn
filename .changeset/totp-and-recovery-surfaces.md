---
"@osn/ui": minor
"@musubi/social": minor
---

Screens for the authenticator app and the two new ways back into an account.

`<TotpView>` is a new Settings → Security surface: it enrols an authenticator
app behind a step-up, shows the `otpauth://` URI as a QR code beside the base32
key as selectable text, and removes the credential behind a second step-up. The
key is the QR's text alternative, so it is real text rather than part of the
picture, and the secret is never rendered again once enrolment completes.

`<StepUpDialog>` gains that authenticator as a third factor, and now decides
which factors to offer from the ceremony rather than offering all of them. That
also closes an existing dead end: it used to offer "Email me a code" for passkey
rename and delete, whose gate accepts a passkey alone, so the code arrived and
the action still failed. `passkeyOnly` keeps its name and now means "this host
cannot deliver mail" — it suppresses the emailed code only, because an
authenticator code has no delivery to fail.

`<RecoveryLoginForm>` gains an emailed code and an authenticator code beside the
recovery code it already had. Both mint a restricted recovery session whose only
permitted action is enrolling a passkey, so both route straight into enrolment,
say plainly what the session is, and give a timed-out session its own screen
instead of a bare error. Neither is offered where a WebAuthn ceremony cannot
run, since there the session could do nothing at all.

The QR code is generated in-repo (`@osn/ui/ui/qr-code`) rather than by a new
dependency.
