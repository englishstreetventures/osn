---
"@osn/auth-ui": minor
"@osn/client": minor
"@musubi/social": minor
---

Errors read as plain sentences, in the place they are about.

- `@osn/auth-ui`: every view shows a sentence from `describeAuthError` or `describePasskeyError`, never an error's own text, in an inline danger `Notice` with `role="alert"` — under the field it is about (tied by `aria-describedby`, `aria-invalid` only when the input was refused) or above the action it follows. No error toasts. `SignIn`'s passkey error carries "Lost your passkey?"; `Register`'s age hint reads "You must be 13 or older to create an account."; `TurnstileWidget` says "Reload and try again". A failed passkey, authenticator or session list says it didn't load, with Try again, instead of throwing. Every call that spends a Turnstile token resets the widget, accepted or refused, and `Register`'s code step has its own widget for "Resend code".
- `@osn/client`: `useAuth()` gains `profilesError` and `refetchProfiles`. A profile list that fails keeps the last list instead of throwing on read; one that settles after the session ended or a log out is dropped. Adopting a first session lists the profiles once, not twice.
- `@musubi/social`: the shell says "You've been signed out." with Sign in when the session ends, and "Your profiles didn't load." with Try again when the list fails. A page that throws while rendering shows "This page didn't load." with Try again inside the shell instead of blanking the app. `/authorize` reads its failures from the copy map. The sign-in and create-account dialogs open from one store.
