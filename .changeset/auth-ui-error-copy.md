---
"@osn/auth-ui": minor
"@osn/client": minor
"@musubi/social": minor
"@shared/design-tokens": minor
---

Errors read as plain sentences, in the place they are about.

- `@osn/auth-ui`: every view shows a sentence from `describeAuthError` or `describePasskeyError`, never an error's own text, in an inline danger `Notice` with `role="alert"` — under the field it is about (tied by `aria-describedby`, `aria-invalid` only when the input was refused) or above the action it follows. No error toasts. `SignIn`'s passkey error carries "Lost your passkey?"; `Register`'s age hint reads "You must be 13 or older to create an account."; `TurnstileWidget` says "Reload and try again". A failed passkey, authenticator or session list says it didn't load, with Try again, instead of throwing. Every call that spends a Turnstile token asks for a fresh one when it is refused. `Register` drops a spent token with its widget instead of running a challenge nobody uses, and its code step mounts a widget of its own for "Resend code" once the countdown ends. `ChangeEmailForm` and `StepUpDialog` group each field under a `Label`, and their raw inputs turn red when refused. `InlineAction` draws Button's focus ring. `SecurityEventsBanner`'s error line sits above its box, on the page.
- `@osn/client`: `useAuth()` gains `profilesError` and `refetchProfiles`. A profile list that fails keeps the last list instead of throwing on read; one that settles after the session ended or a log out is dropped. Adopting a first session lists the profiles once, not twice; adopting one over another drops the old account's list first. The provider treats a session that failed to load as none, so reading it throws nowhere inside the provider.
- `@musubi/social`: the shell says "You've been signed out." with Sign in when the session ends, and "Your profiles didn't load." with Try again when the list fails. A page that throws while rendering shows "This page didn't load." with Try again inside the shell instead of blanking the app. `/authorize` reads its failures from the copy map. Every failed-load and error line, on `/authorize`, Connected apps and an organisation's page included, is a danger `Notice`. The sign-in and create-account dialogs open from one store.
- `@shared/design-tokens`: `checkContractConformance` takes an optional `pairs` list to measure in place of the contract's own.
