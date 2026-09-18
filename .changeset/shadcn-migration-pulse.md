---
"@pulse/web": patch
"@pulse/landing": patch
---

Second migration pass over the Pulse surfaces: 64 more `@shadcn/lint` sites
cleared, and two real defects with them.

**`CreateEventForm` painted its validation errors and announced nothing.** Two
inputs set `border-destructive` by hand and no `aria-invalid` at all, so the
error was visible to a sighted user and invisible to a screen reader. They set
`aria-invalid` now and the border comes from `controlClass`'s own
`base:aria-[invalid=true]:border-ui-danger`, which was already there and unused.

**`ShareEventButton` drew two different Share buttons depending on viewport.**
The desktop branch hand-wrote `bg-secondary … rounded-md px-3 text-xs` onto a
`PopoverTrigger`; the mobile branch eleven lines below already rendered
`<Button variant="secondary" size="sm">`. Every class matched except the radius
— 8px against the component's 10px. The trigger is now
`<PopoverTrigger as={Button} variant="secondary" size="sm">`.

The arbitrary values move onto the scales value-for-value where one exists
(`w-[46px]` → `w-11.5`, `min-w-[180px]` → `min-w-45`, `rounded-[10px]` →
`rounded-lg`, which is pulse's own `--radius`). One value moved: `rounded-[5px]`
→ `rounded-sm`, 5px to 6px.

`pulse/web/src/lib/ui.ts` was considered for the repeated call-site classes and
deliberately not used. Replacing a flagged literal with `class={SOME_CONST}`
makes the rule report nothing, because the attribute stops being a string
literal — measured, not assumed. That would silence the rule without changing
one byte of what lands on the shared component, and hide the backlog from the
ratchet. `lib/ui.ts` stays right for an app treatment on an app element, which
is what `CLOSE_FRIEND_RING_CLASS` is; none of these are that.
