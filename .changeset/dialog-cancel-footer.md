---
"@osn/auth-ui": major
"@musubi/social": minor
"@tools/lab": patch
---

Every dialog `@osn/auth-ui` and Musubi draw has one shape: the title alone in the header, centred; the body; then a footer with Cancel (`secondary`) first, beside the step's one action, both `sm` and 40px tall below `md`. The step-up sheet says one line under its title naming the cause ("To generate recovery codes, confirm it's you."), and drops "Re-authenticate…" and "This action needs a fresh authentication. Choose a method below."

Breaking, in `@osn/auth-ui`: `AuthHeader` with `host="dialog"` takes no `onCancel`, `cancelLabel` or `cancelDisabled` (a page header still does). `SignIn` with `host="dialog"` requires `onCancel` and takes no `cancelLabel`; `Register` with `host="dialog"` takes no `cancelLabel`. `RecoveryLoginForm` takes a required `host`, and `onDismiss` (the dialog's Cancel) with `host="dialog"`. `StepUpDialog`'s `reason` is the whole line it prints ("To change your email, confirm it's you."); with a `warning`, the warning is the one line.

- `SignIn`, `Register` and `RecoveryLoginForm` lay out each step through an internal `ViewStep`: in a dialog, the body with its ways back as centred links at its foot ("Lost your passkey?" under the field, recovery's "Back"), then the footer; on a page, the action spans the column with its links under it, so `/authorize`'s sign-in and create-account views look as they did. Recovery's "Back" buttons are links, and its chooser lists "Use a recovery code" after the factors that end in a passkey.
- The step-up sheet opens with focus on "Use passkey", now the footer's action; the other factors sit above it. "Generate a new set?" and "Create a new profile" take the same header and footer.
- Every view that opens the step-up sheet passes its line: adding a passkey, renaming one (by its current name), adding an authenticator app, generating recovery codes, acknowledging alerts and changing the email.

Musubi: the profile switcher, the remove-friend dialog and the create and edit organisation dialogs centre their titles (`DialogTitleRow`); the switcher gains a footer Cancel after its rows, held with Escape and a press outside while a switch runs. The sign-in and create-account dialogs open with focus on the dialog itself, so no phone keyboard rises over the sheet. The lab's `AuthHeader`, `SignIn` and step-up stories show the new layout.
