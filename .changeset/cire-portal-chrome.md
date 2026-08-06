---
"@cire/organiser": patch
---

Collapse the host portal's chrome into one row, and give it a command palette and haptics.

The portal used to stack four bands before the first piece of content: an Astro masthead, a portal nav row, a per-wedding header, and the sub-tab strip. They are now one sticky `TopBar` that answers whose product, which wedding, and what can I do from anywhere — reading left to right. The wedding switcher is a menu on the wedding's own name rather than a separate band, and the role chip sits beside it.

Everything the removed rows used to reach is now also reachable from a ⌘K / Ctrl+K command palette: every module of the open wedding, every other wedding, the theme toggle, security and sign-out. It is a combobox over a listbox — focus stays in the field, `aria-activedescendant` moves the highlight — and it filters on each command's hint and keywords, not just its label, so "rsvp" finds Guests.

The module rail's sub-tabs now follow the APG tabs pattern with manual activation: arrows move focus, Enter or Space selects. That is deliberate rather than stylistic — each panel mounts a view that fetches, so selection-follows-focus would fire a request per keypress on the way past.

Touch feedback arrives through `web-haptics`, wired at choke points rather than per call site: copy-to-clipboard, dialog dismissals, drag pickup and step, and commit/reject on the surfaces that already had a success or failure path. Silence is equally deliberate where a gesture is navigation rather than an outcome.
