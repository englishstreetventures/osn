---
"@osn/auth-ui": patch
"@musubi/social": patch
---

`ProfileOnboarding`'s "Create a new profile" sheet no longer closes on Escape, a press outside or a drag down while its create request runs; once the request ends, they close it as before. `CreateProfileForm` takes an optional `onBusyChange(busy)`, called with `true` when the request starts and `false` once it ends. Musubi's `DESIGN.md` lists the sheet among those that give on the rubber band while their call runs.
