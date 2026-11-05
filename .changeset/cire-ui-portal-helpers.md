---
"@cire/ui": minor
---

`@cire/ui/lib/auto-size`, `@cire/ui/lib/theme`, `@cire/ui/lib/theme-boot` and `@cire/ui/lib/haptics` hold the helpers the host and vendor portals each copy: `createAutoSize` as it is, `createPreferences({ themeKey, hapticsKey })` and `themeBootScript(storageKey)` with each portal's storage keys passed in, and `createHaptics({ enabled, names })`, whose `haptic` takes only the names a portal uses. `web-haptics` 0.0.6 becomes a dependency.
