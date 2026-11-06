---
"@osn/auth-ui": minor
---

`@osn/auth-ui` gains `ConfirmLinkPage` (`@osn/auth-ui/ConfirmLinkPage`, and from the barrel): the page an emailed link opens for sign-up, recovery, step-up and email change, with "Confirm this email" and one button. Only a press calls the host's `onConfirm`, never a mount, a prop change or a timer, and the button disables itself so one press is one call. Each flow says what confirming lets the device that asked do, and what to do if you did not ask. `confirmed` sends the person back to where they started, or offers Continue when the host passes `onContinue`; `expired` offers no retry; a thrown error shows a fixed line and Try again. One polite output says each change aloud, the heading takes focus on every change, and a confirm still running after 10 seconds says so. Nothing renders it yet.
