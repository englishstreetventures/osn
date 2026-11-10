---
"@tools/e2e": patch
---

`musubi-passkey` and `musubi-org-detail` read what Musubi maps onto the shared overlays and titles: the account menu's separator as a 1px hairline fill with no border at 390 and 1440 px in both schemes; the first frame of the account menu, the profile switcher and the create-organisation dialog, and the half-way frame of the menu and the switcher closing, with no transform (`overlay-frames.ts` holds a run in the page from its `animationstart`); the switcher's, the add-a-profile card's and the organisation dialogs' titles at Musubi's title size and 500; and the code boxes' digits at the title size from 768 px and 16px at 390 px. `pulse-event-rsvp` reads pulse's two avatar menus' separators the same way at 390 and 1440 px in both schemes, and finds them and the "More filters" dialog still opening from the contract's 96% (`pulse-menus.ts`). Shots go to `screenshots/musubi-surfaces/` and `screenshots/pulse-menus/`.
