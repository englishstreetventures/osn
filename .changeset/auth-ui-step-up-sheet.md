---
"@osn/auth-ui": minor
---

`StepUpDialog` is a sheet: `@shared/ui`'s `Dialog` with `presentation="sheet"`, a bottom sheet below `md` and a centred 384px card above, named by its title. Focus moves into it as it opens and goes back to the control that opened it on Escape or Cancel. "Use another method" goes back from the emailed link's wait or the code step to the factors, ending the wait on this side. The `passkeyOnly` wait is the busy passkey button. A new `warning` prop puts a destructive action's cost in the sheet as its description, and the title breaks inside a word, so a passkey's 64-character name never widens the sheet. The sheet hands the host its one outcome after its fade out, or within 300ms if the fade never ends. Resend's 120-second wait and the server's limits are unchanged.
