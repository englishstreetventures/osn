---
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/vendor": patch
---

Each cire stylesheet maps the contract's new scrim role, `--ui-scrim`, to its deep ground at 72%, so `Modal`'s backdrop paints exactly the colour it painted before `Modal` read the role. A browser case in the host portal and the guest site holds the backdrop to that colour in each theme and palette, and the vendor portal's token test holds the four stylesheets to one line.
