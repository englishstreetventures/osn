---
"@osn/api": patch
"@pulse/api": patch
---

Run most test files with `isolate: false`, so a Vitest worker loads the app once instead of once per file. Files that call `vi.mock`, `vi.doMock` or `vi.resetModules` keep their own module cache in a separate project, and a setup file restores timers, mocks, stubs and `process.env` after each file.
