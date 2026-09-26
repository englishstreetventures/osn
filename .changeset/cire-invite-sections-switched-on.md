---
"@cire/db": patch
---

Migration 0065 switches the hero, Our Story and closing section on for every
existing invite, so a section that 0063 left switched off because it was blank
shows as soon as the couple fills it in. Switched on, a blank section still
renders nothing, so guests see no change; in the builder a blank section's
badge reads "Hidden — empty" instead of "Hidden — switched off". The FAQ switch
and every other column are left as they are, and only rows with a switch off
are written.
