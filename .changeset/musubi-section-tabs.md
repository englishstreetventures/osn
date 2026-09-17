---
"@musubi/social": patch
---

The Connections and Settings tab bars become one `SectionTabs`

The two pages carried the same nineteen classes written out twice, byte for
byte, so a change to the selected-state colour had to be made in two files and
nothing said so.

The shared component also names the bar (`aria-label`) and marks the current tab
with `aria-current`. It deliberately does **not** claim `role="tab"`: the full
tab pattern is a contract — a `tablist`, a panel per tab, arrow keys moving
selection — and a bar that takes the roles without keeping it promises a
screen-reader user navigation that is not there. `@shared/ui`'s Kobalte `Tabs` is
the answer when a page can own real panels; Settings is deep-linked by URL
fragment and its sections are `<Show>` blocks.
