---
"@shared/toast": patch
---

A toast's action can carry its own accessible name (`action.ariaLabel`), so
several toasts that each offer "Undo" can say which row each one restores.
Each toast element now carries `data-toast-id`, the id `toast()` returned, so
the caller can find the toast it raised, to move focus to its action.

The action's look and the arrival's curve join the `--toast-*` contract:
`--toast-action-case`, `--toast-action-tracking`, `--toast-action-radius`,
`--toast-action-size` and `--toast-action-weight`, and
`--toast-enter-easing`. Each defaults to the value the stylesheet wrote
before, so an app that maps none of them sees no change. The comment on the
bottom positions now says what `column-reverse` does: the oldest toast stays
nearest the edge.
