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
| `PasskeysView` | `client`, `stepUpClient`; `profileId` and `runPasskeyRegistration` (both, or "Add passkey" is hidden); `runPasskeyCeremony`, `totpClient`, `passkeyOnly` | — |
| `TotpView` | `client` (`TotpClient`), `stepUpClient`; `runPasskeyCeremony`, `passkeyOnly` | `Toaster` |
| `RecoveryCodesView` | `client`, `stepUpClient`, `productName`; `runPasskeyCeremony`, `totpClient`, `passkeyOnly`, `onSaved` | — |
| `SecurityEventsBanner` | `client`, `stepUpClient`, `productName`; `runPasskeyCeremony`, `totpClient`, `onVisibleCountChange` | — |
| `SessionsView` | `client` | — |
| `ChangeEmailForm` | `accountClient`, `stepUpClient`; `runPasskeyCeremony`, `onChanged` | — |
| `CheckEmailView` | `purpose`, `status`, `onResend`; `email`, `errorMessage`, `onChangeEmail`, `resendWaitSeconds`, `pairingCode` (the host's rules for each are in [component-library §CheckEmailView](../../wiki/shared/component-library.md)) | — |
| `ConfirmLinkPage` | `purpose`, `onConfirm`, and one of `candidates`, `typeNumber` (recovery, step-up) or `initialOutcome`; `email`, `onContinue` (the host's rules for each are in [component-library §ConfirmLinkPage](../../wiki/shared/component-library.md)) | — |
| `StepUpDialog` | `client`, `onToken`, `onCancel`; `runPasskeyCeremony`, `totpClient`, `passkeyOnly`, `title`, `reason`, `purpose` | — |
| `CreateProfileForm` | `checkHandle`, `onSuccess`, `onCancel` | `AuthProvider`, `Toaster` |
| `ProfileOnboarding` | `checkHandle`, `dismissible` | `AuthProvider`, `Toaster` (through `CreateProfileForm`) |
| `ProfileSwitcher` | `checkHandle`, `onSwitch`, `onCreate` | `AuthProvider`, `Toaster` |
| `TurnstileWidget` | `siteKey`, `onToken`; `onReady`, `theme`, `class` | — |

The clients come from `@osn/client`. A view takes no access token: the host
builds each authenticated client with its auth runtime's `authFetch`
(`createOsnAuthRuntime`), which sends the token and renews it. A ceremony runner is the host's own
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
`text-destructive`, `text-primary`, `text-accent-foreground`, `bg-muted`,
`bg-accent`, `border-border` — Tailwind's default type steps and
weights (`text-xs`, `text-sm`, `text-lg`, `text-2xl`, `font-semibold`,
`font-bold`) and Tailwind's own radii (`rounded-md`, `rounded`). So the views
render as intended only in a host that defines that vocabulary. The `ui-*`
utilities the views write themselves today: `text-ui-success` (`Register`),
`border-ui-warn/40 bg-ui-warn/10` (`SecurityEventsBanner`), `text-ui-xs`
(`ProfileSwitcher`), and `@shared/ui`'s `labelVariants()` — the plain label's
classes — on the spans over a row of code boxes and over `TotpView`'s setup key
(§4). Every error line is a `@shared/ui` `Notice`, so it
paints `ui-danger` through the contract (§7).

**Status roles in use.**

- `ui-success` — ink for a confirmed good state: the shared parts' own success
  states (`UsernameInput`, `OtpInput`).
- `ui-warn` — a border and a wash: the `SecurityEventsBanner` box.
- `ui-danger` — ink for a failure: every view's error line, drawn by
  `Notice` (`tone="danger"`). `RecoveryCodesView`'s warning when an account
  has no recovery codes still writes `text-destructive`.

## 3. Type

**The rule.** Sizes come from the contract's `text-ui-*` steps (`xs`, `sm`,
`base`, `md`, `lg`, `xl`, `2xl`); a host maps those to its own scale.

**As it stands** (#2045):

| Role | Classes today | Where |
| --- | --- | --- |
| Heading of a dialog view | `text-2xl font-bold` | `SignIn`, `Register` |
| Heading of a panel | `text-lg font-semibold` | `PasskeysView`, `TotpView`, `SessionsView`, `ChangeEmailForm`, `StepUpDialog`; the `enrol`, `enrolled` and `expired` steps of `RecoveryLoginForm` |
| Body copy | `text-sm` | the views' own paragraphs and lines |
| Meta lines (dates, "(synced)") | `text-xs` | the list rows, the banner |
| Field hints | `Field`'s hint, `text-ui-xs` in the secondary ink | `Register`'s date of birth |
| Names in a row | `font-medium` | `PasskeysView`, `TotpView`, `SessionsView`, `SecurityEventsBanner` |
| Codes | `font-mono` | `RecoveryCodesView`'s list, `TotpView`'s setup key. Every six-digit code is typed into `OtpInput`'s boxes, at the contract's `text-ui-md`. `RecoveryLoginForm`'s recovery code, 16 characters in four groups, is an `Input` in a `Field` |

The `@shared/ui` parts inside the views (Button, Field, Input, Label,
OtpInput, Card and Dialog titles) take the contract steps.

`CheckEmailView` follows the rule. Its heading is `text-ui-base font-medium`,
its lines `text-ui-sm` with `leading-ui-snug`, and the number a host passes as
`pairingCode` is `text-ui-xl font-medium leading-ui-tight tabular-nums`. The
number is the largest text in the view, larger than its heading, because it is
the one thing the person carries to another screen. It takes tabular figures,
not the Codes row's `font-mono`: it is digits only, which tabular figures
already set at one width, and it is read here, never typed or copied here.

`ConfirmLinkPage` follows the rule too. Its `h1` is `text-ui-base font-medium`,
the step `CheckEmailView`'s heading takes, because the card is the page's whole
content; its lines `text-ui-sm` with `leading-ui-snug`. Each number it offers is
`text-ui-xl font-medium leading-ui-tight tabular-nums` inside its Button, the
size and figures the waiting screen draws the number in, so the person matches
like with like. The number picked, repeated in "You picked {n}.", is
`font-medium tabular-nums` at the line's size. Where recovery asks for the
number to be typed, the field takes `Input`'s `code` face, mono with wide
tracking, as the Codes row does: the person checks a typed value character by
character. Its label is a plain one, as every form field's is (§4). The field
is one `Input`, not `OtpInput`'s boxes: the boxes are a fixed six, and the
number runs from one digit to six, a length the page is not told.

## 4. Layout

As built:

- **Dialog views** (`SignIn`, `Register`) carry their own column,
  `mx-auto max-w-sm px-4 py-8`, inside whatever frame the host gives them: a
  header row with the view's heading and its Cancel, then one step at a time
  as a `flex-col gap-4` stack. Each field is `@shared/ui`'s `Field` with a
  plain label (`labelTreatment="plain"`), 6px above the control. The two
  labels `Field` does not draw sit 6px above their controls too: `Register`'s
  Email, a bare `Label` beside its "i", and the span over a row of code boxes
  (`RecoveryLoginForm`, `TotpView`, `StepUpDialog`, `ChangeEmailForm`), which
  takes the plain label's classes from `labelVariants()`
  (`@shared/ui/ui/label`) because six boxes have no one id for a
  `<label for>`. The span carries an id from `createUniqueId()`, and the boxes
  name their group by it (`aria-labelledby`), so box N reads "<label> Digit
  N". `Register`'s code step has no label over its boxes: its sentence "We
  sent a 6-digit code to …" leads the step, and the group keeps `OtpInput`'s
  own name, "Verification code". `TotpView`'s "Or enter this setup key by
  hand" is the same span over its key.
  The primary Button spans the column; a standalone link under it sits centred
  (§5).
- **Settings panels** (`PasskeysView`, `TotpView`, `SessionsView`) are a
  `flex-col gap-3` section: a header row with the heading and, on the right,
  the panel's action (a `size="sm"` Button in `PasskeysView` and `TotpView`,
  an `outline` Button at the default size in `SessionsView`), which wraps
  under the heading, 8px below it, when the two do not fit on one line
  ("Add an authenticator app" at 320px); then the list,
  each row a bordered `rounded-md` box with a name, a meta line and `outline`
  `sm` actions. The name and meta line give way (`min-w-0 flex-1`) and the name
  breaks inside a word (`wrap-break-word`), so `PasskeysView`'s 64-character
  name, or `SessionsView`'s device line, wraps and keeps the actions inside
  the card at 320px. `RecoveryCodesView` draws no heading; its host gives it one.
  `TotpView`'s enrolment step is a bordered `rounded-md` `p-4` box at `md`
  and up, and drops the border and padding below `md`, so its code boxes
  take the panel's whole column on a phone (`musubi/social/DESIGN.md`
  §Responsive layout).
  The rows' `border` names no colour, so the host decides it: Musubi's base
  rule draws the hairline, `--border`.
- **`ChangeEmailForm`** is the same `flex-col gap-3` column: its heading, then
  one phase at a time. The email phase is a `Field` over a full-width Button,
  the code phase a labelled row of code boxes over one; the step-up phase is
  `StepUpDialog`'s panel, and the last a single line.
- **`CheckEmailView`** is a `flex-col gap-4` column for a step inside a dialog:
  its `h3`; the sentence in its live region, with any error line 8px under
  it (`flex-col gap-2`); the line about opening the link; when there is one, the number over its caption
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
  Buttons, 44px below `md`. With `typeNumber`, the numbers give way to a
  `Field` with a plain label 6px above one `Input` (`size="touch"`,
  `face="code"`, `fill="ink"`), then a full-width default `lg` Confirm, 44px
  below `md`, above the decline.
  Left-aligned.
- **The banner** (`SecurityEventsBanner`) is one bordered box with the warn
  border and wash: each event as a headline and a meta line, a footer line,
  and Acknowledge (`outline`, `sm`) at the right.
- **Step-up** (`StepUpDialog`) is a `p-4` panel drawn in place inside the view
  that opened it (§8). It draws no edge, so below `md` it drops its side
  padding and its code boxes take the host's whole column: 246px at 320px in
  Musubi's Settings, not 214px (`musubi/social/DESIGN.md` §Responsive
  layout).
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
| `SignIn` | Button, Field, Input, Notice | `ghost`, `secondary`, `link` |
| `Register` | Button, Field, InfoPopover, Input, Label, Notice, OtpInput, UsernameInput | `ghost`, `link` |
| `RecoveryLoginForm` | Button, Field, Input, Notice, OtpInput | `outline`, `ghost` |
| `StepUpDialog` | Button, Notice, OtpInput | `outline`, `ghost` |
| `PasskeysView` | Button, Input, Notice, Skeleton | `outline`, `ghost` |
| `TotpView` | Button, Field, Input, Notice, OtpInput, QrCode, Skeleton | `outline`, `ghost` |
| `RecoveryCodesView` | Button, Checkbox, Dialog, Notice, Skeleton | `outline`, `ghost` |
| `SessionsView` | Button, Notice, Skeleton | `outline` |
| `SecurityEventsBanner` | Button, Notice | `outline` |
| `ChangeEmailForm` | Button, Field, Input, Notice, OtpInput | — |
| `CheckEmailView` | Button, Notice | `ghost` |
| `ConfirmLinkPage` | Button, Card, Field, Input, Notice | `outline`, `ghost` |
| `CreateProfileForm` | Button, Field, Input, Notice, UsernameInput | `ghost` |
| `ProfileOnboarding` | Button, Card, Dialog | `ghost` |
| `ProfileSwitcher` | Avatar, Button, Dialog, Notice, Popover | `ghost`, `ghostDanger`, `destructive` |
| `TurnstileWidget` | Notice | — |

**Drawn by hand.** Besides those parts, the views draw these controls
themselves:

- Text `<button>`s: each profile row in `ProfileSwitcher`, with the chosen
  row marked by the accent wash and a ✓ (#2045). The row's delete is a
  `ghostDanger` icon `Button` beside the row's button, never inside it: a
  button inside a button has no reliable name or keyboard path. It is 28px,
  40px below `md` as Musubi's row actions are. The hover wash is the row
  button's alone, so the delete's own wash shows beside it.
- `InlineAction` (`src/InlineAction.tsx`, internal): the button that ends an
  error line — "Lost your passkey?" in `SignIn`'s passkey error, "Try again"
  in a failed load. It keeps the line's ink and is underlined, so the action
  never relies on colour alone, and takes Button's focus ring (§9).
  `LoadFailed` (`src/LoadFailed.tsx`, internal) is the failed-load line built
  on it (§7).
- A `<details>` disclosure, "Signing in somewhere new?", under the list in
  `PasskeysView`.

**Links.** A link standing alone is Button's `link` at `sm`: `text-ui-sm` (13px
in Musubi) at 500 in the accent ink, a 32px box with 12px sides, underlined
only under the pointer,
centred under the action it follows (`self-center`) so no column edge sits
12px off its words. Two: "Lost your passkey?" under `SignIn`'s Continue, and
"Resend code" under `Register`'s "Verify email". `InlineAction`, above, is the
link that ends an error line. Musubi's rules for both, and for a link inside a
sentence, are `musubi/social/DESIGN.md` §Links.

## 6. States per view

Each state is named from the view's own code, with the copy it shows.

**A wait.** A button that starts a call shows the wait as Button's `busy`: the
label in brackets below, ending in "…", the 20px orb before it, focus kept,
every press and Enter refused (`musubi/social/DESIGN.md` §Busy buttons). Only
the button that started the call is busy; the view's other actions, its
Cancel, Back and links among them, are `disabled` meanwhile, so nothing leaves
the view while a call it started is in flight. Each button's other reasons to be `disabled` apply
only while it is not busy. Each handler also returns early while its own call
runs. Buttons named here with no label in brackets show no wait.

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
| Details | Email (with an "i" popover, "What this address is used for"; "Please enter a valid email address" once the field is left with an address that is not one), Handle (`UsernameInput`: checking, available, taken, invalid), Date of birth with the hint "You must be 13 or older to create an account." (or "{productName} is for users 13 and older" once a date under 13 is in), Display name (optional), the Turnstile challenge, "Send verification code" ("Sending…") |
| Verify | "We sent a 6-digit code to {email}. Enter it below to verify.", the code boxes, then "Verifying your code…", "Accepted" or the code's error line; "Verify email" ("Verifying…"); the Turnstile challenge again, for a resend; "Resend code" ("Sending…"; with a countdown while it waits, and held until the challenge hands it a token); "← Use a different email" |
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

**A first load.** Each Settings panel shows `@shared/ui`'s `Skeleton` in place
of what it loads, never a "Loading…" line: one row's block for `PasskeysView`
and `SessionsView` (every account has a passkey and a session), one for
`TotpView`'s set-up row, a line's for `RecoveryCodesView`'s count. The region
that holds the block and what replaces it carries `aria-busy` while the read
is out: the list's place in `PasskeysView` and `SessionsView`, the count's in
`RecoveryCodesView`, the status row's in `TotpView` (drawn only while it
holds something, so an account with no app set up gets no empty slot). A panel reads its resource's `state` before its value
and the value only once a read has landed, never by calling it, so it never
joins a host's `Suspense` boundary (a loading resource read in a component
raises its nearest boundary; Musubi's Settings would show its own fallback
for the whole tab) and never throws a failed read. On a read again,
`PasskeysView`, `SessionsView` and `RecoveryCodesView` keep what they showed;
`TotpView` shows the block again, since the status it reads again is the one
an enrolment or a removal has just changed. `PasskeysView` and `SessionsView`
disable every row's actions, and the header's, while a list they have shown is
read again, as `RecoveryCodesView` holds its button: a passkey just deleted or
a session just revoked stays on screen until the read lands. `StepUpDialog`
reads its `GET /totp/status` the same way, by `state`, so opening a step-up
never swaps its host for the host's fallback.

**`PasskeysView`** — heading "Passkeys" with "Add passkey". States: loading
(one row's placeholder); failed to load ("Your passkeys didn't load.", §7); the list, each row the passkey's name ("Synced passkey" or
"Device passkey" when unnamed, "(synced)" when backed up), "Added … · Last
used …", Rename and Delete; a row being renamed (a field, Save, Cancel); a
step-up in progress, which disables every row's actions. Under the list, a
"Signing in somewhere new?" disclosure.

**`TotpView`** — heading "Authenticator app", then "A six-digit code from an
app on your phone. …". States: loading (a row's placeholder); failed to load ("Your authenticator
app didn't load.", §7); none set up ("Add an authenticator
app" in the header); set up (the app's name, "Added … · Last used …",
Remove); setting up ("Scan this with your authenticator app", the QR code,
"Or enter this setup key by hand", "Name this device (optional)", "Code from
the app", Confirm ("Checking…"), Cancel); a step-up in progress.

**`RecoveryCodesView`** — the intro "Recovery codes let you sign in if you
lose every device with your passkey. …". States: first load (a line's
placeholder, and the button reads "Checking…"); status unread ("Couldn't check
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
States: loading (one row's placeholder); failed to load ("Your sessions didn't load.", §7); the list,
each row the device ("Unknown device" when
unnamed, "(this device)" on the current one), "Created … · Last used …",
Revoke (disabled on the current one).

**`ChangeEmailForm`** — heading "Change email". Phases: new email ("New email",
"Send verification code" ("Sending…")); code ("We sent a 6-digit code to
{email}. Enter it below to continue.", "Code" and the code boxes, "Confirm
identity & change email" ("Checking…")); step-up, on
the first Confirm, after which the change completes; done ("Your email is now
{email}.").

**`CheckEmailView`** — the wait after a flow emails a link. Where the host
gives no `email`, "your email address" stands for the address, and recovery
says "If that address has an account, …".

| State | What shows |
| --- | --- |
| Waiting | "Check your email"; "We sent a link to {email}." (recovery: "If {email} has an account, a link is on its way."); the flow's line ("Open it on any device to finish signing up.", "… to get back into your account.", "… to confirm it's you.", "… to confirm your new address.") and "This page will update when you do."; the number and "Pick this number on the page the link opens." (recovery and step-up, whose pages ask the person to type it: "Type this number on the page the link opens.") when the host passes one; "Resend in {n}s", disabled, then "Resend link"; "Use a different email" when the host passes `onChangeEmail` |
| Sending | "Sending a new link…"; Resend busy, reading "Sending…"; "Use a different email" disabled; no error line |
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
| Ready, typed (`typeNumber`) | As Ready, but "Type the number shown on the screen where you started." labels one field for up to six digits, and Confirm, disabled until the field holds one to six digits, comes before "I didn't ask for this"; Enter in the field does what Confirm does |
| Confirming | The same; the control that started the call busy — the number tapped (its digits kept), Confirm ("Confirming…"), "I didn't ask for this" ("Cancelling…") or Try again ("Confirming…" or "Cancelling…", the same attempt again) — and every other one disabled (typed: the field too, still holding the entry); "You picked {n}. Confirming…" or "You typed {n}. Confirming…" after a number; after 10 seconds "This is taking longer than usual. Keep this page open." |
| Error | The same, the numbers (typed: the field) disabled and Confirm gone, "I didn't ask for this" still open; "You picked {n}." or "You typed {n}." after a number; "We couldn't confirm this email just now." or "We couldn't cancel this just now."; Try again, which sends the same attempt, while the decline sends `null` as a new one |
| Confirmed | "Confirmed"; "Go back to where you started to {finish}. You can close this page.", or "Continue to {finish}." and Continue when the host passes `onContinue` |
| Cancelled | "Cancelled"; "Nothing was confirmed. You can close this page." (step-up: "Nothing was confirmed. Someone else may be signed in to your account, so sign out your other sessions.") |
| Expired | "This link no longer works"; "It has expired or was already used. If you confirmed it already, go back to where you started and carry on. If not, go back and ask for a new link." (step-up adds "If you didn't ask for this link, someone else may be signed in to your account, so sign out your other sessions."). The same for every refusal, a list the page cannot offer included |

**`CreateProfileForm`** — Handle (`UsernameInput`), "Display name (optional)",
"Create profile" ("Creating…"), Cancel when the host gives `onCancel`.

**`ProfileOnboarding`** — shows only with a session, exactly one profile and
no earlier dismissal: the card "Add another profile", "Create profile", and
a dismiss control when `dismissible`.

**`ProfileSwitcher`** — a popover of the account's profiles with the active
one marked, a create dialog and a delete dialog (Delete, "Deleting…").

**`TurnstileWidget`** — renders nothing without a site key; with one, the
challenge, and "Couldn't load the verification challenge. Reload and try
again. …" when it fails to load.

## 7. Errors

**The sentence.** Every error a view shows comes from one of two helpers, and
never from the error itself: no `message`, no code, none of the browser's own
text (which in Chrome carries a URL).

- `describeAuthError(err, context?)` (`@osn/client`) — one sentence for a
  server answer or an ended session, read from the error's `status` and
  `code` and the form the person submitted: `code` (an emailed or app code),
  `recovery`, `details` (email, handle, date of birth), `passkey` or
  `new-passkey`. A `429` names the wait without a time ("Too many attempts.
  Wait a while, then try again."). Two failures the server answers alike read
  alike, so no line says whether an account exists or which of two inputs was
  wrong: `Register`'s send never says an email or handle is taken, and
  `RecoveryLoginForm` names the handle or email and the code together.
- `describePasskeyError(err, ceremony)` (this package) — one sentence for each
  way a WebAuthn ceremony fails, read from the error's `name` and the
  ceremony, `authentication` or `registration`; a server error in the same
  flow goes on to `describeAuthError` as `passkey` or `new-passkey`. A closed
  or timed-out prompt reads "That passkey didn't work. Try again." signing in
  and "The passkey wasn't added. Try again." adding one. `SignIn` and
  `StepUpDialog` pass `authentication`; `PasskeysView`, `Register` and
  `RecoveryLoginForm` (whose last step adds a passkey) pass `registration`.

The views add only sentences about their own checks: "Please complete the
verification challenge below.", "Please enter a valid email address",
"{productName} is for users 13 and older", "Enter the 6-digit code." in
`StepUpDialog`, and "A passkey can't be used here." when `StepUpDialog` has no
ceremony runner — which offers no retry, since none can work.

**The line.** Each error is a `@shared/ui` `Notice`, `tone="danger"`,
`size="inline"`, `alert`, so it is announced the moment it appears. Each
action clears its line before it runs, so a second failure mounts it again
and is announced again. Never inside a `<p>` or a `<label>`: `Notice` is a
`<div>`.

- **Under the field it is about**, tied to it: the line has an id and the
  field names it in `aria-describedby`, whatever the cause, so the field reads
  the same words for every one. The field is `aria-invalid` only when the
  input was the problem — a check this side ran, or a `400` or `422` refusal
  other than the verification check — never for a rate limit, an outage, a
  closed passkey prompt or an unfinished challenge (`src/error-lines.ts`). A
  field with a hint names both (`Register`'s date of birth: the hint, then the
  under-13 line). Fields tied this way: `SignIn`'s identifier; `Register`'s
  email and date of birth; `RecoveryLoginForm`'s handle or email and recovery
  code, its email address, and its authenticator step's handle or email;
  `PasskeysView`'s rename field; `ChangeEmailForm`'s email; `CreateProfileForm`'s
  handle; and every row of code boxes (below).
- **Above the action it follows** when no field owns it: `Register`'s send and
  enrolment, `RecoveryLoginForm`'s recovery-code, send and enrolment steps,
  `RecoveryCodesView`'s generate, `CreateProfileForm`'s submit, and the
  factor buttons in `StepUpDialog`. `Register`'s resend line sits under
  "Resend code"; `ProfileSwitcher`'s lines sit inside the popover and the
  delete dialog.
- **Under the heading** in `PasskeysView` (add, delete) and `TotpView` (start,
  remove), and in `SessionsView`; above the `SecurityEventsBanner` box, on
  the page's ground. Never on the warn wash: danger ink there measures 4.16:1
  in light, under the 4.5:1 text floor (`musubi/social/DESIGN.md` §Status
  colours).
- **Under the code boxes** for a refused code in `Register`,
  `RecoveryLoginForm` (both code steps), `TotpView`, `StepUpDialog` (both code
  steps) and `ChangeEmailForm`, tied to the row the same way: the line's id
  goes to `OtpInput`'s `aria-describedby`, which sets it on every box. The
  boxes' `aria-invalid` comes from `OtpInput`'s `status`: each view passes
  `error` only when the line's `FieldError` is `invalid`, so a wait or an
  outage ties the line without marking the code or painting the boxes' edge
  red. `RecoveryLoginForm`'s authenticator line is tied to its handle or email
  as well, since either may be what was refused.
- **Under its sentence** in `CheckEmailView`, which has no field: the host's
  `errorMessage`, a sentence from `describeAuthError`, as an alert of its own
  beside the view's status region. Resend is the action, and the line goes
  while it sends, so a second failure mounts it again.
- **Directly above Try again** in `ConfirmLinkPage`: a fixed line, never the
  thrown error's text. The page's polite `<output>`, which says its other
  changes, leaves the line to its own alert. It never says a number was wrong:
  a refused number shows the expired state, and the typed field is never
  marked invalid.

**How the tie meets `Field`.** Each field sits in a `Field`, which mints its id
and draws its label and any hint; the view passes it no `errors`. The control's
`aria-describedby` joins what `Field` hands it (the hint) with the line's id
(`describedBy`), and its `aria-invalid` comes from the line's `FieldError`.
`Field`'s own errors would mark every message invalid, a rate limit and an
outage included, and draw it as plain red text without the `Notice` mark.

`SignIn`'s passkey error ends with a "Lost your passkey?" button: the
signing-in sentence names no cause, and recovery is the way in without one.
The standalone link below Continue stays. Switching to the recovery form
leaves the sign-in error behind.

The handle field's own lines in `Register` and `CreateProfileForm` ("@x is
taken", the format rule, "Couldn't check availability") come from
`@shared/ui`'s `UsernameInput`, which draws them as plain `ui-danger` text
with no mark. They differ from the `Notice` lines beside them in that one
respect; `UsernameInput` is shared with `cire/host`, so it keeps its own
look.

**A failed load.** A list or status a settings view reads — `PasskeysView`,
`TotpView`, `SessionsView` — that fails to load shows `LoadFailed` in its
place instead of throwing: a lead in the view's words ("Your passkeys didn't
load."), the map's sentence only when it adds something (a `429` says to
wait, status `0` to check the connection, an ended session to sign in), and a
"Try again" that loads it again, left out once the session has ended. The
heading stays. `RecoveryCodesView` and `SecurityEventsBanner` already fail
soft (§6).

**Toasts are for success only** ("Signed in", "Verification code sent",
"Email verified", "Authenticator app added", …). No view raises an error
toast.

**The verification challenge.** Every call that spends a Turnstile token —
`SignIn`'s Continue, `Register`'s send and resend, `RecoveryLoginForm`'s
emailed-code send — asks the widget for a fresh token when it fails: the
server checks the token before it answers, so a refusal has spent it too.
Once the call is over the submit stays disabled until the widget hands over a
fresh one; while the call runs it stays busy, not disabled, though the widget
has already dropped the spent token. `SignIn` and `RecoveryLoginForm` reset
after a success as well. `Register` drops the spent
token after a success instead, since its widget goes with it: the details
step's when the code step opens, the code step's while "Resend code" counts
down. The code step mounts its own widget only once the countdown ends, so a
sign-up that never resends runs one challenge.

A recovery session that runs out is its own state in `RecoveryLoginForm`
("That recovery session timed out"), not an error line.

## 8. Step-up

`StepUpDialog` asks for a fresh factor before a gated action and hands the
host a short-lived token through `onToken`.

- **Structure.** A panel, not a `Dialog`: it renders in place, inside the view
  that opened it, as a `p-4` column (no side padding below `md`, §4) — the heading ("Confirm it's you", or
  `title`), "Re-authenticate {reason}." when `reason` is given, the line "This
  action needs a fresh authentication. Choose a method below." (left out with
  `passkeyOnly`), the error line, then the factors as full-width Buttons, the
  passkey first.
- **Factors.** A passkey always ("Use passkey"). An emailed code ("Email me a
  code") where the ceremony's `purpose` admits it and `passkeyOnly` is not set.
  An authenticator app ("Use your authenticator app") where the `purpose`
  admits it, the host passes `totpClient`, and the account has one
  (`GET /totp/status`; a failed read hides the factor, and so does one still
  out, read by `state` so the panel never joins its host's `Suspense`). By `purpose`:
  `passkey_delete` admits the passkey only; `email_change` the passkey and the
  emailed code; every other purpose, and no purpose, all three.
- **`passkeyOnly`** means the host cannot deliver mail: it removes the emailed
  code and nothing else, and starts the passkey ceremony as the panel mounts.
  Its full meaning is in
  [passkey-primary §What `passkeyOnly` means](../../wiki/osn/passkey-primary.md).
- **States.** Choosing a factor ("Use passkey" ("Waiting for your passkey…"),
  "Email me a code" ("Sending…")); waiting for the passkey with `passkeyOnly`
  (the line "Waiting for your passkey…" in place of the button, then "Try
  again" after an error); entering an emailed code ("Code" and its code
  boxes, Confirm ("Checking…")); entering an authenticator code ("Code from
  your authenticator app" and its code boxes, Confirm ("Checking…")). Each code
  step puts focus in its first box as it opens. Confirm is not disabled for a
  short code: it answers "Enter the 6-digit code.", marked invalid. Cancel is
  `disabled` while any of these calls runs (§6).
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

**As it stands.** The `@shared/ui` parts draw their own ring, and
`InlineAction` draws Button's (`focus-visible:ring-2
focus-visible:ring-ui-focus focus-visible:outline-hidden`). Every other
control the views draw by hand (§5) takes whatever outline its host's
stylesheet gives `:focus-visible`: in Musubi, the only host, a 2px
`--ui-focus` outline 2px off (`musubi/social/DESIGN.md` §Focus), which is not
the ring the rule above asks for: the profile rows in `ProfileSwitcher` and
the "Signing in somewhere new?" summary in `PasskeysView` (#2045).

`ProfileSwitcher`'s rows fade their colours with `transition-ui-colors`, the
host's utility (`musubi/social/src/App.css`), which leaves the outline out, so
their focus mark lands at once.

`CheckEmailView` draws no control by hand. Its heading takes focus from code
when the view appears, and when a send ends with Resend holding focus and the
wait disabling it (`tabindex="-1"`, so never by Tab); it draws no indicator
(`focus:outline-none`): it is where focus is put, not a control.

`Register` puts focus on the handle field when a wait ends because the handle
was taken: the waiting view that held focus is gone, and the handle field is
where the alert asks the person to act.

`ConfirmLinkPage` draws no control by hand either: its numbers, the decline,
Try again, Confirm and Continue are `@shared/ui` Buttons, which draw their own
ring, and its typed field is `@shared/ui`'s `Input`, whose ink fill draws a 2px
outline 2px off. Its
`h1` takes focus the same way, on mount and on every change, except that the
control that started a call keeps focus while it is busy; focus left on a
choice that disables, or in the typed field after Enter, goes to the `h1`, so
it never falls to `<body>`.

**Code boxes.** Every row of code boxes that opens its step takes `OtpInput`'s
`autofocus`, so focus is in box 1 as the step opens. `RecoveryLoginForm`'s
authenticator step does not, since its handle or email field comes first. A
refused code (`status` `error`) puts focus back in box 1 in every row. A refusal that says nothing about the code leaves focus where it
was: on the busy button that sent it, which kept focus through the wait. Only
`Register`'s code step is a form, where Enter in a box sends the code and the
boxes disable for the check: Chromium drops focus to the page, and WebKit can
leave it on the disabled box. After such a refusal `Register` puts focus back
in box 1 when focus is on the page or in the row, and nowhere else.
`ChangeEmailForm` does not yet: a refusal that is not about the code, after
the step-up, leaves focus on the page (#2056).

## 10. Words

**The rule.** The product's name comes from the host through `productName`
(the prop's TSDoc says so on each view that takes it); the package hard-codes
no product.

**As it stands:**

- `SignIn`, `Register`, `RecoveryCodesView` and `SecurityEventsBanner` take
  `productName`. No error line names a product: each is a sentence from §7's
  helpers or a view's own check.
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
  and conditional autofill. `passkey-errors.test.ts` drives the same library
  into each failure and checks the sentence `describePasskeyError` gives. Run
  `bun run --cwd osn/auth-ui test:run`.
- **No real-browser tier** in the package. **Lab stories** for
  `CheckEmailView`, `osn/auth-ui/CheckEmailView` in
  `tools/lab/src/stories/osn-auth-ui/check-email-view.story.tsx`: one per
  state, every flow, a 320px phone, and the number at rest, on recovery and
  step-up, across a resend and on a phone; and for `ConfirmLinkPage`,
  `osn/auth-ui/ConfirmLinkPage` in `confirm-link-page.story.tsx`: one per
  state, three and five numbers, the decline, step-up's expired page, an
  opening answer, every flow, a 320px phone, and the typed field ready, confirming, after an error,
  refused and on a 320px phone. The other views get theirs in #2045.
- **In the host.** `musubi/social/tests/styles/design-token-contract.test.ts`
  and `token-contract.browser.test.tsx` hold the mapping the shared parts
  inside the views render through. Musubi's component tests mock the views
  (`vi.mock("@osn/auth-ui/…")`) and check how the app wires them. The suites
  that run the real views are the end-to-end flows
  `tools/e2e/tests/flows/musubi-passkey.flow.ts` and
  `tools/e2e/tests/flows/musubi-register-retry.flow.ts`. `musubi-passkey`
  checks the error lines in Chromium: a sign-up code refused with a `429`
  leaves focus on Verify email when a click sent it, and puts it back in box 1
  when Enter in a box sent it; a wrong emailed code at sign-up reads
  the code sentence; a rate-limited sign-in reads the wait sentence, with
  "Lost your passkey?" inside the line, as the identifier field's accessible
  description, and with no toast. It also reads the shared parts the views
  draw, through `tools/e2e/tests/support/musubi-surfaces.ts`, each shot at 390
  and 1440px in both schemes: on opening the create-account dialog
  (`registerFieldSurfaces`), "Date of birth" a plain label 6px above its
  field and described by its hint, and Email's label row 6px above its field;
  on opening the sign-in dialog (`signInLinkSurfaces`), "Email or @handle" a
  plain label, and "Lost your passkey?" a 32px link at 500 in the accent ink,
  centred under Continue, underlined only under the pointer; with
  `/login/passkey/begin` held after Continue (`busyButtonSurfaces`), Continue
  reading "Verifying…", `aria-busy` and `aria-disabled` but not `disabled`,
  keeping focus, at 50% opacity, with one 20px orb, shot under reduced motion;
  on `/authorize` before signing in to Pulse (`authorizeSignInSurfaces`),
  "Create one" with no padding and one line tall, underlined 2px under, in its sentence's size and
  weight; with `GET /passkeys` held on Settings → Security
  (`securityLoadingSurfaces`), the passkey list's own `Skeleton` in a busy
  region, not Settings' fallback: the sunk well, an 8px corner, the pulse,
  still under reduced motion, and as tall as the passkey row that replaces
  it; and on the authenticator setup
  (`totpSetupSurfaces`), the spans over the setup key and the code boxes in
  the plain label's look, 6px above them, the boxes a group named "Code from
  the app" with box 1 focused after the step-up, and the row's width and each
  box's at 320 and 390px, shot at 320. It holds Register's send, verify and enrol calls, the step-up's
  passkey begin and the authenticator's confirm (`busyButtonHeld`): "Sending…",
  "Verifying…", "Setting up…", "Waiting for your passkey…" and "Checking…"
  each busy, not disabled, with focus kept, and Cancel (and "← Use a different
  email") disabled beside them.
- **Waits in the package tests.** `SignIn.test.tsx` holds Continue busy and
  not disabled while the passkey prompt is open, though the verification
  challenge has dropped its spent token. `Register.test.tsx` holds "Resend
  code" busy while it sends, and "Verify email" not busy (it is `disabled`
  while the resend runs, §6); with six digits in, a pending resend leaves
  Verify email and the code boxes disabled and the form's submit verifies
  nothing, and a pending verify leaves Resend disabled, not busy, and sending
  nothing. `ProfileSwitcher.test.tsx` holds Delete busy, not disabled, while
  the delete runs, and each row's delete beside its row button. The views no
  flow reaches hold each of their waits the same way, a second press sending
  nothing: `RecoveryLoginForm.test.tsx` (five, with Back disabled),
  `RecoveryCodesView.test.tsx`, `CreateProfileForm.test.tsx` (Cancel
  disabled), `ChangeEmailForm.test.tsx` (two), `StepUpDialog.test.tsx`
  ("Email me a code" and both Confirms), `CheckEmailView.test.tsx`
  (Resend, with "Use a different email" disabled) and
  `ConfirmLinkPage.test.tsx` (a number, Confirm, the decline and Try again,
  each with the other choices disabled).
- **Error lines in the package tests.** Each view's tests plant text in a
  thrown error's `message` and check it never reaches the screen, check a
  `429` reads the wait sentence, and check the line is an alert, tied to its
  field where it has one, with no error toast (`tests/helpers/errors.ts`).
  Each row of code boxes is found as a group named by its label
  (`tests/helpers/code.ts`), and a `400` and a `429` for each code check the
  line is in every box's `aria-describedby`, with every box `aria-invalid` for
  the `400` alone. `StepUpDialog.test.tsx` checks focus lands in box 1 as each
  code step opens. `Register.test.tsx` checks a `429` sent with Enter from
  box 6, with focus kept on that box as WebKit keeps it, ends with focus in
  box 1.
- **Loading in the package tests.** `PasskeysView`, `TotpView`,
  `RecoveryCodesView` and `SessionsView` mounted under a `Suspense` whose
  fallback is the host's show their own placeholder, never the host's, while a
  read is out, and `StepUpDialog` its factors while `GET /totp/status` is out.
  `RecoveryCodesView` and `SessionsView` hold the placeholder in a busy region
  until the first read lands, and `RecoveryCodesView` keeps its count through
  the read after Done. `PasskeysView` and `SessionsView` disable every action
  while the list is read again after a delete or a revoke.
- **Layout in Musubi's browser tests.**
  `musubi/social/tests/components/SecurityStepUp.browser.test.tsx` opens the
  step-up's emailed-code step in Settings → Security: at 320px its row of code
  boxes is the card's whole column (246px) with no box under 37px, and every
  button in the card stays inside it; at 1440px the row sits inside the
  panel's 16px padding. Shots at both widths, light and dark, in
  `e2e-artifacts/musubi-settings/`.
  `musubi/social/tests/components/CheckEmailView.layout.browser.test.tsx`
  renders `CheckEmailView`, which no flow reaches yet, in Musubi's auth sheet
  and holds its layout at 320px and 1280px (the long address, the countdown on
  one line, the 40px and 32px buttons, and the six-digit number at 24px in
  tabular figures with its label read first). No flow reaches
  `ConfirmLinkPage` yet either;
  `musubi/social/tests/components/ConfirmLinkPage.layout.browser.test.tsx`
  renders it on a bare route in Chromium and holds, at 320px, five six-digit
  numbers and a long address with nothing to scroll sideways, and at 320px and
  1280px the numbers one under another, at least 44px tall in 24px tabular
  figures, the decline and Try again at 44px below `md`, the error notice above
  Try again, and the typed field, Confirm and the decline inside the card at
  44px or more, the field at 16px with an edge of at least 3:1 and a plain
  label 6px above it.

## 12. Motion

The package has no motion of its own. A view takes its host's: in Musubi, colour
and opacity transitions only (`musubi/social/DESIGN.md` §Motion). The host's
`transition-ui-colors` utility fades colours and leaves the outline out, so a
control's focus mark lands at once (§9). A view draws two animations, both
from `@shared/ui` parts: a busy button's `Orb`, and `Skeleton`, the loading
placeholder in `PasskeysView`, `TotpView`, `SessionsView` and
`RecoveryCodesView`, which pulses in opacity. Both stand still under reduced
motion. What a skeleton stands for, a refused code's line and a step that
replaces another arrive at once, with no fade (`musubi/social/DESIGN.md`
§Motion).
As it stands, `ProfileOnboarding` and `ProfileSwitcher` open `@shared/ui`'s
`Dialog`, which still scales as it opens and closes (`musubi/social/DESIGN.md`
§Motion, #2040). A view
never moves a panel, a field or an error across the screen, and never loads an
animation library. A motion a view needs that the host does not have goes into
the host's `DESIGN.md` first.
