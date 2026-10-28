---
"@cire/host": minor
"@cire/vendor": minor
"@cire/invites": minor
---

Motion follows the input. With a mouse or trackpad the organiser and vendor portals run their durations at 90, 150 and 200ms instead of 120, 200 and 320ms, so the checklist's assign popover and `Modal` open in 200ms; touch keeps the longer timings. The profile menu, wedding switcher, date and colour pickers, seat menu and module card scale and fade in (`menu-pop`), the invite builder's narrow section menu fades in and out in CSS alone (`section-menu`, `transition-behavior: allow-discrete`), `<details>` bodies fade as they open in host and the guest site's FAQ, and every bare host `transition` reads the duration tokens. On the guest site the event sheet's swipe follows iOS: a drag past either end gives on a rubber band instead of stopping dead, a pull toward the side with no panel gives and springs back without loading the other panel, a release springs to rest at the finger's speed, and a touch on a settling swipe catches it without pressing what was under the finger.
