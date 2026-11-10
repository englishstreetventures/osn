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
(`ChangeEmailForm`, `CreateProfileForm`, `PasskeysView`, `ProfileOnboarding`,
`ProfileSwitcher`, `RecoveryCodesView`, `Register`, `SecurityEventsBanner`,
`SessionsView`, `SignIn`, `StepUpDialog`, `TotpView`) and a barrel,
`src/index.ts`, which also carries `RecoveryLoginForm`, `TurnstileWidget`,
`turnstileEnabled` and the `RunPasskeyCeremony` / `RunPasskeyRegistration`
types.

**Hosts today.** `@musubi/social` is the one workspace that depends on the
package. Its `DESIGN.md` §Auth surfaces says where each view mounts and what
the app supplies ([musubi/social/DESIGN.md](../../musubi/social/DESIGN.md)).
Three views mount in no app: `SessionsView` (#2055), `ChangeEmailForm`
(#2056) and `ProfileSwitcher` (#2045). Only their package tests render them.

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
through the contract. The views' own classes do not yet (#2045). They name the
shadcn colour vocabulary — `text-foreground`, `text-muted-foreground`,
`text-destructive`, `text-primary`, `text-accent-foreground`, `bg-muted`,
`bg-accent`, `border-border` — Tailwind's default type steps and
weights (`text-xs`, `text-sm`, `text-lg`, `text-2xl`, `font-semibold`,
`font-bold`) and Tailwind's own radii (`rounded-md`, `rounded`). So the views
render as intended only in a host that defines that vocabulary. The `ui-*`
utilities the views write themselves today: `text-ui-success` (`Register`),
`border-ui-warn/40 bg-ui-warn/10` (`SecurityEventsBanner`), `text-ui-xs`
(`ProfileSwitcher`), and the plain label's `text-ui-ink text-ui-base` on the
spans over a row of code boxes (§4). Every error line is a `@shared/ui` `Notice`, so it
paints `ui-danger` through the contract (§7).

**Status roles in use.**

- `ui-success` — ink for a confirmed good state: the "Accepted" line after an
  email code in `Register`, and the shared parts' own success states
  (`UsernameInput`, `OtpInput`).
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
| Codes | `font-mono` | `RecoveryCodesView`'s list, `TotpView`'s setup key; the code fields in `ChangeEmailForm` and `StepUpDialog` are `Input` with `face="code"`, the contract's mono face and wide tracking |

The `@shared/ui` parts inside the views (Button, Field, Input, Label,
OtpInput, Card and Dialog titles) take the contract steps.

## 4. Layout

As built:

- **Dialog views** (`SignIn`, `Register`) carry their own column,
  `mx-auto max-w-sm px-4 py-8`, inside whatever frame the host gives them: a
  header row with the view's heading and its Cancel, then one step at a time
  as a `flex-col gap-4` stack. Each field is `@shared/ui`'s `Field` with a
  plain label (`labelTreatment="plain"`), 6px above the control. The two
  labels `Field` does not draw sit 6px above their controls too: `Register`'s
  Email, a bare `Label` beside its "i", and the span over a row of code boxes
  (`RecoveryLoginForm`, `TotpView`), which takes the plain label's classes
  (`text-ui-ink text-ui-base leading-none font-medium`) because six boxes have
  no one id for a `<label for>` (#2041).
  The primary Button spans the column; a standalone link under it sits centred
  (§5).
- **Settings panels** (`PasskeysView`, `TotpView`, `SessionsView`) are a
  `flex-col gap-3` section: a header row with the heading and, on the right,
  the panel's action (a `size="sm"` Button in `PasskeysView` and `TotpView`,
  an `outline` Button at the default size in `SessionsView`); then the list,
  each row a bordered `rounded-md` box with a name, a meta line and `outline`
  `sm` actions. `RecoveryCodesView` draws no heading; its host gives it one.
  The rows' `border` names no colour, so the host decides it: Musubi's base
  rule draws the hairline, `--border`.
- **`ChangeEmailForm`** is the same `flex-col gap-3` column: its heading, then
  one phase at a time. The email and code phases are each a `Field` over a
  full-width Button; the step-up phase is `StepUpDialog`'s panel, and
  the last a single line.
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
| `SignIn` | Button, Field, Input, Notice | `ghost`, `secondary`, `link` |
| `Register` | Button, Field, InfoPopover, Input, Label, Notice, OtpInput, UsernameInput | `ghost`, `link` |
| `RecoveryLoginForm` | Button, Field, Input, Notice, OtpInput | `outline`, `ghost` |
| `StepUpDialog` | Button, Field, Input, Notice | `outline`, `ghost` |
| `PasskeysView` | Button, Input, Notice | `outline`, `ghost` |
| `TotpView` | Button, Field, Input, Notice, OtpInput, QrCode | `outline`, `ghost` |
| `RecoveryCodesView` | Button, Checkbox, Dialog, Notice | `outline`, `ghost` |
| `SessionsView` | Button, Notice | `outline` |
| `SecurityEventsBanner` | Button, Notice | `outline` |
| `ChangeEmailForm` | Button, Field, Input, Notice | — |
| `CreateProfileForm` | Button, Field, Input, Notice, UsernameInput | `ghost` |
| `ProfileOnboarding` | Button, Card, Dialog | `ghost` |
| `ProfileSwitcher` | Avatar, Button, Dialog, Notice, Popover | `ghost`, `ghostDanger`, `destructive` |
| `TurnstileWidget` | Notice | — |

**Drawn by hand.** Besides those parts, the views draw these controls
themselves:

- Text `<button>`s: each profile row in `ProfileSwitcher`, with the chosen
  row marked by the accent wash and a ✓ (#2045). The row's delete is a
  `ghostDanger` icon `Button` beside the row's button, never inside it: a
  button inside a button has no reliable name or keyboard path.
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
the button that started the call is busy; the view's other actions are
`disabled` meanwhile, and each button's other reasons to be `disabled` apply
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

**`PasskeysView`** — heading "Passkeys" with "Add passkey". States: loading
("Loading…"); failed to load ("Your passkeys didn't load.", §7); the list, each row the passkey's name ("Synced passkey" or
"Device passkey" when unnamed, "(synced)" when backed up), "Added … · Last
used …", Rename and Delete; a row being renamed (a field, Save, Cancel); a
step-up in progress, which disables every row's actions. Under the list, a
"Signing in somewhere new?" disclosure.

**`TotpView`** — heading "Authenticator app", then "A six-digit code from an
app on your phone. …". States: loading; failed to load ("Your authenticator
app didn't load.", §7); none set up ("Add an authenticator
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
States: loading; failed to load ("Your sessions didn't load.", §7); the list,
each row the device ("Unknown device" when
unnamed, "(this device)" on the current one), "Created … · Last used …",
Revoke (disabled on the current one).

**`ChangeEmailForm`** — heading "Change email". Phases: new email ("New email",
"Send verification code"); code ("We sent a 6-digit code to {email}. Enter it
below to continue.", "Code", "Confirm identity & change email"); step-up, on
the first Confirm, after which the change completes; done ("Your email is now
{email}.").

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
  `StepUpDialog`'s two code fields; `PasskeysView`'s rename field; both of
  `ChangeEmailForm`'s fields; `CreateProfileForm`'s handle.
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
  `RecoveryLoginForm` and `TotpView`: announced, but not yet tied — `OtpInput`
  takes no `aria-describedby` until englishstreetventures/osn#2041.

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
- Going back: Cancel, Back, "Back to sign in", "← Use a different email",
  "Start again".

## 11. Tests

As built:

- **Package tests** — `osn/auth-ui/tests/`, one file per view, each under
  happy-dom (`// @vitest-environment happy-dom`), plus
  `webauthn-browser.test.ts`, which runs the real `@simplewebauthn/browser`
  against a stubbed `navigator.credentials` for registration, authentication
  and conditional autofill. `passkey-errors.test.ts` drives the same library
  into each failure and checks the sentence `describePasskeyError` gives. Run
  `bun run --cwd osn/auth-ui test:run`.
- **No real-browser tier and no lab stories** for the package yet (#2045 adds
  the lab).
- **In the host.** `musubi/social/tests/styles/design-token-contract.test.ts`
  and `token-contract.browser.test.tsx` hold the mapping the shared parts
  inside the views render through. Musubi's component tests mock the views
  (`vi.mock("@osn/auth-ui/…")`) and check how the app wires them. The suites
  that run the real views are the end-to-end flows
  `tools/e2e/tests/flows/musubi-passkey.flow.ts` and
  `tools/e2e/tests/flows/musubi-register-retry.flow.ts`. `musubi-passkey`
  checks the error lines in Chromium: a wrong emailed code at sign-up reads
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
  and on `/authorize` before signing in to Pulse (`authorizeSignInSurfaces`),
  "Create one" with no padding and one line tall, underlined 2px under, in its sentence's size and
  weight.
- **Waits in the package tests.** `SignIn.test.tsx` holds Continue busy and
  not disabled while the passkey prompt is open, though the verification
  challenge has dropped its spent token. `Register.test.tsx` holds "Resend
  code" busy while it sends, and "Verify email" not busy (it is `disabled`
  while the resend runs, §6); with six digits in, a pending resend leaves
  Verify email and the code boxes disabled and the form's submit verifies
  nothing, and a pending verify leaves Resend disabled, not busy, and sending
  nothing. `ProfileSwitcher.test.tsx` holds Delete busy, not disabled, while
  the delete runs, and each row's delete beside its row button.
- **Error lines in the package tests.** Each view's tests plant text in a
  thrown error's `message` and check it never reaches the screen, check a
  `429` reads the wait sentence, and check the line is an alert, tied to its
  field where it has one, with no error toast (`tests/helpers/errors.ts`).
