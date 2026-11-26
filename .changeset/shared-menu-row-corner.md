---
"@shared/design-tokens": minor
"@shared/ui": patch
"@tools/lab": patch
---

A fourth radius role, `--ui-radius-menu-row` (`rounded-ui-menu-row`): the corner of a row inside a menu panel. `DropdownMenu`'s rows in both looks and `MENU_TOUCH`'s rows read it. It falls back to `--ui-radius-sm`, so an app that maps none draws its rows where they were: pulse's and cire's stay at 6px. An app can now round its menu rows like its list rows without raising `--ui-radius-sm`, which the drawn `Checkbox`'s 16px box reads too and would turn round. The default menu's frozen test reads the new class name and holds a row's corner at `--ui-radius-sm` while no menu-row corner is mapped, a case that also passes on the code before the change.

The lab lists the role in the radius gallery, gives cire's subtree the role's fallback, and adds `shared/ui/overlays/MenuRowCorner`: an open default menu above a drawn `Checkbox`, its control lending the role 8px or nothing, with both corners read back from the page.
