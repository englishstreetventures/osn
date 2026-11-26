---
"@osn/auth-ui": patch
---

`ProfileOnboarding`'s "Create a new profile" sheet no longer closes on Escape, a press outside or a drag down while its create request runs; once the request ends, they close it as before. `CreateProfileForm` takes an optional `onBusyChange(busy)`, called with `true` when the request starts and `false` once it ends.
