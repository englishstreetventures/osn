---
"@cire/host": patch
---

A checklist task's, a budget line's and a gift's ✕ can now be taken back. The
row leaves the list at once and a toast offers Undo for five seconds; the
delete is sent only once that toast has gone without Undo, or as the page is
left, so Undo puts back the very row where it stood, with its holders,
payments, claims and picture, and a second toast says so. Several deletes
stack, and each Undo restores its own row. The shared helper is
`src/lib/undo-delete.ts`.

Every portal toast now arrives on the `--dur-slow` rung, an undo toast leaves
at once since it holds a live button, and a restored row fades in where it
stood; under reduced motion all of it is immediate.
