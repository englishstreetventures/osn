---
"@cire/host": patch
"@cire/vendor": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/ui": patch
---

Cire's cards, small-caps labels and disclosures now come from three `@cire/ui` parts in all four apps. Twenty-eight hand-drawn cards take a padding step, a fill and a tone from `cardClass`; the portal's filter bars and add forms share one class. Sixty hand-written labels and `CardEyebrow`'s eleven calls render `Eyebrow`, at one letter-spacing (0.16em) in the readable gold, or the secondary ink where they were the dim gold; the marketing site's own eyebrow rule goes. The seven hand-written `<details>` render `Disclosure`: change history, the import guide and its tips, the invite builder's two field disclosures and "Arrange tables" in the host portal, the guest FAQ and the marketing FAQ. The host and guest stylesheets drop their `details-in` keyframe. `CardEyebrow` is removed from `@cire/ui`.

Changes a reader will see: labels move to the one letter-spacing and the readable gold; the getting-started guide loses its gradient for the accent rule; the import tips lose their gold tint; disclosures take the sunk fill and a turning marker; the FAQs' `+` takes the question's size; the marketing FAQ's question takes the site's focus ring. The getting-started steps now wrap inside their tiles rather than running over the next one.
