---
"@cire/host": patch
---

A budget line's "per head" and "payments (n)" panels grow open through `Reveal`, so the lines below move down with them instead of jumping, and close at once. "payments (n)" now reports whether its panel is open (`aria-expanded`), as "per head" does. Cancel, Save and "Use a fixed amount" put keyboard focus back on the line's "per head" toggle, and deleting a payment moves it to the next payment or the label field, rather than to the top of the page. A long unbroken payment label or event name wraps inside its panel.
