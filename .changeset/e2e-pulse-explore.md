---
"@tools/e2e": patch
---

`pulse-event-rsvp` measures the explore page at 320, 390, 768 and 1440px, signed in on the host's page and signed out on the guest's (`tests/support/pulse-explore.ts`): no sideways scroll, the whole search field on screen with its placeholder unclipped, the header's three phone lines and its one desktop line, the active tab's underline, the hero's stats, where the header pins, and the create form's two times. It shoots the page into `screenshots/pulse-explore/` at 320, 390 and 1440px in light and dark. On the host's page it also reads the header's motion: the tab and search box fade their colours and never the focus mark, and the two loops stop under reduced motion. It spends no sign-in of its own.
