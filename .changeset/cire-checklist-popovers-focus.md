---
"@cire/host": patch
---

A checklist row's two popovers open with nothing picked. The task-time popover
is headed "Set task time" with nothing between the heading and its first field,
and no field wears the focus ring until Tab reaches it; its selects keep to the
panel's padding. The "Assign people" popover opens with nobody highlighted, so
the organiser, listed first, no longer looks chosen and one stray Enter does
not put them on the task. Both popovers focus their panel as they open.

They also open smoothly: from 40% of their size, corners round, they grow to
full size on the portal's ease-out with no overshoot, their corners squaring
and their contents fading in as they grow, and a close or a reopening caught
mid-way goes on from where the panel is. Opened from the keyboard, they appear
at once. A task added on the checklist fades in where it lands.
