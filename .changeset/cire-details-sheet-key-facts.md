---
"@cire/invites": patch
"@cire/theme": patch
"@cire/landing": patch
---

The guest event sheet's details panel leads with its key facts.

- `@cire/invites`: under the title and the RSVP button, a list of the facts a guest needs, each with its own action: when (the zone spelt out, "AEDT (Sydney time)", the guest's own time beside it when that differs, and Add to calendar), where (the address, a compact map drawn in the palette's colours, Open in maps), and, for a household where not everyone is invited, who is. A range that ends on a later day names both days. One hairline, then About, Dress Code and Inspiration with no rules between them; a section with nothing to show, a whitespace description or an unusable Pinterest or maps link included, renders nothing. Swatches sit in a grid, edged at 3:1, named as typed. The moodboard is one block, "Open on Pinterest" and "Show it here", saying the switch holds for every invite in that browser. The calendar menu follows the menu-button keyboard pattern and opens above its trigger when it does not fit below. The closed-RSVP line takes the closed notice's style and says where a reply can still go. Every control in the panel is 44px tall. The standard consent placeholder no longer reads "Pinterest would shows".
- `@cire/theme`: `--color-border-strong` is derived per scheme, walked to 3:1 on all three surfaces, with a builder warning for a scheme that still leaves it short on the card.
- `@cire/landing`: the built-in `--color-border-strong` matches the guest site's new solid value.
