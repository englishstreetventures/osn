---
"@shared/ui": minor
"@tools/lab": patch
---

`Button` gains two opt-in props; a button that uses neither draws as before.

`variant="link" size="inline"` is a link set inside a sentence: underlined at
rest, in the sentence's own size, line height and weight, adding no height to
the line. An `<a>` wearing `buttonVariants({ variant: "link", size: "inline" })`
wraps with the text, and its focus ring closes round each line. A standalone
`link` still underlines on hover only.

`busy` marks a wait the button started. While busy it keeps keyboard focus, sets
`aria-busy` and `aria-disabled`, refuses activation (a click, Enter, Space, and
the form submission they would make, with or without an `onClick`), dims as a
disabled button does except while focused from the keyboard, where it stays at
full strength so its focus ring keeps its contrast, and draws the 20px `Orb`
before the label the caller passes. The orb loads as a chunk of its own,
fetched only by a page holding a `Button` that carries a `busy` prop.

`ButtonProps` is now a union: `inline` goes with `link` only, and `busy` is not
accepted at `icon` or `inline`. A caller holding a variant and a size in
variables narrows them per member. The box classes (`inline-flex`, gap, no
wrap, type step, weight) move from the base string into each box size; every
existing variant and size keeps the same class set, except that `sm` drops the
`text-ui-base` its own `text-ui-sm` overrode. No computed style changes.

The lab's `shared/ui/Button` gains `Inline` and `Busy` stories, and its
Playground a `busy` control.
