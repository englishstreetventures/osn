---
"@cire/host": patch
---

Rebuild the host portal's write surfaces on a shared set of form controls.

Counted across the portal, the text input had drifted into four shapes and three of the four had no focus treatment, so typing into a guest row and typing into the wedding name looked like two different products. A new `Field` primitive holds the label, the control, the hint and the errors, in two sizes — `md` for a form, `sm` for a control inside a table row — and every write surface now composes it: the settings and co-host forms, the guests and events editors, the spreadsheet import, the invite builder, the image crop modal, and the four planning modules.

The larger part of this is accessibility. Every one of those forms used to wrap its control in a `<label>` with the hint inside the label too, which quietly makes the hint part of the input's accessible *name* — a date box announcing as "RSVP by, the day replies are due, measured in Australia/Sydney". `Field` mints an id, splits the hint into `aria-describedby` and puts errors in a live region ahead of it, so a rejected save is announced even though focus has long left the box. Six inputs that had no label at all — three in the budget module's payment panel, three more elsewhere — now have one. Every write handler in the four planning modules also gained the portal's commit and reject haptics, matching the settings and co-host panels.
