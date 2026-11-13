---
"@musubi/social": patch
---

The browser test of Settings' Security tab opens the step-up as a sheet: its shape at 320, 390 and 1440px, focus moving in and back on Escape or a press outside the card, the sheet kept open by that press while the passkey call runs, Resend held while the emailed link's wait runs, and a title naming a 64-character passkey kept inside the sheet. `DESIGN.md` says where the step-up sheet sits and how wide its code row is.
