---
"@osn/ui": patch
"@osn/social": patch
---

Restore passkey enrollment during registration, and stop the create-account
dialog reappearing after sign-out.

`Register` used to adopt the new session the moment the OTP was accepted, one
step before the passkey ceremony. Adopting publishes a signed-in user to the
whole app, and `@osn/social` acts on that: `AuthDialogs` renders each dialog
with `open={props.showRegister && !session()}`, so the session arriving
unmounted the registration dialog mid-flow. The passkey step never appeared and
accounts were created with zero WebAuthn credentials — the exact thing the
"every account has at least one passkey" invariant exists to prevent.

The session is now parked in a local signal and adopted only after
`passkeyRegisterComplete` succeeds. Nothing in the flow needed a published
session anyway: enrollment authenticates with the access token returned by
`/register/complete`, passed explicitly. A cancelled or failed ceremony now
leaves the user signed out on the passkey step, able to try again, rather than
signed in to a half-made account.

Second fix, same area: a controlled `Dialog` never fires `onOpenChange` when its
`open` prop flips on its own, so the `!session()` guard hid the sheet without
ever clearing the shell's `showRegister` flag. Left set, that flag re-opened the
create-account modal the next time the session went away — sign out, and there
it was. `AuthDialogs` now clears both flags from `Register`'s `onSuccess` and
from an effect on any arriving session, whatever its source (this flow, another
tab, a cookie bootstrap).
