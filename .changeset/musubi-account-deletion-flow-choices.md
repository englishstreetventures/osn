---
"@shared/ui": minor
"@musubi/social": patch
"@osn/auth-ui": patch
"@pulse/web": patch
"@tools/lab": patch
---

`Checkbox`, `RadioGroup` and `Switch` draw on one rule: the control sits on its words' first line whatever their length, 8px from them, at prose leading; a chosen radio's 8px dot sits in the centre of its 16px circle; options are 8px apart in a column and 16px in a row; keyboard focus is the house outline, 2px off. `align` is gone (every control sits on the first line). `RadioGroup` and `Checkbox` take `touch`: below `md` each row is a 44px target and the space between options stays even, with nothing around it moving. `RadioGroupItem` takes a `description`. Musubi's deletion flow and the recovery-codes box use `touch` in place of their own row classes; Pulse's attendance setting puts each option's line under its words, and Pulse maps `--ui-choice-edge` to its `--subtle`, so an unchosen radio's edge clears 3:1 (it was 1.10–1.31:1 on `--input`, an edge nobody could see on a dark card); Pulse's and Musubi's contract tests hold the choice edge at 3:1 on every ground in both themes.
