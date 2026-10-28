---
"@cire/host": minor
"@cire/vendor": minor
"@cire/invites": minor
---

Motion follows the input. With a mouse or trackpad the organiser and vendor portals run their durations at 90, 150 and 200ms instead of 120, 200 and 320ms, so the checklist's assign popover and `Modal` open in 200ms; touch keeps the longer timings. The profile menu, wedding switcher, date and colour pickers, seat menu and module card scale and fade in and out (`menu-pop`), the invite builder's narrow section menu fades in and out in CSS alone (`section-menu`, `transition-behavior: allow-discrete`), `<details>` bodies fade as they open in host and the guest site's FAQ, and every bare host `transition` reads the duration tokens.
