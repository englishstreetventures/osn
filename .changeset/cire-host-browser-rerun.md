---
"@cire/host": patch
---

Four browser tests pass when Vitest runs them twice in one page (`--repeats`). The module-panel fade test holds the Seating view on a read made at each mount, since the view's chunk stays loaded for the page's life. The checklist popover's pace runs as two tests, the touch one last in its file, and the file fails any other test that runs after it. The RSVP page's tests move the pointer to the middle of the page after each test, passed or failed. The undo test's ✕ carries `data-undo-key` as every list's ✕ does, so Undo hands focus back before the toast hides, and the test now checks that it does.
