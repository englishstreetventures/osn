# Design — @osn/auth-ui

The design rules for `@osn/auth-ui`, the sign-in, registration, step-up and
account-security views of OSN. Read this file before changing how any of
these views looks. Rules are written in the `ui-*` contract of
`@shared/design-tokens`, never in one host's utilities, because the package
belongs to OSN-the-system and not to any one app
([osn-and-musubi](../../wiki/shared/osn-and-musubi.md)).

Each section gives the rule, then what the code does today where the two
differ, with the issue that brings the code to the rule.

## 1. Scope and hosts

**What the package exports.** One subpath per view in `package.json`
(`ChangeEmailForm`, `CheckEmailView`, `ConfirmLinkPage`, `CreateProfileForm`, `PasskeysView`, `ProfileOnboarding`,
`ProfileSwitcher`, `RecoveryCodesView`, `Register`, `SecurityEventsBanner`,
`SessionsView`, `SignIn`, `StepUpDialog`, `TotpView`) and a barrel,
`src/index.ts`, which also carries `RecoveryLoginForm`, `TurnstileWidget`,
`turnstileEnabled` and the `RunPasskeyCeremony` / `RunPasskeyRegistration`
types.

**Hosts today.** `@musubi/social` is the one workspace that depends on the
package. Its `DESIGN.md` §Auth surfaces says where each view mounts and what
the app supplies ([musubi/social/DESIGN.md](../../musubi/social/DESIGN.md)).
Five views mount in no app: `SessionsView` (#2055), `ChangeEmailForm`
(#2056), `ProfileSwitcher` (#2045), and `CheckEmailView` and `ConfirmLinkPage`
(#2085). Only their tests render them, and `CheckEmailView` and
`ConfirmLinkPage` their lab stories too (§11).

**What a host supplies.**

- The stylesheet: `@shared/design-tokens/tokens.css`, which carries the
  `@source` for `osn/auth-ui/src`, so the views' classes compile in the host;
  a `:root` block mapping every `--ui-*` role; and, today, the shadcn colour
  names the views' own classes use (§2).
- A `Toaster` from `@shared/toast`, for the views that call `toast`.
- `AuthProvider` from `@osn/client/solid`, for the views that call `useAuth`.
- The `Dialog` that frames `SignIn` and `Register`; neither draws one.
- Per view:

| View | Props a host passes | Context it reads |
| --- | --- | --- |
| `SignIn` | `client` (`LoginClient`), `recoveryClient`, `productName`; `registrationClient` and `runPasskeyRegistration` (both, or recovery offers the recovery code only); `turnstileSiteKey`; `onSuccess`, `onCancel` | `AuthProvider`, `Toaster` |
| `Register` | `client` (`RegistrationClient`), `productName`, `onCancel`; `turnstileSiteKey`; `onSuccess` | `AuthProvider`, `Toaster` |
| `RecoveryLoginForm` | `client` (`RecoveryClient`); `registrationClient` and `runPasskeyRegistration`; `turnstileSiteKey`; `onSuccess`, `onCancel` | `AuthProvider` |
| `PasskeysView` | `client`, `stepUpClient`, `accessToken`; `profileId` and `runPasskeyRegistration` (both, or "Add passkey" is hidden); `runPasskeyCeremony`, `totpClient`, `passkeyOnly` | — |
| `TotpView` | `client` (`TotpClient`), `stepUpClient`, `accessToken`; `runPasskeyCeremony`, `passkeyOnly` | `Toaster` |
| `RecoveryCodesView` | `client`, `stepUpClient`, `accessToken`, `productName`; `runPasskeyCeremony`, `totpClient`, `passkeyOnly`, `onSaved` | — |
| `SecurityEventsBanner` | `client`, `stepUpClient`, `accessToken`, `productName`; `runPasskeyCeremony`, `totpClient`, `onVisibleCountChange` | — |
| `SessionsView` | `client`, `accessToken` | — |
| `ChangeEmailForm` | `accountClient`, `stepUpClient`, `accessToken`; `runPasskeyCeremony`, `onChanged` | — |
| `CheckEmailView` | `purpose`, `status`, `onResend`; `email`, `errorMessage`, `onChangeEmail`, `resendWaitSeconds`, `pairingCode` (the host's rules for each are in [component-library §CheckEmailView](../../wiki/shared/component-library.md)) | — |
| `ConfirmLinkPage` | `purpose`, `onConfirm`, and `candidates` or `initialOutcome` (one is required); `email`, `onContinue` (the host's rules for each are in [component-library §ConfirmLinkPage](../../wiki/shared/component-library.md)) | — |
| `StepUpDialog` | `client`, `accessToken`, `onToken`, `onCancel`; `runPasskeyCeremony`, `totpClient`, `passkeyOnly`, `title`, `reason`, `purpose` | — |
| `CreateProfileForm` | `checkHandle`, `onSuccess`, `onCancel` | `AuthProvider`, `Toaster` |
| `ProfileOnboarding` | `checkHandle`, `dismissible` | `AuthProvider`, `Toaster` (through `CreateProfileForm`) |
| `ProfileSwitcher` | `checkHandle`, `onSwitch`, `onCreate` | `AuthProvider`, `Toaster` |
| `TurnstileWidget` | `siteKey`, `onToken`; `onReady`, `theme`, `class` | — |

The clients come from `@osn/client`. A ceremony runner is the host's own
wrapper round `@simplewebauthn/browser`: the settings views and `StepUpDialog`
take one and import no WebAuthn runtime. `SignIn` and `Register` import
`startAuthentication` and `startRegistration` themselves, and
`RecoveryLoginForm` imports `browserSupportsWebAuthn`.

## 2. Token contract

**The rule.** Inside the package, colour, radius, type, tracking and leading
come only from `ui-*` utilities — `text-ui-ink`, `bg-ui-surface-sunk`,
`rounded-ui-md`, `text-ui-sm` and the rest — as
[design-tokens](../../wiki/shared/design-tokens.md) rule 1 requires. A view
never names a host's own vocabulary, a raw palette colour or an arbitrary
value.

**As it stands.** The `@shared/ui` parts the views are built from render
through the contract, and so do `CheckEmailView`'s and `ConfirmLinkPage`'s own
classes, which are `ui-*` utilities alone. The other views' own classes do not yet (#2045). They name the
shadcn colour vocabulary — `text-foreground`, `text-muted-foreground`,
`text-destructive`, `text-primary`, `text-accent-foreground`, `bg-background`,
`bg-muted`, `bg-accent`, `border-border` — Tailwind's default type steps and
weights (`text-xs`, `text-sm`, `text-lg`, `text-2xl`, `font-semibold`,
`font-bold`) and Tailwind's own radii (`rounded-md`, `rounded`). So the views
render as intended only in a host that defines that vocabulary. The `ui-*`
utilities the views write themselves today: `text-ui-success` (`Register`),
`border-ui-warn/40 bg-ui-warn/10` (`SecurityEventsBanner`), `text-ui-xs`
(`ProfileSwitcher`).

**Status roles in use.**

- `ui-success` — ink for a confirmed good state: the "Accepted" line after an
  email code in `Register`, and the shared parts' own success states
  (`UsernameInput`, `OtpInput`).
- `ui-warn` — a border and a wash: the `SecurityEventsBanner` box.
- `ui-danger` — red, written today as `text-destructive`: every other view's
  error line, the field-level refusals in `Register`, and `RecoveryCodesView`'s
  warning when an account has no recovery codes. `CheckEmailView`'s and
  `ConfirmLinkPage`'s errors are inline danger `Notice`s, which paint
  `ui-danger` themselves.

## 3. Type

**The rule.** Sizes come from the contract's `text-ui-*` steps (`xs`, `sm`,
`base`, `md`, `lg`, `xl`, `2xl`); a host maps those to its own scale.

**As it stands** (#2045):

| Role | Classes today | Where |
| --- | --- | --- |
| Heading of a dialog view | `text-2xl font-bold` | `SignIn`, `Register` |
| Heading of a panel | `text-lg font-semibold` | `PasskeysView`, `TotpView`, `SessionsView`, `ChangeEmailForm`, `StepUpDialog`; the `enrol`, `enrolled` and `expired` steps of `RecoveryLoginForm` |
| Body copy | `text-sm` | the views' own paragraphs and lines |
| Meta lines (dates, "(synced)", field hints) | `text-xs` | the list rows, the banner, `Register`'s field hints |
| Names in a row | `font-medium` | `PasskeysView`, `TotpView`, `SessionsView`, `SecurityEventsBanner` |
| Codes | `font-mono` | `RecoveryCodesView`'s list, `TotpView`'s setup key; with `tracking-widest`, the code fields `ChangeEmailForm` and `StepUpDialog` draw themselves (§5) |

The `@shared/ui` parts inside the views (Button, Input, Label, OtpInput, Card
and Dialog titles) take the contract steps.

`CheckEmailView` follows the rule. Its heading is `text-ui-base font-medium`,
its lines `text-ui-sm` with `leading-ui-snug`, and the number a host passes as
`pairingCode` is `text-ui-xl font-medium leading-ui-tight tabular-nums`. The
number is the largest text in the view, larger than its heading, because it is
the one thing the person carries to another screen. It takes tabular figures,
not the Codes row's `font-mono`: it is read and picked, never typed or copied.

`ConfirmLinkPage` follows the rule too. Its `h1` is `text-ui-base font-medium`,
the step `CheckEmailView`'s heading takes, because the card is the page's whole
content; its lines `text-ui-sm` with `leading-ui-snug`. Each number it offers is
`text-ui-xl font-medium leading-ui-tight tabular-nums` inside its Button, the
size and figures the waiting screen draws the number in, so the person matches
like with like. The number picked, repeated in "You picked {n}.", is
`font-medium tabular-nums` at the line's size.

## 4. Layout

As built:

- **Dialog views** (`SignIn`, `Register`) carry their own column,
  `mx-auto max-w-sm px-4 py-8`, inside whatever frame the host gives them: a
  header row with the view's heading and its Cancel, then one step at a time
  as a `flex-col gap-4` stack. Fields are a Label above the control; the
  primary Button spans the column.
- **Settings panels** (`PasskeysView`, `TotpView`, `SessionsView`) are a
  `flex-col gap-3` section: a header row with the heading and, on the right,
  the panel's action (a `size="sm"` Button in `PasskeysView` and `TotpView`,
  an `outline` Button at the default size in `SessionsView`); then the list,
  each row a bordered `rounded-md` box with a name, a meta line and `outline`
  `sm` actions. `RecoveryCodesView` draws no heading; its host gives it one.
- **`ChangeEmailForm`** is the same `flex-col gap-3` column: its heading, then
  one phase at a time. The email and code phases are each a labelled field
  over a full-width Button; the step-up phase is `StepUpDialog`'s panel, and
  the last a single line.
- **`CheckEmailView`** is a `flex-col gap-4` column for a step inside a dialog:
  its `h3`; the live region (the sentence, then any error); the line about
  opening the link; when there is one, the number over its caption
  (`flex-col gap-1`), unboxed; then Resend and "Use a different email" as
  full-width `ghost` `sm` Buttons, 40px tall below `md` (`max-md:h-10`).
- **`ConfirmLinkPage`** is a shared `Card` (`padding="lg"`) holding a
  `flex-col gap-6` column for a bare route; the host draws the `<main>` around
  it. Its `h1` and sentences (`gap-2`); then, while it asks, a `<fieldset>`
  whose `<legend>` is the instruction, the numbers in one column at every width
  as full-width `outline` Buttons 48px tall (`h-12`), and under them "I didn't
  ask for this" as a full-width `ghost` `sm` Button, 44px below `md`
  (`max-md:h-11`); then the line about the number picked, the slow line and
  the error `Notice`; then Try again or Continue, full-width default `lg`
  Buttons, 44px below `md`. Left-aligned.
- **The banner** (`SecurityEventsBanner`) is one bordered box with the warn
  border and wash: each event as a headline and a meta line, a footer line,
  and Acknowledge (`outline`, `sm`) at the right.
- **Step-up** (`StepUpDialog`) is a `p-4` panel drawn in place inside the view
  that opened it (§8).
- **Dialogs a view opens itself** — `ProfileOnboarding`'s "Create a new
  profile", `RecoveryCodesView`'s "Generate a new set?" and `ProfileSwitcher`'s
  two — use `@shared/ui`'s `DialogContent` with its default, centred
  presentation, a `DialogHeader` and `DialogTitle`, a `p-4` body and, where
  there are actions, a `DialogFooter`.
- **`ProfileOnboarding`** is a `Card` titled "Add another profile".

## 5. Parts

The `@shared/ui` parts each view imports, and the Button variants it uses
besides the default:

| View | Parts | Button variants |
| --- | --- | --- |
| `SignIn` | Button, Input, Label | `ghost`, `secondary` |
| `Register` | Button, InfoPopover, Input, Label, OtpInput, UsernameInput | `ghost` |
| `RecoveryLoginForm` | Button, Input, Label, OtpInput | `outline`, `ghost` |
| `StepUpDialog` | Button | `outline`, `ghost` |
| `PasskeysView` | Button, Input | `outline`, `ghost` |
| `TotpView` | Button, Input, Label, OtpInput, QrCode | `outline`, `ghost` |
| `RecoveryCodesView` | Button, Dialog | `outline`, `ghost` |
| `SessionsView` | Button | `outline` |
| `SecurityEventsBanner` | Button | `outline` |
| `ChangeEmailForm` | Button | — |
| `CheckEmailView` | Button, Notice | `ghost` |
| `ConfirmLinkPage` | Button, Card, Notice | `outline`, `ghost` |
| `CreateProfileForm` | Button, Input, Label, UsernameInput | `ghost` |
| `ProfileOnboarding` | Button, Card, Dialog | `ghost` |
| `ProfileSwitcher` | Avatar, Button, Dialog, Popover | `ghost`, `destructive` |
| `TurnstileWidget` | — | — |

**Drawn by hand.** Besides those parts, the views draw these controls
themselves:

- Raw `<input>`s: the new email and the code in `ChangeEmailForm`, and the
  emailed code and the authenticator code in `StepUpDialog`, each
  `bg-background rounded-md border px-3 py-2` inside a `<label>`.
- A raw checkbox, "I've saved these codes somewhere safe.", in
  `RecoveryCodesView`.
- Text `<button>`s: "Lost your passkey?" in `SignIn` and "Resend code" in
  `Register`, `text-primary text-sm font-medium` with an underline on hover;
  each profile row and its delete control in `ProfileSwitcher`.
- A `<details>` disclosure, "Signing in somewhere new?", under the list in
  `PasskeysView`.

## 6. States per view

Each state is named from the view's own code, with the copy it shows.

**`SignIn`** — heading "Sign in to {productName}", or "Recover your account"
in the recovery view.

| State | What shows |
| --- | --- |
| Passkey form | "Email or @handle", the Turnstile challenge when a site key is set, Continue ("Verifying…" while busy), "Lost your passkey?" |
| No WebAuthn | "{productName} sign-in needs a passkey or security key, and this browser doesn't support WebAuthn. You can either:" and three ways forward; "Use a recovery code instead" (`secondary`) |
| Recovery | `RecoveryLoginForm` |
| Signed in | "You're all set." |

While the passkey form shows, a discoverable-credential sign-in runs in the
background where the browser offers passkey autofill; it shows nothing of its
own.

**`Register`** — heading "Create your {productName} account".

| State | What shows |
| --- | --- |
| No WebAuthn | "Creating an account on {productName} needs a passkey or security key — something this browser doesn't support. …" |
| Details | Email (with an "i" popover, "What this address is used for"), Handle (`UsernameInput`: checking, available, taken, invalid), Date of birth with "You must be 13 or older to use {productName}" (or "{productName} is for users 13 and older"), Display name (optional), the Turnstile challenge, "Send verification code" ("Sending…") |
| Verify | "We sent a 6-digit code to {email}. Enter it below to verify.", the code boxes, then "Verifying your code…", "Accepted" or "Incorrect code. Please try again"; "Verify email" ("Verifying…"); "Resend code" (with a countdown while it waits); "← Use a different email" |
| Passkey | "Enroll a passkey or security key so you can sign back in. This is required to finish creating your account."; "Enroll credential" ("Setting up…") |
| Done | "You're all set. Loading {productName}…" |

**`RecoveryLoginForm`**

| State | What shows |
| --- | --- |
| Choose | "Pick how you'd like to prove this account is yours."; "Use a recovery code"; "Email me a code" and "Use my authenticator app" where the browser can run a passkey ceremony and the host passed both enrolment props, otherwise a list of ways forward; "Back to sign in" |
| Recovery code | "Handle or email", "Recovery code"; "Sign in with recovery code" ("Signing in…"); Back |
| Email, identify | "Email address on the account", the Turnstile challenge; "Send the code" ("Sending…"); Back |
| Email, verify | "Code from your email" and the code boxes; Continue ("Checking…"); Back |
| Authenticator | "Handle or email", "Code from your authenticator app" and the code boxes; Continue ("Checking…"); Back |
| Enrol | "Add a passkey to get back in", what a recovery session is; "Add a passkey" ("Waiting for your passkey…", "Try again" after an error), "Start again" after an error |
| Enrolled | "You're back in"; "Sign in with your new passkey" |
| Expired | "That recovery session timed out"; "Start again" |

**`StepUpDialog`** — §8.

**`PasskeysView`** — heading "Passkeys" with "Add passkey". States: loading
("Loading…"); the list, each row the passkey's name ("Synced passkey" or
"Device passkey" when unnamed, "(synced)" when backed up), "Added … · Last
used …", Rename and Delete; a row being renamed (a field, Save, Cancel); a
step-up in progress, which disables every row's actions. Under the list, a
"Signing in somewhere new?" disclosure.

**`TotpView`** — heading "Authenticator app", then "A six-digit code from an
app on your phone. …". States: loading; none set up ("Add an authenticator
app" in the header); set up (the app's name, "Added … · Last used …",
Remove); setting up ("Scan this with your authenticator app", the QR code,
"Or enter this setup key by hand", "Name this device (optional)", "Code from
the app", Confirm ("Checking…"), Cancel); a step-up in progress.

**`RecoveryCodesView`** — the intro "Recovery codes let you sign in if you
lose every device with your passkey. …". States: first load (a placeholder
line, and the button reads "Checking…"); status unread ("Couldn't check
whether you have recovery codes."); no codes ("You don't have any recovery
codes yet. …"); codes held ("{active} of {total} codes unused · created
{date}"); the button "Generate recovery codes" or "Generate new codes"
("Generating…"); new codes on screen ("Save these codes somewhere safe. You
will not see them again.", the codes, Copy, "Download .txt", "I've saved
these codes somewhere safe.", Done); the confirm dialog before a new set
replaces the old ("Generate a new set?", Cancel, "Generate new set"); a
step-up in progress.

**`SecurityEventsBanner`** — renders nothing until there is an unacknowledged
event, and nothing if the list cannot be read. With events: one headline per
event (by kind, with a general line for a kind it does not know) and its time
and device, a footer line, Acknowledge, then a step-up.

**`SessionsView`** — heading "Active sessions" with "Sign out everywhere else".
States: loading; the list, each row the device ("Unknown device" when
unnamed, "(this device)" on the current one), "Created … · Last used …",
Revoke (disabled on the current one).

**`ChangeEmailForm`** — heading "Change email". Phases: new email ("New email",
"Send verification code"); code ("We sent a 6-digit code to {email}. Enter it
below to continue.", "Code", "Confirm identity & change email"); step-up, on
the first Confirm, after which the change completes; done ("Your email is now
{email}.").

**`CheckEmailView`** — the wait after a flow emails a link. Where the host
gives no `email`, "your email address" stands for the address, and recovery
says "If that address has an account, …".

| State | What shows |
| --- | --- |
| Waiting | "Check your email"; "We sent a link to {email}." (recovery: "If {email} has an account, a link is on its way."); the flow's line ("Open it on any device to finish signing up.", "… to get back into your account.", "… to confirm it's you.", "… to confirm your new address.") and "This page will update when you do."; the number and "Pick this number on the page the link opens." when the host passes one; "Resend in {n}s", disabled, then "Resend link"; "Use a different email" when the host passes `onChangeEmail` |
| Sending | "Sending a new link…"; Resend reads "Sending…" |
| Sent again | "We sent a new link to {email}." (recovery: "If {email} has an account, a new link is on its way."), ending "Check the number again." when a number shows |
| Error | The waiting copy, the number kept, and the host's `errorMessage` (or "Something went wrong. Try again in a moment.") under the sentence |
| Expired | "Your link has expired"; "Ask for a new link to {email}."; no flow line and no number; "Send a new link" as the default Button, at once |

**`ConfirmLinkPage`** — the page an emailed link opens. "{address}" is the
host's `email`, or "this address". Each flow's sentence: sign-up "Confirming
lets the device that asked finish signing up with {address}."; recovery "…
back into your account. It also signs out every other device."; step-up "… go
ahead with something sensitive, such as adding a passkey or deleting the
account."; email change "Confirming sets {address} as the email of the account
that asked."

| State | What shows |
| --- | --- |
| Ready | "Confirm this email"; the flow's sentence; "Only confirm if you asked for this. If you didn't, choose “I didn't ask for this” below." (step-up: "If you didn't, someone else may be signed in to your account. Choose … below, then sign out your other sessions."); "Pick the number shown on the screen where you started." and the numbers; "I didn't ask for this" |
| Confirming | The same, every button disabled; "You picked {n}. Confirming…" or "Cancelling…"; after 10 seconds "This is taking longer than usual. Keep this page open." |
| Error | The same, disabled; "You picked {n}." after a number; "We couldn't confirm this email just now." or "We couldn't cancel this just now."; Try again |
| Confirmed | "Confirmed"; "Go back to where you started to {finish}. You can close this page.", or "Continue to {finish}." and Continue when the host passes `onContinue` |
| Cancelled | "Cancelled"; "Nothing was confirmed. You can close this page." (step-up: "Nothing was confirmed. Someone else may be signed in to your account, so sign out your other sessions.") |
| Expired | "This link no longer works"; "It has expired or was already used. If you confirmed it already, go back to where you started and carry on. If not, go back and ask for a new link." The same for every refusal, a list the page cannot offer included |

**`CreateProfileForm`** — Handle (`UsernameInput`), "Display name (optional)",
"Create profile" ("Creating..."), Cancel when the host gives `onCancel`.

**`ProfileOnboarding`** — shows only with a session, exactly one profile and
no earlier dismissal: the card "Add another profile", "Create profile", and
a dismiss control when `dismissible`.

**`ProfileSwitcher`** — a popover of the account's profiles with the active
one marked, a create dialog and a delete dialog.

**`TurnstileWidget`** — renders nothing without a site key; with one, the
challenge, and "Couldn't load the verification challenge. Refresh and try
again. …" when it fails to load.

## 7. Errors

As built:

- **Where.** Each view shows one error line at a fixed place: under the form
  in `SignIn`; at the top of `RecoveryLoginForm`; under the heading lines in
  `StepUpDialog`, `PasskeysView`, `TotpView`, `SessionsView` and
  `ChangeEmailForm`; under the button in `RecoveryCodesView`; at the top of
  the banner box in `SecurityEventsBanner`; inside the verify and passkey
  steps in `Register`, whose details step reports a failed send by toast
  alone. `Register` also shows field-level lines under the email and the date
  of birth. All are `text-destructive`, at `text-sm`, except `SignIn`'s,
  `TurnstileWidget`'s and `Register`'s two field-level lines, at `text-xs`.
  `CheckEmailView` shows the host's `errorMessage` as an inline danger
  `Notice` under its sentence, inside the live region, so it is read out; it
  raises no toast. `ConfirmLinkPage` shows a fixed line, never the thrown
  error's text, as an inline danger `Notice` directly above Try again, and says
  it through its own polite `<output>`; no toast. It never says a number was
  wrong: a refused number shows the expired state.
- **Toasts.** `SignIn`, `Register`, `TotpView`, `CreateProfileForm` and
  `ProfileSwitcher` also raise an error toast, and a success toast when an
  action completes ("Signed in", "Verification code sent", "Email verified",
  "Authenticator app added", …). The other views use the line alone.
- **Text.** The line shows the thrown error's `message` where it has one, and
  otherwise a fixed line per action ("Sign-in failed", "Step-up failed",
  "Invalid or expired code", "Couldn't add a passkey", …) (#2044). Fixed
  sentences the views write themselves: "Please complete the verification
  challenge below." when the Turnstile challenge is not done; "That recovery
  code didn't work. Double-check the code and identifier."; "Enter the 6-digit
  code" in `StepUpDialog`; and `SignIn`'s line when the browser refuses a
  passkey, which points to "Lost your passkey?".
- A recovery session that runs out is its own state in `RecoveryLoginForm`
  ("That recovery session timed out"), not an error line.

## 8. Step-up

`StepUpDialog` asks for a fresh factor before a gated action and hands the
host a short-lived token through `onToken`.

- **Structure.** A panel, not a `Dialog`: it renders in place, inside the view
  that opened it, as a `p-4` column — the heading ("Confirm it's you", or
  `title`), "Re-authenticate {reason}." when `reason` is given, the line "This
  action needs a fresh authentication. Choose a method below." (left out with
  `passkeyOnly`), the error line, then the factors as full-width Buttons, the
  passkey first.
- **Factors.** A passkey always ("Use passkey"). An emailed code ("Email me a
  code") where the ceremony's `purpose` admits it and `passkeyOnly` is not set.
  An authenticator app ("Use your authenticator app") where the `purpose`
  admits it, the host passes `totpClient`, and the account has one
  (`GET /totp/status`; a failed read hides the factor). By `purpose`:
  `passkey_delete` admits the passkey only; `email_change` the passkey and the
  emailed code; every other purpose, and no purpose, all three.
- **`passkeyOnly`** means the host cannot deliver mail: it removes the emailed
  code and nothing else, and starts the passkey ceremony as the panel mounts.
  Its full meaning is in
  [passkey-primary §What `passkeyOnly` means](../../wiki/osn/passkey-primary.md).
- **States.** Choosing a factor; waiting for the passkey ("Waiting for your
  passkey…" with `passkeyOnly`, then "Try again" after an error); entering an
  emailed code ("Code", Confirm); entering an authenticator code ("Code from
  your authenticator app", Confirm).
- **Who opens it.** `PasskeysView` (`passkey_register` to add,
  `passkey_delete` to rename or delete), `TotpView` (`totp_enroll`,
  `totp_disable`), `RecoveryCodesView` (`recovery_generate`, "to generate
  recovery codes"), `SecurityEventsBanner` (`security_event_ack`) and
  `ChangeEmailForm` (`email_change`).

## 9. Focus

Every focusable element in a view shows a visible focus indicator on
`:focus-visible`, drawn from `--ui-focus`. The `@shared/ui` parts supply it;
a control the package draws itself takes the same treatment as `@shared/ui`'s
Button, `focus-visible:ring-2 focus-visible:ring-ui-focus`. A focus indicator
appears at once, never animated.

**As it stands.** No class in `osn/auth-ui/src` draws a focus ring. The
`@shared/ui` parts draw their own; every control the views draw by hand (§5)
shows the browser's default outline instead:

- the raw code and email `<input>`s in `ChangeEmailForm` and `StepUpDialog`
  (#2041; `ChangeEmailForm`'s code field in #2056);
- "Lost your passkey?" in `SignIn` and "Resend code" in `Register` (#2036);
- the raw checkbox in `RecoveryCodesView`, the profile rows and delete
  controls in `ProfileSwitcher`, and the "Signing in somewhere new?" summary in
  `PasskeysView` (#2045).

`ProfileSwitcher`'s rows also carry `transition-colors`, whose property list
includes `outline-color`, so their outline fades in.

`CheckEmailView` draws no control by hand. Its heading takes focus from code
when the view appears and when Resend disables itself (`tabindex="-1"`, so
never by Tab), and draws no indicator (`focus:outline-none`): it is where focus
is put, not a control.

`ConfirmLinkPage` draws no control by hand either: its numbers, the decline,
Try again and Continue are `@shared/ui` Buttons, which draw their own ring. Its
`h1` takes focus the same way, on mount and on every change, so a tapped
number that disables itself never leaves focus on `<body>`.

## 10. Words

**The rule.** The product's name comes from the host through `productName`
(the prop's TSDoc says so on each view that takes it); the package hard-codes
no product.

**As it stands:**

- `SignIn`, `Register`, `RecoveryCodesView` and `SecurityEventsBanner` take
  `productName`. `SignIn`'s line for a refused passkey names `musubi.social`
  in its own text (#2042).
- The identifier: "Email or @handle" in `SignIn`; "Handle or email" in
  `RecoveryLoginForm`; "Email address on the account" on its emailed-code
  step; "Email" in `Register`.
- The factors: passkey ("Use passkey", "Add passkey", "Add a passkey",
  "Enroll credential" in `Register`, with "passkey or security key" in the
  no-WebAuthn copy); emailed code ("Email me a code"); authenticator app ("Use
  your authenticator app" in `StepUpDialog`, "Use my authenticator app" in
  `RecoveryLoginForm`); recovery code ("Use a recovery code", "Recovery
  code").
- Going back: Cancel, Back, "Back to sign in", "← Use a different email"
  (`Register`), "Use a different email" (`CheckEmailView`), "Start again".
- Saying no: "I didn't ask for this" (`ConfirmLinkPage`), answered by
  "Cancelled".

## 11. Tests

As built:

- **Package tests** — `osn/auth-ui/tests/`, one file per view, each under
  happy-dom (`// @vitest-environment happy-dom`), plus
  `webauthn-browser.test.ts`, which runs the real `@simplewebauthn/browser`
  against a stubbed `navigator.credentials` for registration, authentication
  and conditional autofill. Run `bun run --cwd osn/auth-ui test:run`.
- **No real-browser tier** in the package. **Lab stories** for
  `CheckEmailView`, `osn/auth-ui/CheckEmailView` in
  `tools/lab/src/stories/osn-auth-ui/check-email-view.story.tsx`: one per
  state, every flow, a 320px phone, and the number at rest, across a resend
  and on a phone; and for `ConfirmLinkPage`, `osn/auth-ui/ConfirmLinkPage` in
  `confirm-link-page.story.tsx`: one per state, three and five numbers, the
  decline, an opening answer, every flow and a 320px phone. The other views
  get theirs in #2045.
- **In the host.** `musubi/social/tests/styles/design-token-contract.test.ts`
  and `token-contract.browser.test.tsx` hold the mapping the shared parts
  inside the views render through. Musubi's component tests mock the views
  (`vi.mock("@osn/auth-ui/…")`) and check how the app wires them. The suites
  that run the real views are the end-to-end flows
  `tools/e2e/tests/flows/musubi-passkey.flow.ts` and
  `tools/e2e/tests/flows/musubi-register-retry.flow.ts`, and, for
  `CheckEmailView`, which no flow reaches yet,
  `musubi/social/tests/components/CheckEmailView.layout.browser.test.tsx`: it
  renders the view in Musubi's auth sheet in Chromium and holds its layout at
  320px and 1280px (the long address, the countdown on one line, the 40px and
  32px buttons, and the six-digit number at 24px in tabular figures with its
  label read first). No flow reaches `ConfirmLinkPage` yet either;
  `musubi/social/tests/components/ConfirmLinkPage.layout.browser.test.tsx`
  renders it on a bare route in Chromium and holds, at 320px, five six-digit
  numbers and a long address with nothing to scroll sideways, and at 320px and
  1280px the numbers one under another, at least 44px tall in 24px tabular
  figures, the decline and Try again at 44px below `md`, and the error notice
  above Try again.
