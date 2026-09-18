---
"@cire/ui": patch
"@cire/invites": patch
"@cire/host": patch
---

Give the guest sheet its width cap back as a class, and put a real target size
under every borderless icon button.

**The cap.** `AnimatedModal` carried its 480px cap as an inline `max-width`
because `shadcn/no-restyle` rejected `max-w-column-md` on a `<Modal>`. The
diagnosis that led to the inline style was wrong in a way worth recording: the
allow list _is_ consulted for a class the grammar cannot classify — what failed
was naming the family on the rule's top-level `allow`, which a `contracts`
entry's own `allow` **replaces** rather than extends, and `Modal` is inside one.
Named on that contract, the class lints clean. The rejected set is also wider
than it looked: every `max-w-*` built from a custom `--container-*` entry is
unclassified, the contract's own `max-w-ui-*` included, so both families are
named there. A browser test now asserts the panel resolves to 480px, which is
the thing an inline style and a rem step cannot be told apart by.

**The target size.** `size="icon"` on a borderless variant set no height and no
vertical padding, so the box was the glyph's line box and nothing more —
measured at **22.3 × 18.8 px**, under WCAG 2.2 SC 2.5.8's 24px minimum in both
axes. The events drag grip, which is a row's only pointer affordance for
re-ordering, carried a comment asserting a `py-2` that was not there. The floor
is now `@cire/ui`'s (`min-h-6 min-w-6`), so every borderless icon button gets it
at once; a floor rather than a fixed size, so the call sites that already ask for
a larger target still win. `EventsEditor.grip.browser.test.tsx` measures it, and
fails at 22.3px without the fix.
