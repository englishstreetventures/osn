---
"@osn/auth-ui": minor
---

`AuthHeader`, a new export (`@osn/auth-ui/AuthHeader` and the barrel): the title row of a sign-in or create-account view. With `host="dialog"` its title is the dialog's `DialogTitle` in a `DialogHeader`, so the dialog takes its name from it. With `host="page"` it is a plain `h2` in the same type with no padding or rule, for `/authorize`, where the page's own heading leads. An optional Cancel sits at the row's end, `secondary` in a dialog and `ghost` on a page, 40px tall below `md`; `cancelLabel` changes its words (a blank one reads "Cancel") and `cancelDisabled` holds it while the view's call runs. No view uses it yet.
