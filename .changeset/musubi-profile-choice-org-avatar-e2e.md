---
"@tools/e2e": patch
---

`musubi-org-detail` reads each organisation's avatar as a square with 8px corners beside a person's circle. The owner makes the member an admin and removes them, with Remove held busy while its DELETE is held. Edit and Delete stay after a rename. A non-member is offered no Edit, Delete or Remove. `musubi-passkey` reads the theme menu's `aria-checked` and finds no profile rows in a one-profile account menu. It holds the slide, the drag to close and the shape of the "Create a new profile" sheet, which replaces the removed switcher dialog. It then adds a second profile through that sheet and switches to it and back from the account menu. On `/authorize` it chooses in the picker, goes on to consent, uses Change to pick the other profile and allows Pulse, and checks that the decision names that profile. It reaches `/terms` inside the app, so it still lists profiles no more than eight times.
