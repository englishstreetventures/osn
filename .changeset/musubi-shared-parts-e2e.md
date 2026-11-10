---
"@tools/e2e": patch
---

`musubi-passkey` reads the shared parts the auth views draw, on steps it already takes: the create-account dialog's plain field labels and the date of birth's hint, the sign-in dialog's label and its standalone "Lost your passkey?" link, Continue busy while `/login/passkey/begin` is held (focus kept, one 20px orb, shot under reduced motion), `/authorize`'s "Create one" inside its sentence, and the contact address on `/privacy` and `/terms` as an inline link. `musubi-org-detail` reads the create-organisation dialog's plain labels and the handle's hint, and holds the create's POST and the rename's PATCH to read Create and Save busy with focus kept. The surface helpers put back the motion preference as well as the viewport and scheme. No flow spends a sign-in more.
