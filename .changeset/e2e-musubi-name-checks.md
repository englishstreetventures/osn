---
"@tools/e2e": patch
---

The Musubi passkey flow now checks that the tab title is "Musubi", that the registration email's subject is "Verify your Musubi email", that the passkey-added notice's subject is "A passkey was added to your Musubi account", and that the signed-out top bar's "Create account" button fits a 320px screen. A new `mailFor(email, until)` fixture waits until a message matching `until` reaches an address, then returns every message the mail stand-in has received for it.
