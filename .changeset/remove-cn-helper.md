---
"@shared/ui": minor
---

Remove `cn()` from `@shared/ui/lib/utils`, and the `tailwind-merge` dependency it was the only reason for. Nothing called it. `clsx()` stays and is the one way to join classes: a component writes its defaults with the `base:` variant, so a caller's unprefixed utility wins through the cascade and no conflict needs settling at runtime.
