---
"@cire/host": patch
---

A budget line's "per head" and "payments (n)" panels grow open through `Reveal`, so the lines below move down with them instead of jumping, and close at once. "payments (n)" now reports whether its panel is open (`aria-expanded`), as "per head" does.
