---
"@shared/ui": minor
---

`Checkbox`, `RadioGroup` and `RadioGroupItem` are native inputs inside their labels, with nothing from Kobalte. `aria-label`, `aria-labelledby`, `aria-describedby`, `aria-invalid`, `disabled`, `name`, `value`, `id` and `required` land on the input, and a label is JSX, so it can hold a link or a second line. Both stay controlled: a change the caller refuses never shows as made, and a `RadioGroup`'s `value` is now required (`""` for none chosen).

New props: `box` (`drawn`, the default and pulse's look, unchanged; or `native`, the browser's own box when ticked and a hairline edge when not, at 13px either way), `size` (`md` or `sm` label), `align` (`start` centres the box on a wrapped label's first line), and on `RadioGroup` `orientation` (`native` puts 16px between radios in a row, 8px in a column). `Checkbox` gains `description`, inside the label, and `note`, under the row and outside the label. A disabled drawn box fades to 50%; pulse passes `disabled` nowhere today, so nothing it draws moves.

`Checkbox`, `RadioGroup` and `Switch` put the caller's value back once mounted, so a form state the browser restored before hydration never shows; and in a Windows contrast theme their drawn box, circle and track draw keyboard focus as an outline, and a chosen drawn radio keeps its dot.
