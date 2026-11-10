---
"@musubi/social": patch
---

`src/App.tsx` exports `shells`: for each shell, its component, its frame and the `load` it waits for before it draws. `Reserved` awaits a shell's `load` and nothing else, and the browser tests' `railChunks()` and `topBarChunks()` await the same `load`, so a load added to a shell reaches the tests' waits with no second edit. The app loads the same chunks in the same way as before.
