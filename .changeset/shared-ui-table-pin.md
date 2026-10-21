---
"@shared/ui": minor
---

`Th` and `Td` take a `pin` variant for a table whose head row or first column
must stay in view while it scrolls: `Th pin="top"` holds a head at the top of
the table's box, `Th pin="top-start"` the corner head, and `Td pin="start"` a
first-column cell at the start edge. A pinned cell is sticky, paints the page
ground so rows passing under it never show through, and the start column
carries a full hairline on its end edge. To hold a head row as rows scroll by,
give `Table` a height to scroll within (`max-h-*`, `overflow-y-auto`),
`isolate`, `relative`, and scroll padding a little larger than the head row
and the pinned column (`scroll-pt-*`, `scroll-ps-*`) so focus is never left
under a pinned cell. Nothing changes for a cell without `pin`.
