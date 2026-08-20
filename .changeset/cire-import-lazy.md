---
"@cire/host": patch
---

Lazy-load the spreadsheet import panel out of the portal's first-load bundle.

`ImportPanel` (~900 lines, pulling in `ChangeHistory`, `ChangePreview` and
`import-templates`) now splits into its own chunk, loaded via
`lazy(() => import("./ImportPanel"))` inside `EditWorkspace` and warmed on
pointer/focus intent over the "Spreadsheet import" radio, matching the
`warmPanel` pattern already used in `ModuleShell`. `PanelLoading` — the shared
in-flight fallback — moved out of `ModuleShell.tsx` into its own
`PanelLoading.tsx` so both consumers can import it without a cycle.
