---
"@musubi/social": patch
---

A browser test renders `@osn/auth-ui`'s `CheckEmailView` in musubi's auth sheet under musubi's stylesheet and holds its layout: a long address leaves a 320px phone with nothing to scroll sideways, "Resend in 30s" stays one run of text on one line, both buttons are 40px tall below `md` and 32px from it, and a six-digit number fits the 320px column at 24px in tabular figures, read as "Your number: 123456". `DESIGN.md` gives `text-display` the role of a number the person carries to another screen.
