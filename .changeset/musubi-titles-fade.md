---
"@musubi/social": patch
"@osn/auth-ui": patch
---

Musubi's dialog and card titles draw at 14px and weight 500, its title step, and its overlays fade with no scale. The contract block in `App.css` maps `--ui-text-md` to `--text-title`, `--ui-weight-title` to 500, and `--ui-scale-enter` and `--ui-scale-exit` to 1, so `DialogTitle`, `CardTitle` and every Kobalte overlay (dialog as card and as sheet, popover, menus) follow with no class at a call site. `OtpInput`'s digits read `--ui-text-md` too: 14px from 768px, as `Input` is, and still 16px below through the mobile input rule. The account menu's separator is the shared hairline fill. `DESIGN.md` records the titles, the separator and the fade under §Typography, §Borders, §Chips, §Motion and §Token contract; `@osn/auth-ui`'s `DESIGN.md` says its dialogs fade in Musubi and what size its code boxes take there.
