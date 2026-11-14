---
"@shared/ui": minor
"@musubi/social": patch
"@osn/auth-ui": patch
"@tools/lab": patch
---

`Button` presses: while a pointer or a held Space presses it, it scales to 0.97 over `--ui-dur-fast` on `--ui-ease-out` and eases back when let go, in every app that draws it (Musubi, `@osn/auth-ui`'s views, pulse). It sets `scale`, so a call site's `transform` stays. No press while disabled, busy or `aria-disabled`, at `size="inline"`, or under `prefers-reduced-motion: reduce`. The colour fade keeps Tailwind's 150ms and curve. Musubi's and `@osn/auth-ui`'s `DESIGN.md` name the press beside the orb, and the lab's `shared/ui/Button` gains a `Press` story.
