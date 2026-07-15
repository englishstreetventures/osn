---
"@cire/organiser": patch
---

Two organiser-portal UI-polish tweaks from the product-owner IA review.

- **Overview countdown de-dupe** — the wedding-date countdown printed the day
  count twice (a big number and, redundantly, a "N days to go" line). It now
  shows the count once: the big number with "days to go" / "days ago" as its
  label beneath it. The "No date yet" empty-state, singular/plural handling, and
  the "Today!" / "Tomorrow!" / past-date edge cases are preserved.
- **Themed calendar date picker in Settings** — the wedding date is now edited
  with a custom `DatePicker` (a month-grid calendar built on the existing
  Kobalte `Popover` primitive — Kobalte 0.13 ships no DatePicker, so this adds
  **no new dependency**) styled to the portal's gold/bordered aesthetic instead
  of a plain native date input. It keeps the `YYYY-MM-DD | null` contract the
  settings API already uses (no payload change), is keyboard-navigable with grid
  ARIA roles and focus management, and renders read-only for co-hosts.
