---
"@shared/observability": patch
"@shared/ui": patch
---

Add `dietaryPresets` / `dietary_presets` to the log-redaction deny-list.

Cire stores dietary requirements as keys from a closed vocabulary as well as free
text. A key is no less revealing than the sentence it replaced — `halal` names a
religious practice outright, `nuts` a health condition — so it needs the same
scrubbing `dietary` already had. Structured is not anonymous.

Also: a `Popover` opened from inside a `Modal` now mounts its panel into the open
dialog rather than `<body>`.

`Modal` is `<dialog>` + `showModal()`, so it paints in the top layer, above every
stacking context in the document — a panel portalled to `<body>` sat behind it at
any `z-index`, laid out and announced by a screen reader but dead to a pointer.
Mounting into the dialog inherits its top-layer promotion and leaves Kobalte's
positioning untouched. A `frame` Modal is `overflow-hidden` and still clips the
panel; that case is recorded in `popover-in-modal.browser.test.tsx` and tracked
separately.
