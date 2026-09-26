---
"@cire/host": patch
---

Link the three places that shape a household's invite message.

The message's first line is written in the invite builder's Message section,
the code on its last line takes the style chosen at creation and changed in
Invite → Codes, and the message is copied from Guests → Households. Each of the
three now carries a line naming the other two. A place the reader's role cannot
open is named without a link, with the role that can.

A link that crosses modules lands on its sub-tab in one move rather than
stopping at the module's default view first — these links and the Overview
cards alike. A link that leads to the message editor opens the builder on its
Message section. Focus moves to the new view's heading.

On Guests → Households, "Copy message" now waits until the host's own first line
has loaded. Before, a copy made the moment the cached list appeared could send
the default line instead.
