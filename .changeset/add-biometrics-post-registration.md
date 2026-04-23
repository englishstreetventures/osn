---
"@osn/client": minor
"@osn/ui": minor
"@osn/social": minor
---

Let users add additional biometrics (passkeys) after registration. Registration already required enrolling a first passkey; Settings now exposes a Security tab with an "Add passkey" button that runs the step-up-gated WebAuthn registration ceremony, plus the existing list / rename / delete surface. `PasskeysClient` gains `registerBegin` / `registerComplete` so the Settings surface can call `/passkey/register/begin` + `/complete` directly.
