---
"@cire/host": patch
---

A checklist row's two popovers open with nothing picked. The task-time popover
is headed "Set task time" with nothing between the heading and its first field,
and no field wears the focus ring until Tab reaches it; its selects keep to the
panel's padding. The "Assign people" popover opens with nobody highlighted, so
the organiser, listed first, no longer looks chosen and one stray Enter does
not put them on the task. Both popovers focus their panel as they open. Their
droplet now grows and shrinks on transitions, so closing one mid-opening, or
opening it again mid-close, goes on from where it is instead of jumping.
