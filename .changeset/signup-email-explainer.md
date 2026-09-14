---
"@osn/ui": minor
"@pulse/web": patch
"@tools/lab": patch
---

Say what the sign-up email address is for, beside the Email field.

The address does three jobs and the form named none of them: it verifies the
account by six-digit code (no account row exists until the code is accepted), it
is the emailed-code way back into an account whose passkeys are all gone, and it
receives security notices. The second is the one that should steer which address
a person types, and it was the least visible.

`InfoPopover` — the circled-glyph button that was already doing this job on
`@pulse/web`'s create-event form — moves to `@osn/ui` as
`@osn/ui/ui/info-popover`, so `Register` can use it too. Two new props: `glyph`
picks the character (`?` still the default, so the seven `@pulse/web` call sites
are unchanged) and `placement` picks the side. `Register`'s Email label gets an
`i` that opens above the label, because Kobalte's default `"bottom"` would open
the panel over the input the reader is about to type into.

`@pulse/web` keeps both call sites and behaviour; its copy of the component and
that copy's test both move to `@osn/ui`, so the coverage travels with the file
rather than disappearing.

`PopoverContent` now carries `data-kb-top-layer`, which fixes a bug for every
popover rather than only this one. A Kobalte `Dialog` is modal by default and
sets `aria-hidden="true"` on everything outside itself, reaching nodes portalled
to `<body>` afterwards through a `MutationObserver`. `PopoverContent` portals to
`<body>`, so any popover opened from inside a dialog was visible on screen and
missing from the accessibility tree. That attribute is the exemption Kobalte
itself uses for `ToastRegion`. It sits on the component rather than behind a
prop, so no call site has to remember it. Dismissal is unchanged — the toggle
and Escape tests pass with it in place, and each still fails when its dismiss
action is removed.

Two of the five moved tests asserted nothing and were rewritten rather than
carried over. The toggle test ended in `expect(!content || closedParent ||
expandedParent).toBeTruthy()`, where `expandedParent` matches while the popover
is still open — it passed either way; and the Escape test fired the key and then
ended in a comment. Both now read Kobalte's disclosure state directly
(`aria-expanded`, plus `data-closed`/`data-expanded` on the panel), which is what
the exit animation keeping the panel mounted had made awkward to assert. Four
more tests cover the chosen glyph, `type="button"`, keyboard reachability, and a
click that does not submit the surrounding form — that last one with a positive
control, so it cannot pass in an environment that dispatches no submit at all.
