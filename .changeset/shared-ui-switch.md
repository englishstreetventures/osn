---
"@shared/ui": minor
"@tools/lab": patch
---

Add `Switch` (`@shared/ui/ui/switch`), an on/off control for a change that
takes effect at once: a native `<input type="checkbox" role="switch">` inside
its label. It is controlled, so it shows only the
value it is given; `readOnly` keeps it focusable and at full contrast for
someone who may read a setting but not change it, and `busy` holds it
read-only and announced as busy while a change saves. The lab's form stories show each state.
