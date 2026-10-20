---
"@shared/ui": minor
"@tools/lab": patch
---

`@shared/ui` gains `Tooltip` (`@shared/ui/ui/tooltip`): a short label that
explains itself on hover. One `text` string feeds both copies — hidden text
inside the trigger, which a screen reader reads once, and a panel a mouse user
sees on hover, which is `aria-hidden` and which the trigger does not point at.
The trigger is a plain inline-block `<span>`, so it adds no tab stop. The lab
shows it under shared/ui/overlays.
