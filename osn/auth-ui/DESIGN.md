# Design — @osn/auth-ui

The design rules for `@osn/auth-ui`, the sign-in, registration, step-up and
account-security views of OSN. Read this file before changing how any of
these views looks. Rules are written in the `ui-*` contract of
`@shared/design-tokens`, never in one host's utilities, because the package
belongs to OSN-the-system and not to any one app
([osn-and-musubi](../../wiki/shared/osn-and-musubi.md)).

Each section gives the rule, then what the code does where the two differ,
with the issue that brings the code to the rule.

## 1. Scope and hosts

**What the package exports.** One subpath per view in `package.json`
(`ChangeEmailForm`, `CheckEmailView`, `ConfirmLinkPage`, `CreateProfileForm`, `PasskeysView`, `ProfileOnboarding`,
`RecoveryCodesView`, `Register`, `SecurityEventsBanner`,
`SessionsView`, `SignIn`, `StepUpDialog`, `TotpView`), one for `AuthHeader`,
the title row the sign-in and create-account views share, and a barrel,
`src/index.ts`, which also carries `RecoveryLoginForm`, `TurnstileWidget`,
`turnstileEnabled` and the `RunPasskeyCeremony` / `RunPasskeyRegistration`
types.

**Hosts today.** `@musubi/social` is the one workspace that depends on the
package. Its `DESIGN.md` §Auth surfaces says where each view mounts and what
the app supplies ([musubi/social/DESIGN.md](../../musubi/social/DESIGN.md)).
Two views mount in no app: `SessionsView` (#2055) and `ChangeEmailForm`
(#2056). Only their tests and lab stories render them. Musubi's profile
switcher is its own (`ProfileSwitcherDialog`); the package draws none.

**What a host supplies.**

- The stylesheet: `@shared/design-tokens/tokens.css`, which carries the
  `@source` for `osn/auth-ui/src`, so the views' classes compile in the host;
  and a `:root` block mapping every `--ui-*` role (§2). Nothing else: no view
  names a host's own vocabulary.
- A `Toaster` from `@shared/toast`, for the views that call `toast`.
- `AuthProvider` from `@osn/client/solid`, for the views that call `useAuth`.
- The `Dialog` that frames `SignIn` and `Register` (with `host="dialog"`);
  neither draws one, and each names it through its `AuthHeader`, so the
  host's `DialogContent` takes no `aria-label`. On a page (`host="page"`)
  the view draws no frame and no side padding. `StepUpDialog` draws its own
  (§8): a host mounts it when an action needs it and removes it on `onToken`
  or `onCancel`.
- Per view:

| View | Props a host passes | Context it reads |
| --- | --- | --- |
| `SignIn` | `client` (`LoginClient`), `recoveryClient`, `productName`, `host` (`"dialog"` or `"page"`); `registrationClient` and `runPasskeyRegistration` (both, or recovery offers the recovery code only); `turnstileSiteKey`; `onSuccess`, `onCancel`, `cancelLabel` | `AuthProvider`, `Toaster`; the `Dialog`'s context with `host="dialog"` |
| `Register` | `client` (`RegistrationClient`), `productName`, `host`, `onCancel`; `cancelLabel`, `turnstileSiteKey`; `onSuccess` | `AuthProvider`, `Toaster`; the `Dialog`'s context with `host="dialog"` |
| `RecoveryLoginForm` | `client` (`RecoveryClient`); `registrationClient` and `runPasskeyRegistration`; `turnstileSiteKey`; `onSuccess`, `onCancel` | `AuthProvider` |
| `PasskeysView` | `client`, `stepUpClient`; `profileId` and `runPasskeyRegistration` (both, or "Add a passkey" is hidden); `runPasskeyCeremony`, `totpClient` | — |
| `TotpView` | `client` (`TotpClient`), `stepUpClient`; `runPasskeyCeremony` | `Toaster` |
| `RecoveryCodesView` | `client`, `stepUpClient`, `productName`; `runPasskeyCeremony`, `totpClient`, `onSaved` | — |
| `SecurityEventsBanner` | `client`, `stepUpClient`, `productName`; `runPasskeyCeremony`, `totpClient`, `onVisibleCountChange` | — |
| `SessionsView` | `client` | — |
| `ChangeEmailForm` | `accountClient`, `stepUpClient`; `runPasskeyCeremony`, `onChanged` | — |
| `CheckEmailView` | `purpose`, `status`, `onResend`; `email`, `errorMessage`, `onChangeEmail`, `resendWaitSeconds`, `pairingCode` (the host's rules for each are in [component-library §CheckEmailView](../../wiki/shared/component-library.md)) | — |
| `ConfirmLinkPage` | `purpose`, `onConfirm`, and one of `candidates`, `typeNumber` (recovery, step-up) or `initialOutcome`; `email`, `onContinue` (the host's rules for each are in [component-library §ConfirmLinkPage](../../wiki/shared/component-library.md)) | — |
| `StepUpDialog` | `client`, `onToken`, `onCancel`; `runPasskeyCeremony`, `totpClient`, `passkeyOnly`, `title`, `reason`, `warning`, `purpose` | — |
| `AuthHeader` | `title`, `host` (`"dialog"` or `"page"`); `onCancel`, `cancelLabel`, `cancelDisabled` | the `Dialog`'s context, with `host="dialog"` |
| `CreateProfileForm` | `checkHandle`, `onSuccess`, `onCancel` | `AuthProvider`, `Toaster` |
| `ProfileOnboarding` | `checkHandle`, `dismissible` | `AuthProvider`, `Toaster` (through `CreateProfileForm`) |
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

**As built.** Every view follows the rule: the `@shared/ui` parts render
through the contract, and the views' own classes are `ui-*` utilities alone —
`text-ui-ink`, `text-ui-ink-secondary`, `text-ui-accent-ink`,
`bg-ui-surface-sunk`, `border-ui-hairline`, `rounded-ui-sm`, `rounded-ui-md`,
`font-ui-mono`, `font-ui-title`, the `text-ui-*` steps and `leading-ui-snug`
— with weights no heavier than `font-medium`. `tests/token-contract.test.ts`
holds it: it fails on any class in a view that names a host's colour (the
shadcn names on every colour prefix, with variants and opacity), a Tailwind
palette colour, a Tailwind type step, a weight above 500, a Tailwind radius,
an arbitrary value, or a checkbox the view draws itself.

**Status roles in use.**

- `ui-success` — ink for a confirmed good state: the shared parts' own success
  states (`UsernameInput`, `OtpInput`).
- `ui-warn` — a border and a wash: the `SecurityEventsBanner` box, with the
  ink left alone (musubi D17); and `Notice tone="warn"`, ink included, for
  `RecoveryCodesView`'s line when an account has no recovery codes.
- `ui-info` — `Notice tone="info"` for a blocker that stops a flow here: no
  WebAuthn in `SignIn` and `Register`, and `RecoveryLoginForm`'s ways back in
  that need a passkey ceremony.
- `ui-danger` — ink for a failure: every view's error line, drawn by
  `Notice` (`tone="danger"`).
- `ui-accent-ink` — "(this device)" in `SessionsView`.

## 3. Type

**The rule.** Sizes come from the contract's `text-ui-*` steps (`xs`, `sm`,
`base`, `md`, `lg`, `xl`, `2xl`); a host maps those to its own scale.

**As built** (in Musubi's map: `xs` 12px, `sm` 13px, `base` and `md` 14px,
the title weight 500):

| Role | Classes | Where |
| --- | --- | --- |
| Title of a sign-in or create-account view | `AuthHeader`: `DialogTitle` in a dialog, an `h2` in its classes on a page | `SignIn`, `Register` |
| Heading of a panel | `text-ui-ink text-ui-md font-ui-title`, `DialogTitle`'s and `CardTitle`'s look | `PasskeysView`, `TotpView`, `SessionsView`, `ChangeEmailForm` |
| Heading of a step inside a view | `text-ui-ink text-ui-base font-medium` | `RecoveryLoginForm`'s `enrol`, `enrolled` and `expired` steps; `TotpView`'s "Scan this with your authenticator app"; `CheckEmailView`, `ConfirmLinkPage` |
| Body copy | `text-ui-sm leading-ui-snug text-ui-ink-secondary` | the views' own paragraphs and lines; a done line ("Your email is now …") in `text-ui-ink` |
| Meta lines (dates, "(synced)") | `text-ui-xs text-ui-ink-secondary` | the list rows, the banner |
| "(this device)" | `text-ui-xs text-ui-accent-ink` | `SessionsView` |
| Field hints | `Field`'s hint, `text-ui-xs` in the secondary ink | `Register`'s date of birth |
| Names in a row | `text-ui-ink text-ui-base font-medium`; the banner's headlines `text-ui-sm` | `PasskeysView`, `TotpView`, `SessionsView`, `SecurityEventsBanner` |
| Codes | `font-ui-mono text-ui-sm` | `RecoveryCodesView`'s list, `TotpView`'s setup key. Every six-digit code is typed into `OtpInput`'s boxes, at the contract's `text-ui-md`, which Musubi maps to its title step (14px from 768px; its mobile input rule keeps 16px below). `RecoveryLoginForm`'s recovery code, 16 characters in four groups, is an `Input` in a `Field` |

The `@shared/ui` parts inside the views (Button, Field, Input, Label,
OtpInput, Card and Dialog titles) take the contract steps.

`StepUpDialog` follows the rule. Its title is `DialogTitle` (`text-ui-md` at
the contract's title weight); its warning or reason is `DialogDescription`, and
its other lines take `DialogDescription`'s look, `text-ui-base` in the
secondary ink, so every line above the step reads as one. A call site may not
restyle `DialogDescription` (`shadcn/no-restyle`).

`AuthHeader` follows the rule. In a dialog its title is the dialog's
`DialogTitle`; on a page it is an `h2` with `DialogTitle`'s classes,
`text-ui-ink text-ui-md font-ui-title`, so the title reads the same in both
hosts: 14px at 500 in Musubi. The page's own heading above it leads. Both
hosts' titles break anywhere (`wrap-anywhere`) rather than widen the row, since the title
carries the host's product name. `DialogTitle`
(`shared/ui/src/ui/dialog.tsx`) is the one source of those classes; a change
there is copied to the page's `h2`.
`musubi/social/tests/components/AuthHeader.browser.test.tsx` fails when the
two titles' computed font, size, weight, line height, letter spacing or colour
differ, in light and dark (§11), and the lab's `BothHosts` story draws the two
on one sheet.

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

- **Sign-in views** (`SignIn`, `Register`) take the host's width and draw
  no frame: their `AuthHeader` (below), then the body. In a dialog the body
  is padded 16px (`p-4`) under the header's hairline; on a page it has no
  side padding and sits 24px under the header (`pt-6`), so `/authorize`'s
  column sets the width. The body is one step at a time as a `flex-col
  gap-4` stack. `RecoveryLoginForm` sits in `SignIn`'s body and draws no
  title of its own, so the dialog keeps one name. Each field is `@shared/ui`'s `Field` with a
  plain label (`labelTreatment="plain"`), 6px above the control. The two
  labels `Field` does not draw sit 6px above their controls too: `Register`'s
  Email, a bare `Label` beside its "i", and the span over a row of code boxes
  (`RecoveryLoginForm`, `TotpView`, `StepUpDialog`, `ChangeEmailForm`), which
  takes the plain label's classes from `labelVariants()`
  (`@shared/ui/ui/label`) because six boxes have no one id for a
  `<label for>`. The span carries an id from `createUniqueId()`, and the boxes
  name their group by it (`aria-labelledby`), so box N reads "<label> Digit
  N". `TotpView`'s "Or enter this setup key by
  hand" is the same span over its key.
  The primary Button spans the column; a standalone link under it sits centred
  (§5).
- **Settings panels** (`PasskeysView`, `TotpView`, `SessionsView`) are a
  `flex-col gap-3` section: a header row with the heading and, on the right,
  the panel's action (a `size="sm"` Button in `PasskeysView` and `TotpView`,
  an `outline` Button at the default size in `SessionsView`), which wraps
  under the heading, 8px below it, when the two do not fit on one line
  ("Add an authenticator app" at 320px); then the list.
  Each row is `@shared/ui`'s `Card` with `radius="md"` and `padding="sm"`
  inside its `li`: the card's fill, the hairline edge, 8px corners and 16px
  inside. A panel is drawn for a host card (Settings' section), so its rows
  are nested and take the nested corner; a row standing alone on a page
  would take `Card`'s own 16px (musubi D11). A row holds a name, two meta
  lines ("Added …" or "Created …", then "Last used …", one each, so a long
  date never wraps into a third) and `outline` `sm` actions. From `md` the
  actions sit at the row's end beside the words; below `md` they sit under
  them, 12px down, at the start, 40px tall (`max-md:h-10`), so the words get
  the card's whole width on a phone. The words give way (`min-w-0 flex-1`)
  and the name breaks inside a word (`wrap-break-word`), so `PasskeysView`'s
  64-character name, or `SessionsView`'s device line, wraps and keeps the
  actions inside the card at 320px. A row in rename swaps its name for `Input` at `size="sm"` with
  Save and Cancel. `RecoveryCodesView` draws no heading; its host gives it
  one. Its new codes sit in a well, `Card variant="muted" radius="md"
  padding="sm"`, two columns of `font-ui-mono`; the "I've saved these
  codes" `Checkbox` is the drawn 16px box at `size="sm"`, in a row 44px tall
  below `md` (`max-md:min-h-11`). `TotpView`'s enrolment step is a
  `rounded-ui-md` box with the hairline edge and 16px inside at `md` and up,
  and drops the edge and padding below `md`, so its code boxes take the
  panel's whole column on a phone (`musubi/social/DESIGN.md` §Responsive
  layout). It is a step, not a row, so it is no `Card`: `Card` cannot drop
  its edge below `md`. Its setup key sits on `bg-ui-surface-sunk` at
  `rounded-ui-md`.
- **A first load's placeholder** stands for one row whose words take one
  line each (`RowPlaceholder`, internal): 92px from `md` (three 18px lines
  in Musubi) and 144px below it, where the 40px actions sit under the words.
  `Skeleton` takes its height inline, so each width draws its own block. A
  row whose name wraps is taller than its placeholder.
- **`ChangeEmailForm`** is the same `flex-col gap-3` column: its heading, then
  one phase at a time. The email phase is a `Field` over a full-width
  Button; the wait is `CheckEmailView`; the step-up phase opens
  `StepUpDialog`'s sheet; finishing and done are a single line each.
- **`CheckEmailView`** is a `flex-col gap-4` column for a step inside a dialog:
  its `h3`; the sentence in its live region, with any error line 8px under
  it (`flex-col gap-2`); the line about opening the link; when there is one, the number over its caption
  (`flex-col gap-1`), unboxed; then Resend and "Start again" as
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
- **The banner** (`SecurityEventsBanner`) is one `rounded-ui-md` box with
  the warn border and wash and 12px inside: each event as a headline and a
  meta line, a footer line, and Acknowledge (`outline`, `sm`) at the right.
  It is the one message box the package draws by hand: `Notice tone="warn"`
  would paint the words warn too, and Musubi keeps them in its ink (D17).
- **Step-up** (`StepUpDialog`) is `@shared/ui`'s `Dialog` with
  `DialogContent presentation="sheet"` (§8): a bottom sheet as wide as the
  screen below `md`, a centred card capped at 384px (`md:max-w-sm`) from `md`,
  the default cap of Musubi's dialogs (`ResponsiveDialogContent`'s
  `width="sm"`). A `DialogHeader` holds the `DialogTitle`, whose text breaks
  anywhere (`wrap-anywhere`), since it may carry a passkey's name of up to 64
  characters with no space;
  under it a `flex-col gap-3 p-4` body: the warning, the reason, the
  choose-a-method line, the error line, then the step as a `flex-col gap-2`
  column of full-width Buttons. Its code boxes take the body's column: 288px
  at a 320px viewport, so each box is at least 40px (`musubi/social/DESIGN.md`
  §Responsive layout, Code boxes). Every button is 40px tall below `md`
  (`max-md:h-10`). "Use another method" is a standalone link, centred under
  the step's own action (§5).
- **`AuthHeader`** is the title row of a sign-in or create-account view,
  and `SignIn` and `Register` each draw exactly one. In
  a dialog (`host="dialog"`) it is a `DialogHeader` — 16px padding, a
  hairline under it, `gap-3` — holding the `DialogTitle` and Cancel. On a
  page (`host="page"`, `/authorize`) it is the same row with no padding or
  rule (`flex items-center justify-between gap-3`), and the view sets the
  space below it. The title comes first and wraps; Cancel sits at the row's
  end, `sm`, 40px tall below `md` (`max-md:h-10`), and never shrinks. A
  dialog holds one `AuthHeader` at a time: Kobalte gives every `DialogTitle`
  in one dialog the same id, so with two mounted, the dialog loses its name
  when either goes. A view whose title changes (`SignIn`'s "Recover your
  account") passes the new `title` to the header it has, and a step inside a
  view mounts no second one.
- **Dialogs a view opens itself** — `ProfileOnboarding`'s "Create a new
  profile" and `RecoveryCodesView`'s "Generate a new set?" — use
  `@shared/ui`'s `DialogContent` with `presentation="sheet"`, capped at
  384px from `md` (`md:max-w-sm`) as the step-up sheet is: a bottom sheet
  below `md`, a centred card from it. Each has a `DialogHeader` and
  `DialogTitle`, a `p-4` body and, where there are actions, a
  `DialogFooter`. Its dismiss button is `secondary` (musubi D13):
  "Generate a new set?"'s Cancel, and `CreateProfileForm`'s Cancel, whose
  one host is that dialog. A Cancel inside a view that closes no dialog
  (rename, `TotpView`'s enrolment) stays `ghost`.
- **`ProfileOnboarding`** is a `Card` titled "Add another profile".

## 5. Parts

The `@shared/ui` parts each view imports, and the Button variants it uses
besides the default:

| View | Parts | Button variants |
| --- | --- | --- |
| `SignIn` | Button, Field, Input, Notice; `AuthHeader` | `secondary`, `link` |
| `Register` | Button, Field, InfoPopover, Input, Label, Notice, UsernameInput; `AuthHeader`; `CheckEmailView` for the wait | — |
| `RecoveryLoginForm` | Button, Field, Input, Notice, OtpInput; `CheckEmailView` for the emailed link's wait | `outline`, `ghost` |
| `StepUpDialog` | Button, Dialog, Notice, OtpInput; `CheckEmailView` for the emailed link's wait | `outline`, `secondary`, `link` |
| `AuthHeader` | Button, Dialog (`DialogHeader`, `DialogTitle`) | `secondary` (Cancel in a dialog, as every dialog's dismiss button), `ghost` (Cancel on a page, where it switches views and dismisses nothing) |
| `PasskeysView` | Button, Card, Input, Notice, Skeleton | `outline`, `ghost` |
| `TotpView` | Button, Card, Field, Input, Notice, OtpInput, QrCode, Skeleton | `outline`, `ghost` |
| `RecoveryCodesView` | Button, Card, Checkbox, Dialog, Notice, Skeleton | `outline`, `secondary` |
| `SessionsView` | Button, Card, Notice, Skeleton | `outline` |
| `SecurityEventsBanner` | Button, Notice | `outline` |
| `ChangeEmailForm` | Button, Field, Input, Notice; `CheckEmailView` for the new address's link, `StepUpDialog` | — |
| `CheckEmailView` | Button, Notice | `ghost` |
| `ConfirmLinkPage` | Button, Card, Field, Input, Notice | `outline`, `ghost` |
| `CreateProfileForm` | Button, Field, Input, Notice, UsernameInput | `secondary` |
| `ProfileOnboarding` | Button, Card, Dialog | `ghost` |
| `TurnstileWidget` | Notice | — |

**Drawn by hand.** Besides those parts, the views draw these controls
themselves:

- `InlineAction` (`src/InlineAction.tsx`, internal): the button that ends an
  error line — "Lost your passkey?" in `SignIn`'s passkey error, "Try again"
  in a failed load. It keeps the line's ink and is underlined, so the action
  never relies on colour alone, and takes Button's focus ring (§9).
  `LoadFailed` (`src/LoadFailed.tsx`, internal) is the failed-load line built
  on it (§7).
- A `<details>` disclosure, "Signing in somewhere new?", under the list in
  `PasskeysView`; its `<summary>` takes Button's ring (§9).
- The `SecurityEventsBanner` box (§4).

**Links.** A link standing alone is Button's `link` at `sm`: `text-ui-sm` (13px
in Musubi) at 500 in the accent ink, a 32px box with 12px sides, underlined
only under the pointer,
centred under the action it follows (`self-center`) so no column edge sits
12px off its words. Two: "Lost your passkey?" under `SignIn`'s Continue, and
"Use another method" under the step-up's emailed-link wait and its Confirm,
40px tall below `md` there as every button in the sheet is.
`InlineAction`, above, is the
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

**`AuthHeader`** — the title the view passes, with Cancel when the host
passes `onCancel` and none otherwise. Cancel is `disabled` while
`cancelDisabled` is set: the view sets it while a call it started runs, as
above. Cancel calls `onCancel` and closes nothing itself; in a dialog,
Escape and a press outside reach the host's `onOpenChange` instead, which
runs the same handler only if the host routes it there.

**`SignIn`** — title "Sign in to {productName}", or "Recover your account"
in the recovery view, through its one `AuthHeader`, with Cancel when the host
passes `onCancel` (disabled while the passkey call runs).

| State | What shows |
| --- | --- |
| Passkey form | "Email or @handle", the Turnstile challenge when a site key is set, Continue ("Verifying…" while busy), "Lost your passkey?" |
| No WebAuthn | An info `Notice`, "{productName} sign-in needs a passkey or security key, and this browser doesn't support WebAuthn."; "You can either:" and three ways forward; "Use a recovery code instead" (`secondary`) |
| Recovery | `RecoveryLoginForm` |
| Signed in | "You're all set." |

While the passkey form shows, a discoverable-credential sign-in runs in the
background where the browser offers passkey autofill; it shows nothing of its
own.

**`Register`** — heading "Create your {productName} account".

| State | What shows |
| --- | --- |
| No WebAuthn | "Creating an account on {productName} needs a passkey or security key — something this browser doesn't support. …" |
| Details | Email (with an "i" popover, "What this address is used for"; "Please enter a valid email address" once the field is left with an address that is not one), Handle (`UsernameInput`: checking, available, taken, invalid), Date of birth with the hint "You must be 13 or older to create an account." (or "{productName} is for users 13 and older" once a date under 13 is in), Display name (optional), the Turnstile challenge, "Send verification link" ("Sending…"). When a wait ended because someone took the handle, "That handle was taken while you waited. Choose another." under the handle, which takes focus |
| Verify | `CheckEmailView` for sign-up: the address, the request's number, Resend ("Sending…") and "Start again" (back to Details with the fields kept, from the first moment). After the link's reader declines or picks a wrong number the view keeps waiting, as for an address nobody was mailed, and the link's page sends the person back here to "Start again". Its error line is the copy map's sentence for a failed Resend, or "We've sent all the links we can for this sign-up. Use the newest one, or go back and start again." once the request has sent every link it may; once the link expires, "Send a new link" goes back to Details with the fields kept |
| Passkey | "Add a passkey or security key so you can sign back in. This is required to finish creating your account."; the enrolment's error line; "Add a passkey" ("Waiting for your passkey…") |
| Done | "You're all set. Loading {productName}…" |

**`RecoveryLoginForm`**

| State | What shows |
| --- | --- |
| Choose | "Pick how you'd like to prove this account is yours."; "Use a recovery code"; "Email me a link" and "Use your authenticator app" where the browser can run a passkey ceremony and the host passed both enrolment props, otherwise an info `Notice` ("The other ways back in need a passkey ceremony, which this browser can't run.") over a list of ways forward; "Back to sign in" |
| Recovery code | "Email or @handle", "Recovery code"; "Sign in with recovery code" ("Signing in…"); Back |
| Email, identify | "We'll send a link to the address on the account. Open it on any device to get back in here."; "Email address on the account", the Turnstile challenge; "Send the link" ("Sending…"); Back |
| Email, waiting | `CheckEmailView` for recovery: "If {address} has an account, a link is on its way.", the request's number, Resend after 120 seconds, "Start again" (back to the address, kept, from the first moment; after a decline or a wrong number the view keeps waiting, as for an address with no account); Back. Its error line says "We've sent all the links we can for this request. Use the newest one, or go back and start again." or "We couldn't send a new link just now. Try again in a moment."; once the link expires, "Send a new link" goes back to the address. A reload of the tab returns here, and `SignIn` opens on its recovery view |
| Authenticator | "Email or @handle", "Code from your authenticator app" and the code boxes; Continue ("Checking…"); Back |
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

**`PasskeysView`** — heading "Passkeys" with "Add a passkey". States: loading
(one row's placeholder); failed to load ("Your passkeys didn't load.", §7); the list, each row the passkey's name ("Synced passkey" or
"Device passkey" when unnamed, "(synced)" when backed up), "Added … · Last
used …", Rename and Remove, named for a screen reader by the passkey
("Rename Work laptop", "Remove Work laptop"); a row being renamed (a field,
Save, Cancel); a removal, which opens the step-up sheet titled "Remove
{name}?" (§8); a step-up in progress, which disables every row's actions. Under the list, a
"Signing in somewhere new?" disclosure.

**`TotpView`** — heading "Authenticator app", then "A six-digit code from an
app on your phone. …". States: loading (a row's placeholder); failed to load ("Your authenticator
app didn't load.", §7); none set up ("Add an authenticator
app" in the header); set up (the app's name, or "Authenticator app" when
unnamed, "Added … · Last used …", Remove, named "Remove {name}"); a removal,
which opens the step-up sheet titled "Remove {name}?" (§8); setting up ("Scan this with your authenticator app", the QR code,
"Or enter this setup key by hand", "Name this device (optional)", "Code from
the app", Confirm ("Checking…"), Cancel); a step-up in progress.

**`RecoveryCodesView`** — the intro "Recovery codes let you sign in if you
lose every device with your passkey. …". States: first load (a line's
placeholder, and the button reads "Checking…"); status unread (`LoadFailed`:
"Your recovery codes didn't load.", the map's sentence where it adds one,
and Try again; generating still works, and asks first, since an unread
count may hide codes); no codes (a warn `Notice`, "You don't have any
recovery codes yet. …"); codes held ("{active} of {total} codes unused · created
{date}"); the button "Generate recovery codes" or "Generate new codes"
("Generating…"); new codes on screen ("Save these codes somewhere safe. You
will not see them again.", the codes, Copy, "Download .txt", "I've saved
these codes somewhere safe.", Done); the confirm dialog before a new set
replaces the old ("Generate a new set?", Cancel, "Generate new set"); a
step-up in progress.

**`SecurityEventsBanner`** — renders nothing until there is an unacknowledged
event, and nothing if the list cannot be read. With events: one headline per
event (by kind — "A request to get back into your {productName} account was
turned down" for a declined recovery link, "A request to confirm a sensitive
action on your {productName} account was turned down" for a declined step-up
link — with a general line for a kind it does not know) and its time and device, a footer line, Acknowledge, then a
step-up.

**`SessionsView`** — heading "Active sessions" with "Sign out everywhere else".
States: loading (one row's placeholder); failed to load ("Your sessions didn't load.", §7); the list,
each row the device ("Unknown device" when
unnamed, "(this device)" on the current one), "Created … · Last used …",
Sign out, named "Sign out {device}" so it is never one more "Sign out" beside
the app's own (disabled on the current one).

**`ChangeEmailForm`** — heading "Change email". Phases: new email ("New email",
"Send a link" ("Sending…")); the wait (`CheckEmailView` for email change: "We
sent a link to {email}.", the request's number, Resend after 120 seconds,
"Start again" back to the address (after a decline or a wrong pick the view
keeps waiting, as for a taken address); its error line says "We've sent all
the links we can for this request. Use the newest one, or start again." or "We couldn't send a new link just now. Try again in a moment.";
once the link expires, "Send a new link" sends a new request to the same
address); step-up ("Re-authenticate to change your email."), once the link is
confirmed; finishing ("Changing your email…"); done ("Your email is now
{email}."). A failed complete goes back to the wait with the error line, and
its poll says whether to step up again or send a new link.

**`CheckEmailView`** — the wait after a flow emails a link. Where the host
gives no `email`, "your email address" stands for the address, and recovery
says "If that address has an account, …".

| State | What shows |
| --- | --- |
| Waiting | "Check your email"; "We sent a link to {email}." (recovery: "If {email} has an account, a link is on its way."); the flow's line ("Open it on any device to finish signing up.", "… to get back into your account.", "… to confirm it's you.", "… to confirm your new address.") and "This page will update when you do."; the number and "Pick this number on the page the link opens." (recovery and step-up, whose pages ask the person to type it: "Type this number on the page the link opens.") when the host passes one; "Resend in {n}s", disabled, then "Resend link"; "Start again" when the host passes `onChangeEmail`, from the first moment |
| Sending | "Sending a new link…"; Resend busy, reading "Sending…"; "Start again" disabled; no error line |
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
| Cancelled | "Cancelled"; "Nothing was confirmed. You can close this page. If you did ask for it, go back to where you started and choose Start again." (step-up: "Nothing was confirmed. Someone else may be signed in to your account, so sign out your other sessions.") |
| Expired | "This link no longer works"; "It has expired or was already used. If you confirmed it already, go back to where you started and carry on. If not, go back to where you started and choose Start again." (step-up's ends "If not, go back and ask for a new link.", since its waiting screen learns of the refusal and offers one, and adds "If you didn't ask for this link, someone else may be signed in to your account, so sign out your other sessions."). The same for every refusal, a list the page cannot offer included |

**`CreateProfileForm`** — Handle (`UsernameInput`), "Display name (optional)",
"Create profile" ("Creating…"), Cancel when the host gives `onCancel`.

**`ProfileOnboarding`** — shows only with a session, exactly one profile and
no earlier dismissal: the card "Add another profile", "Create profile", and
a dismiss control when `dismissible`.

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
  email, handle (the handle-taken line) and date of birth; `RecoveryLoginForm`'s handle or email and recovery
  code, its email address, and its authenticator step's handle or email;
  `PasskeysView`'s rename field; `ChangeEmailForm`'s email; `CreateProfileForm`'s
  handle; and every row of code boxes (below).
- **Above the action it follows** when no field owns it: `Register`'s send and
  enrolment, `RecoveryLoginForm`'s recovery-code, send and enrolment steps,
  `RecoveryCodesView`'s generate, `CreateProfileForm`'s submit, and the
  factor buttons in `StepUpDialog`.
- **Under the heading** in `PasskeysView` (add, remove) and `TotpView` (start,
  remove), and in `SessionsView`; above the `SecurityEventsBanner` box, on
  the page's ground. Never on the warn wash: danger ink there measures 4.16:1
  in light, under the 4.5:1 text floor (`musubi/social/DESIGN.md` §Status
  colours).
- **Under the code boxes** for a refused code in `RecoveryLoginForm` (both code steps), `TotpView`, `StepUpDialog` (its
  authenticator step) and `ChangeEmailForm`, tied to the row the same way: the line's id
  goes to `OtpInput`'s `aria-describedby`, which sets it on every box. The
  boxes' `aria-invalid` comes from `OtpInput`'s `status`: each view passes
  `error` only when the line's `FieldError` is `invalid`, so a wait or an
  outage ties the line without marking the code or painting the boxes' edge
  red. `RecoveryLoginForm`'s authenticator line is tied to its handle or email
  as well, since either may be what was refused.
- **Under its sentence** in `CheckEmailView`, which has no field: the host's
  `errorMessage`, a sentence from `describeAuthError`, as an alert of its own
  beside the view's status region. The one exception is an answer, not a
  failure: `Register` passes its own line when the request has sent every
  link it may. Resend is the action, and the line goes
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
`TotpView`, `SessionsView`, `RecoveryCodesView` — that fails to load shows
`LoadFailed` in its place instead of throwing: a lead in the view's words ("Your passkeys didn't
load."), the map's sentence only when it adds something (a `429` says to
wait, status `0` to check the connection, an ended session to sign in), and a
"Try again" that loads it again, left out once the session has ended. The
heading stays. `RecoveryCodesView`'s read never throws at all: it carries the
failure beside the count, so nothing reaches the host's error boundary, the
generate button stays, and a rotation still asks first. `SecurityEventsBanner`
fails soft, showing nothing (§6).

**Toasts are for success only** ("Signed in", "Email verified", "Welcome,
@{handle}", "Authenticator app added", …). No view raises an error
toast.

**The verification challenge.** Every call that spends a Turnstile token —
`SignIn`'s Continue, `Register`'s send, `RecoveryLoginForm`'s
emailed-code send — asks the widget for a fresh token when it fails: the
server checks the token before it answers, so a refusal has spent it too.
Once the call is over the submit stays disabled until the widget hands over a
fresh one; while the call runs it stays busy, not disabled, though the widget
has already dropped the spent token. `SignIn` and `RecoveryLoginForm` reset
after a success as well. `Register` drops the spent
token after a success instead, since its widget goes with the details step.
The waiting view's Resend spends no token, so a sign-up runs one challenge
unless it comes back to the details, which mount a new widget.

A recovery session that runs out is its own state in `RecoveryLoginForm`
("That recovery session timed out"), not an error line.

## 8. Step-up

`StepUpDialog` asks for a fresh factor before a gated action and hands the
host a short-lived token through `onToken`.

- **Structure.** A sheet: `@shared/ui`'s `Dialog`, open while mounted, with
  `DialogContent presentation="sheet"` (§4). The title ("Confirm it's you",
  or `title`), then the warning when `warning` is given, "Re-authenticate
  {reason}." when `reason` is given, the line "This action needs a fresh
  authentication. Choose a method below." (on the factor list only, so not
  with `passkeyOnly`), the error line, then the step. It is named by its title
  and described by the warning, or, without one, by the reason line, so a
  screen reader hears what the action costs as the sheet opens.
- **A destructive action** that leads here: the title
  names the action ("Remove Device passkey?"), `warning` says what it costs
  ("You'll need another credential to sign in. Confirm it's you to remove
  it."), and the factor the person picks commits it. No red button.
- **Factors.** A passkey always ("Use passkey"), the one primary Button. A link
  to the account's own address ("Email me a link", `outline`, the recovery
  chooser's words for the same factor) where the
  ceremony's `purpose` admits it and `passkeyOnly` is not set; with no
  `purpose` it is not offered, since the link is fixed to one purpose when it
  is sent. An authenticator app ("Use your authenticator app", `outline`) where the `purpose`
  admits it, the host passes `totpClient`, and the account has one
  (`GET /totp/status`; a failed read hides the factor, and so does one still
  out, read by `state` so the sheet never joins its host's `Suspense`). By `purpose`:
  `passkey_delete` admits the passkey only; `email_change` the passkey and the
  emailed link; every other purpose all three; no purpose, the passkey and the
  authenticator. Cancel (`secondary`, as every dialog's dismiss button) is last.
- **`passkeyOnly`** means the host cannot deliver mail: it removes the emailed
  link and nothing else, and starts the passkey ceremony as the sheet opens.
  Its full meaning is in
  [passkey-primary §What `passkeyOnly` means](../../wiki/osn/passkey-primary.md).
- **States.** Choosing a factor ("Use passkey" ("Waiting for your passkey…"),
  "Email me a link" ("Sending…")); waiting for the passkey with
  `passkeyOnly`, the same busy passkey button, then "Try again" after an
  error; waiting on the emailed link (`CheckEmailView` for step-up, mounted
  in the open sheet: "We sent a link to your email address.", the number to
  type on the link's page, "Resend in {n}s", disabled for 120 seconds, then
  "Resend link"; then "Use another method" and Cancel; the choose-a-method
  line goes; a link that cannot be sent leaves the factors up with the
  error's plain sentence); entering an authenticator code ("Code from your
  authenticator app" and its code boxes, Confirm ("Checking…"), "Use another
  method", Cancel). The authenticator step puts focus in its first box as it
  opens. Confirm is not disabled for a short code: it answers "Enter the
  6-digit code.", marked invalid.
- **Resend keeps the server's limit.** The 120-second wait is the client's,
  set because a mailbox gets three resent step-up links a day
  (`LINK_RESENDS_PER_MAILBOX_MAX`, `osn/api/src/services/auth/constants.ts`)
  and an account ten step-up links a day. The sheet changes neither.
- **"Use another method"** goes back to the factor list (with `passkeyOnly`,
  to the passkey step, without starting the ceremony again), with focus on
  the factor just left. On the emailed-link wait it ends the request on this
  side: the poll stops, the claim secret and the number go, and any answer
  still in flight is dropped; choosing the link again sends a new one, which
  the server counts. On the code step it clears the code and its error line.
  It is `disabled` while the code is checked.
- **Closing.** Cancel, Escape and a press outside the sheet are one action.
  It is refused while a call the sheet started runs — the passkey, the email
  send, the code check — as Cancel is `disabled` then (§6). On the emailed
  link's wait every way out stays open while a Resend runs: leaving ends the
  request on this side, and the late answer is dropped.
- **One outcome, after the exit.** The sheet closes itself and hands the host
  its one outcome, `onToken` or `onCancel`, once its exit fade has ended, so
  the sheet fades out as every Musubi dialog does before the host removes it.
  If the fade has not ended 300ms after the close (a tab the browser has
  hidden runs no animation), the outcome goes then. While it closes, its
  body is `inert` and every action returns early. A host that removes the
  sheet itself gets neither callback. The cost is the fade: the host's next
  request starts `--ui-dur-exit` (80ms in Musubi) after the token, or up to
  300ms in a hidden tab, rather than at once. That is the price of the host's
  `<Show>` not cutting the fade short and of focus going back only once the
  sheet has gone.
- **The claim secret and the number** live in memory only, and every answer
  about the emailed link is checked against the wait it was for, so nothing
  reaches `onToken` after the person closed the sheet or went back. A status
  poll still out when the person goes back neither stops nor delays the poll
  of the wait that follows (`link-poll.ts`).
- **Who opens it.** `PasskeysView` (`passkey_register` to add,
  `passkey_delete` to rename or delete), `TotpView` (`totp_enroll`,
  `totp_disable`), `RecoveryCodesView` (`recovery_generate`, "to generate
  recovery codes"), `SecurityEventsBanner` (`security_event_ack`) and
  `ChangeEmailForm` (`email_change`). `PasskeysView`'s and `TotpView`'s
  removals take the title-and-warning form above ("Remove {name}?"; "You'll
  need another credential to sign in. Confirm it's you to remove it." and
  "You'll lose it as a way back into your account. Confirm it's you to
  remove it."), and ask nothing before it: no `window.confirm`. No host
  passes `passkeyOnly`.

## 9. Focus

Every focusable element in a view shows a visible focus indicator on
`:focus-visible`, drawn from `--ui-focus`. The `@shared/ui` parts supply it;
a control the package draws itself takes the same treatment as `@shared/ui`'s
Button, `focus-visible:ring-2 focus-visible:ring-ui-focus`. A focus indicator
appears at once, never animated.

**As built.** The `@shared/ui` parts draw their own ring, and the two
controls the views draw by hand draw Button's (`focus-visible:ring-2
focus-visible:ring-ui-focus focus-visible:outline-hidden`): `InlineAction`,
and the "Signing in somewhere new?" `<summary>` in `PasskeysView`, on a
`rounded-ui-sm` corner.

**The step-up sheet.** As it opens, focus moves to its first control, the
first factor (with `passkeyOnly`, the busy passkey button, which keeps focus
through the wait). Focus stays inside it while it is open. As it closes, focus
goes back to the control that had it when the sheet mounted, read before the
host disables that control, if it is still in the page and focus has not
already moved to something the host put it on (its next step). After a
removal no view moves focus yet: it goes back to the row's Remove, which goes
with its row once the list is read again, so focus falls to the page; and
`RecoveryCodesView`'s "Generate new set" goes with its closing dialog. Where
it lands instead is the passkeys flow's (#2052).

`AuthHeader` draws no control by hand: its Cancel is `@shared/ui`'s Button,
with Button's ring. In a dialog Cancel is the first control, so the dialog
puts focus on it as it opens unless the view moves focus elsewhere.

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
was: on the busy button that sent it, which kept focus through the wait.
`ChangeEmailForm` does not yet: a refusal that is not about the code, after
the step-up, leaves focus on the page (#2056).

## 10. Words

**The rule.** The product's name comes from the host through `productName`
(the prop's TSDoc says so on each view that takes it); the package hard-codes
no product. One action reads the same in every view, from this glossary; a
new view takes its words from here, and a new action adds its row here.

| Action | Words | Where |
| --- | --- | --- |
| The identifier | "Email or @handle" | `SignIn`, `RecoveryLoginForm`'s recovery-code and authenticator steps; "Email address on the account" where only an address works (`RecoveryLoginForm`'s emailed link), "Email" in `Register` |
| Add a passkey | "Add a passkey"; its wait "Waiting for your passkey…" | `PasskeysView`'s header, `Register`'s last step, `RecoveryLoginForm`'s enrolment; "passkey or security key" in the copy around it |
| Use a passkey | "Use passkey" | `StepUpDialog` |
| Choose the emailed link | "Email me a link" | `RecoveryLoginForm`, `StepUpDialog` |
| Choose the authenticator | "Use your authenticator app" | `RecoveryLoginForm`, `StepUpDialog` |
| Choose a recovery code | "Use a recovery code" | `RecoveryLoginForm`; "Use a recovery code instead" on `SignIn`'s no-WebAuthn view |
| Send a link to a typed address | "Send verification link" (sign-up), "Send the link" (recovery), "Send a link" (email change) | Three actions with three server limits; the end-to-end suite's rate-limit audits (`tools/e2e/tests/flows.test.ts`) tell them apart by these words |
| Rename a factor | "Rename", named "Rename {name}" | `PasskeysView` |
| Take a factor off | "Remove", named "Remove {name}"; the step-up sheet titled "Remove {name}?" | `PasskeysView`, `TotpView` |
| End one session | "Sign out", named "Sign out {device}"; all others "Sign out everywhere else" | `SessionsView` |
| Leave a dialog or view | "Cancel"; a host's `cancelLabel` where leaving means something else ("Sign in instead") | `AuthHeader`, every dialog |
| Go back a step | "Back"; to sign-in "Back to sign in"; to the factors "Use another method"; redo "Start again" | `RecoveryLoginForm`, `StepUpDialog`, `CheckEmailView` |
| Say no to a link | "I didn't ask for this", answered by "Cancelled" | `ConfirmLinkPage` |

A row's action names its item for a screen reader (`aria-label`), so two rows
never offer two buttons of one name and the words seen stay the words heard
first. A wait ends in "…". No error line names a product: each is a sentence
from §7's helpers or a view's own check.

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
  refused and on a 320px phone; and for `SignIn`, `osn/auth-ui/SignIn` in
  `sign-in.story.tsx`: the signed-out passkey form in musubi's 384px dialog
  and in its 320px phone sheet, its "Verifying…" wait and the recovery
  chooser; and for `StepUpDialog`, `osn/auth-ui/StepUpDialog` in
  `step-up-dialog.story.tsx`: the real sheet, one story per state (the
  factors, a reason, a destructive action's warning, the passkey wait and
  failure, no ceremony runner, `passkeyOnly` waiting and after a failure, with
  and without an authenticator, the emailed link sending, refused, waiting,
  expired, replaced, not replaced and at the server's limit, the code step,
  checking, refused and rate-limited, and a title naming a 64-character
  passkey), a `Phone` story that frames four of them at 320px, and a
  playground. A story that cannot find a button it presses says so on the
  page. And for `AuthHeader`, `osn/auth-ui/AuthHeader` in
  `auth-header.story.tsx`: in the real sheet, sign-in and create-account
  titles with Cancel, no Cancel, Cancel disabled and a long title, each with
  a line reading the dialog's accessible name from the page; on a page, the
  sign-in and create-account headers under a stand-in for the app's name;
  `BothHosts`, the two hosts' titles on one sheet; four of them at 320px; and
  a playground. `SignIn` (`sign-in.story.tsx`) and `Register`
  (`register.story.tsx`) each open in the real sheet, named by their title,
  and on `/authorize`'s column (`OnAuthorize`), `SignIn` also at 320px. The
  Settings panels each have a file, drawn in a stand-in for Settings' card
  (`settings-bench.tsx`, which also holds the shared stubs): `PasskeysView`
  (two rows, loading, failed, 320px), `TotpView` (none, set up, loading,
  failed, 320px), `RecoveryCodesView` (codes held, none, checking, status
  unread, 320px), `SessionsView` (two rows, loading) and
  `SecurityEventsBanner` (one event, 320px).
- **In the host.** `musubi/social/tests/styles/design-token-contract.test.ts`
  and `token-contract.browser.test.tsx` hold the mapping the shared parts
  inside the views render through. Musubi's component tests mock the views
  (`vi.mock("@osn/auth-ui/…")`) and check how the app wires them. The suites
  that run the real views are the end-to-end flows
  `tools/e2e/tests/flows/musubi-passkey.flow.ts` and
  `tools/e2e/tests/flows/musubi-register-retry.flow.ts`, which take `Register`
  through `CheckEmailView` and open the link on `ConfirmLinkPage` (a wrong
  pick, the decline, a failed read and its Try again, and the expired card for
  a link cut short and for one with an unknown id), and
  `tools/e2e/tests/flows/musubi-recovery.flow.ts`, which takes
  `RecoveryLoginForm` through its emailed link, its wait across a reload, the
  typed number and enrolment. `musubi-passkey`
  finds the sign-in and create-account dialogs by their titles, "Sign in to
  Musubi" and "Create your Musubi account". It reads Settings → Security
  against probes (`securityPanelSurfaces`): each panel heading at
  `DialogTitle`'s type, a passkey row as a nested `Card` (8px corner, 16px
  inside, the card's fill), its meta line, its actions 40px tall at 390px,
  and the `<summary>` taking Button's ring from the keyboard. It takes the
  step-up's emailed link as far as its wait and back with "Use another
  method", focus landing on "Email me a link", and removes the
  authenticator app through the sheet titled "Remove Authenticator app?",
  described by its warning, with no browser dialog, shot at 390px
  (`removalSheetSurfaces`). It also
  checks the error lines in Chromium: a rate-limited sign-in reads the wait sentence, with
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
  the app's name at the display step over the panel's 14px heading at 500,
  the panel with no frame, and "Create one" with no padding and one line tall, underlined 2px under, in its sentence's size and
  weight; with `GET /passkeys` held on Settings → Security
  (`securityLoadingSurfaces`), the passkey list's own `Skeleton` in a busy
  region, not Settings' fallback: the sunk well, an 8px corner, the pulse,
  still under reduced motion, and as tall as the passkey row that replaces
  it; and on the authenticator setup
  (`totpSetupSurfaces`), the spans over the setup key and the code boxes in
  the plain label's look, 6px above them, the boxes a group named "Code from
  the app" with box 1 focused after the step-up, and the row's width and each
  box's at 320 and 390px, shot at 320. It holds Register's send and enrol calls, the step-up's
  passkey begin and the authenticator's confirm (`busyButtonHeld`): "Sending…",
  "Waiting for your passkey…" (enrolment and step-up) and "Checking…" each busy, not
  disabled, with focus kept, and Cancel disabled beside them.
- **Waits in the package tests.** `SignIn.test.tsx` holds Continue busy and
  not disabled while the passkey prompt is open, though the verification
  challenge has dropped its spent token. `Register.test.tsx` holds "Send
  verification link" busy, not disabled, with Cancel disabled and the form's
  submit sending nothing, and Cancel disabled while the waiting view's Resend
  sends. The views no
  flow reaches hold each of their waits the same way, a second press sending
  nothing: `RecoveryLoginForm.test.tsx` (four, with Back disabled),
  `RecoveryCodesView.test.tsx`, `CreateProfileForm.test.tsx` (Cancel
  disabled), `ChangeEmailForm.test.tsx` ("Send a link"), `StepUpDialog.test.tsx`
  ("Email me a link" and the authenticator's Confirm), `CheckEmailView.test.tsx`
  (Resend, with "Start again" disabled) and
  `ConfirmLinkPage.test.tsx` (a number, Confirm, the decline and Try again,
  each with the other choices disabled).
- **Error lines in the package tests.** Each view's tests plant text in a
  thrown error's `message` and check it never reaches the screen, check a
  `429` reads the wait sentence, and check the line is an alert, tied to its
  field where it has one, with no error toast (`tests/helpers/errors.ts`).
  Each row of code boxes is found as a group named by its label
  (`tests/helpers/code.ts`), and a `400` and a `429` for each code check the
  line is in every box's `aria-describedby`, with every box `aria-invalid` for
  the `400` alone. `StepUpDialog.test.tsx` checks focus lands in box 1 as the
  authenticator step opens, and on the wait's heading as the emailed link's
  wait opens.
- **`AuthHeader` in the package tests** (`AuthHeader.test.tsx`, one case per
  way it can fail): in a dialog, the dialog named by the title, renamed when
  the title changes, and still named, by exactly one element, when one header
  replaces another; Cancel calling `onCancel` once and never asking the
  dialog to close; on a page, a level-2 heading with no dialog; no Cancel without
  `onCancel`; the host's words for Cancel, and "Cancel" without them or with
  blank ones; Cancel
  refused while `cancelDisabled`; and Cancel never submitting a form it
  sits in.
- **The step-up sheet in the package tests** (`StepUpDialog.test.tsx`, one
  case per way it can fail): named by its title and described by its warning
  or reason; the `passkeyOnly` wait a busy button; Escape refused while the
  passkey or the code check runs, and Escape on the emailed link's wait
  dropping a later confirmation; "Use another method" dropping a later
  confirmation, a late Resend answer and a late new link for an expired one,
  clearing a refused code, held while the code is checked, and not starting
  the passkey again with `passkeyOnly`; focus left where the host put it after
  the token; and, with an exit that never ends, the token handed over within
  300ms, no second outcome while it closes, and nothing for a host that
  removed it. happy-dom never ends a Kobalte exit (it reports
  `animationName` as `""`), so the views' tests that open the sheet set every
  animation to `none` first, the reduced-motion path (`tests/helpers/motion.ts`).
  `RecoveryCodesView.test.tsx` opens the sheet from its closing rotation
  dialog and closes it with Escape.
- **Loading in the package tests.** `PasskeysView`, `TotpView`,
  `RecoveryCodesView` and `SessionsView` mounted under a `Suspense` whose
  fallback is the host's show their own placeholder, never the host's, while a
  read is out, and `StepUpDialog` its factors while `GET /totp/status` is out.
  `RecoveryCodesView` and `SessionsView` hold the placeholder in a busy region
  until the first read lands, and `RecoveryCodesView` keeps its count through
  the read after Done. `PasskeysView` and `SessionsView` disable every action
  while the list is read again after a delete or a revoke.
- **The contract and the hosts in the package tests.**
  `token-contract.test.ts` (§2). `SignIn.test.tsx` and `Register.test.tsx`
  mount each view in a real `Dialog` with `host="dialog"`: the dialog named
  by its title through exactly one element, `SignIn`'s renamed "Recover your
  account" and back; `Register`'s Cancel reads the host's `cancelLabel`.
  `PasskeysView.test.tsx` and `TotpView.test.tsx` press Remove: no
  `window.confirm`, the sheet named "Remove {name}?" and described by its
  warning, and Cancel removing nothing; each row's actions named by their
  item. `RecoveryCodesView.test.tsx` fails a status read under a host's
  `Suspense`: the panel's own line with Try again, no fallback, the generate
  button kept, and Try again reading the count. `ProfileOnboarding.test.tsx`
  finds its create dialog by name.
- **Layout in Musubi's browser tests.**
  `musubi/social/tests/components/SecurityStepUp.browser.test.tsx` opens the
  step-up sheet from "Add a passkey" in Settings → Security: at 390px a bottom
  sheet as wide as the screen with 16px top corners and square bottom ones,
  focus on its first factor, and Escape closing it with focus back on "Add
  passkey"; Resend disabled while the emailed link's wait runs; at 320px the
  authenticator step's row of code boxes 288px wide with no box under 40px,
  and every button inside the sheet's padding and at least 40px tall; at
  1440px a centred 384px card with the row inside its padding, closed by a
  press on the scrim with focus back on "Add a passkey", and kept open by the
  same press while the passkey call runs. A sheet whose title names a
  64-character passkey scrolls nothing sideways at 320 and 1440px. A
  passkey row reads as a nested `Card` against a probe, at 390 and 1440px in
  both schemes, its actions 40px tall and under its words at 390 and 32px at
  1440; with the list held, its placeholder is as tall as the row that
  replaces it at both widths. New recovery codes sit in a well read against a
  `Card variant="muted"` probe, with a 16px box in a row at least 44px tall at
  390px; "Generate a new set?" is a bottom sheet at 390px and a centred 384px
  card at 1440px, its Cancel painted as a `secondary` Button. Shots at
  320, 390 and 1440px, light and dark, in `e2e-artifacts/musubi-settings/`.
  `musubi/social/tests/components/CheckEmailView.layout.browser.test.tsx`
  renders `CheckEmailView` in Musubi's auth sheet
  and holds its layout at 320px and 1280px (the long address, the countdown on
  one line, the 40px and 32px buttons, and the six-digit number at 24px in
  tabular figures with its label read first).
  `musubi/social/tests/components/ConfirmLinkPage.layout.browser.test.tsx`
  renders `ConfirmLinkPage` on a bare route and holds, at 320px, five six-digit
  numbers and a long address with nothing to scroll sideways, and at 320px and
  1280px the numbers one under another, at least 44px tall in 24px tabular
  figures, the decline and Try again at 44px below `md`, the error notice above
  Try again, and the typed field, Confirm and the decline inside the card at
  44px or more, the field at 16px with an edge of at least 3:1 and a plain
  label 6px above it.
  `musubi/social/tests/pages/VerifyEmailLinkPage.layout.browser.test.tsx`
  renders Musubi's `/verify/:requestId` page itself, and holds its own failed
  card, its busy Try again and its `Skeleton` placeholder against
  `ConfirmLinkPage`'s card.
  `musubi/social/tests/components/AuthHeader.browser.test.tsx` renders
  `AuthHeader` in Musubi's sheet and in `/authorize`'s column, light and dark:
  at 320px a long title with no space in its product name wraps beside
  Cancel, which stays 40px tall, unsqueezed and inside the padding, with
  nothing scrolling sideways; both hosts' titles in the same computed type and
  colour, 14px at 500; and Cancel drawn as a `secondary` Button in the dialog
  and a `ghost` one on the page, each compared with a Button of that variant.
  Shots at 320px in `e2e-artifacts/musubi-auth-header/`.

## 12. Motion

The package has no motion of its own. A view takes its host's: in Musubi, colour
and opacity transitions only (`musubi/social/DESIGN.md` §Motion). The host's
`transition-ui-colors` utility fades colours and leaves the outline out, so a
control's focus mark lands at once (§9). A view draws four motions, all from
`@shared/ui` parts: a busy button's `Orb`; `Skeleton`, the loading
placeholder in `PasskeysView`, `TotpView`, `SessionsView` and
`RecoveryCodesView`, which pulses in opacity; the open and close of `Dialog`,
in `ProfileOnboarding`, `RecoveryCodesView` and `StepUpDialog`, all three sheets; and the open and close of a
popover, `Register`'s `InfoPopover` beside the email field. The last two fade
with no scale in Musubi, which maps both scale tokens to 1
(`musubi/social/DESIGN.md` §Motion). The `Orb` and `Skeleton` stand still
under reduced motion, and the overlays show and hide at once. `StepUpDialog`
hands its host the outcome once its fade out has ended (§8), so the host's
removal never cuts the fade short. `AuthHeader` adds no motion: a title it
is given arrives at once, and it shows and hides with the dialog around it. What a skeleton
stands for, a refused code's line and a step that replaces another arrive at
once, with no fade (`musubi/social/DESIGN.md` §Motion), and so does a list
that lands in place of its placeholder. A view never moves
a panel, a field or an error across the screen, and never loads an
animation library. A motion a view needs that the host does not have goes into
the host's `DESIGN.md` first.
