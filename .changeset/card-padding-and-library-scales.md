---
"@shared/ui": minor
"@musubi/social": patch
"@pulse/web": patch
---

`Card` gains a `padding` prop, and the libraries themselves go on the scale

15 call sites across `@pulse/web` and `@musubi/social` were spelling a card's
padding as `class="p-4"`, `"p-5"` or `"p-6"`. It is `padding="sm" | "md" |
"lg"` now.

`none` stays the default, and that is not an oversight: a card built from
`CardHeader` / `CardContent` / `CardFooter` takes its padding from those, and a
default here would double it. The two shapes are genuinely different cards, and
a test asserts the composed one picks up no padding of its own.

The scale codemod had only been run over the six apps, never over `@shared/ui`,
`@cire/ui`, `@shared/toast` or `@shared/sortable` — so the libraries still
carried four arbitrary type values of their own, including
`AvatarFallback`'s `text-[10px]`. They are on the contract's steps now.
