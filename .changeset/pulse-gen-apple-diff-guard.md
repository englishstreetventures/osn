---
"@pulse/app": patch
---

Guard the committed, hand-edited iOS Xcode project against regeneration. A CI
script fails if anything under `src-tauri/gen/apple/` is uncommitted, and the
app README records why `tauri ios init` must never run on this repo.
