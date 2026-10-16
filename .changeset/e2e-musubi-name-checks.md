---
"@tools/e2e": patch
---

The Musubi passkey flow now checks that the tab title is "Musubi" and that the registration email's subject is "Verify your Musubi email". A new `mailFor(email)` fixture returns every message the mail stand-in has received for an address.
