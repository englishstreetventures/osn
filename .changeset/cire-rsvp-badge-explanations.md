---
"@cire/host": patch
---

The RSVP table's badges (New, Host-entered, Host-updated, Household-entered and
linked musubi) give screen readers their explanation as hidden text inside the
badge, in sentence case. They carry no hover tooltip: beside the text, Chrome
would hand a screen reader the tooltip's words a second time, as the badge's
description.
