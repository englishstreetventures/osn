---
"@pulse/app": minor
"@pulse/api": patch
"@osn/api": patch
"@osn/client": patch
"@osn/social": patch
---

Remove the Tauri desktop/mobile shell from Pulse. `@pulse/app` stays exactly where it is, keeps its package name, and stays a browser SPA — Pulse is going native in Swift instead, and no Tauri build ever shipped.

Deleted `pulse/app/src-tauri/` outright (Rust crate, `gen/apple/` Xcode project, capabilities, build guard scripts) along with the `@tauri-apps/*` dependencies, the `tauri://localhost` CORS/origin-guard allowance in `@osn/api` and `@pulse/api`, and the `@tauri-apps/plugin-opener` usage in `MapPreview.tsx` / `AddToCalendarButton.tsx` (replaced with plain browser APIs). `@osn/client`'s `session-fetch.ts` keeps its `setSessionFetch`/`sessionFetch` seam — only the Tauri-specific doc comments referencing it were dropped.

Dev ports (1420 for `@pulse/app`, 1422 for `@osn/social`) and `strictPort` are untouched; `@osn/social`'s dev server drops its `TAURI_DEV_HOST` host/HMR override and its `src-tauri` watch-ignore, which changes nothing about the shipped build. CI, docs, and wiki pages updated to match; historical changelog entries are left as-is.
