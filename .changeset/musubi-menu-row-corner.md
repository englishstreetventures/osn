---
"@musubi/social": patch
---

Musubi maps the contract's menu-row corner, `--ui-radius-menu-row`, to its 8px `--radius-md`, so the rows of the account menu and the theme menu take the 8px corner `DESIGN.md` §Radii gives list rows and nav items, while `@shared/ui`'s drawn Checkbox, which reads `--ui-radius-sm`, keeps its 6px box. `DESIGN.md` names the mapping and drops menu rows from its list of known breaks.
