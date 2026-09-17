---
"@cire/host": patch
"@cire/invites": patch
---

cire adopts the new table-cell props, and 11 more invite buttons become `<Button>`

21 class overrides on `Th` and `Td` in `cire/host` move to `@shared/ui`'s new
`align`, `tone` and `valign` props, and three `<Table class="font-body">` drop a
class the component now sets itself.

11 more raw buttons in `cire/invites` are `<Button>`. The conversion codemod now
refuses to touch a `<button>` carrying a "Deliberately not `@cire/ui`'s
`Button`" comment — it had already converted the RSVP modal's submit back,
undoing a documented decision about why that control uses `aria-disabled` for a
*confirmed* state, which must look most alive rather than faded.
