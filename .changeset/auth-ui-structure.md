---
"@osn/auth-ui": major
"@musubi/social": minor
"@tools/lab": patch
---

Every `@osn/auth-ui` view now paints with the `ui-*` contract alone, so it renders the same in any app that maps the contract: colours, type steps, weights up to 500 and radii, held by a new `token-contract.test.ts`. Breaking: `ProfileSwitcher` and its export are gone (no app used it; Musubi has its own switcher), `SignIn` and `Register` take a required `host` (`"dialog"` or `"page"`) and an optional `cancelLabel`, and `PasskeysView`, `TotpView` and `RecoveryCodesView` no longer take `passkeyOnly`.

- `SignIn` and `Register` head themselves with `AuthHeader`, so a dialog is named by the view's title ("Sign in to Musubi", "Create your Musubi account"); on a page they draw no frame and no side padding.
- Settings rows are nested `Card`s (8px corners, 16px inside), with the dates on two lines and the actions under the words below `md`, 40px tall; each action is named by its item ("Remove Work laptop"). Each list's placeholder is as tall as the row that replaces it at every width.
- Removing a passkey or the authenticator app asks in the step-up sheet, titled "Remove {name}?" with its warning, instead of the browser's `confirm()`.
- "Generate a new set?" and "Create a new profile" open as bottom sheets on phones, dismissed by a `secondary` Cancel. The codes sit in a muted well, and "I've saved these codes" is the drawn checkbox in a 44px row.
- A failed recovery-code status read shows the failed-load line with Try again, and still asks before a rotation; an account with no codes gets a warn notice instead of red text. Blockers (no WebAuthn) are info notices.
- One set of words for each action: "Add a passkey", "Remove", "Sign out" for one session, "Email me a link" in the step-up sheet, "Use your authenticator app", "Email or @handle", "Waiting for your passkey…". The glossary is `osn/auth-ui/DESIGN.md` §10.

Musubi: the sign-in and create-account dialogs are named by their views. `/authorize` drops the frame around the sign-in panel, sets the app's name at the display step over the panel's 14px heading, and calls the create-account view's Cancel "Sign in instead"; its loading placeholder takes the new shape. Settings → Security's "Recovery codes" heading is at the title step. The lab gets stories for `SignIn` and `Register` in both hosts and for each Settings panel.
