---
"@tools/lab": patch
---

The lab's story test fails when a story file imports a stylesheet, which would re-theme every story in the lab. The README and registry comment say where UI-package components' stories live (`src/stories/shared-ui/`, `osn-auth-ui/`, `cire-ui/`), and that a story with its own design language sets the `--ui-*` contract inline on a wrapper instead.
