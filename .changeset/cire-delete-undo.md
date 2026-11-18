---
"@cire/host": patch
"@tools/e2e": patch
---

A checklist task's, a budget line's and a gift's ✕ can now be taken back. The
row leaves the list at once and a toast offers Undo for five seconds; the
delete is sent only once that toast has gone without Undo, or as the page is
left, so Undo puts back the very row, with its holders, payments, claims and
picture, and a second toast says so. The row lands where it stood unless the
list was reordered while the toast was up. Several deletes stack, and each
Undo names the row it restores. The shared helper is `src/lib/undo-delete.ts`.

A ✕ pressed from the keyboard or by a screen reader moves focus to its Undo,
and the toast waits while focus stays there; Undo hands focus back to the
restored row's ✕. A delete that meets an expired session sends the organiser
to sign in, the row still on the server.

The undo toast arrives on the `--dur-slow` rung and the portal's ease-out
(provisional, until the owner picks the rung by eye), and leaves at once since
it holds a live button; every other toast keeps the package's arrival. A
restored row fades in where it stood; under reduced motion all of it is
immediate. A toast's action is drawn as a portal button: its label as
written, on a pill.

The `cire-checklist-starter` E2E flow now ends by deleting three starter
tasks against the real API: one taken back with Undo, which never leaves
cire's database; one whose toast runs out, which does; and one deleted as the
page is left, whose `DELETE`, sent on `pagehide`, still lands.
