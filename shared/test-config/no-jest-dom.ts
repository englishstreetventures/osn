// A marker, not a setup file. `vite-plugin-solid` prepends
// `@testing-library/jest-dom/vitest` to `setupFiles` for every Vitest run unless
// some entry's path already matches /jest-dom/ — see `getJestDomExport` in the
// plugin's `dist/esm/index.mjs`. Naming this file so the path matches is what
// suppresses that, and it is worth several seconds of setup per package.
//
// Never put real setup code here. It belongs to no package, so turbo's `test`
// task inputs do not hash it and editing it would invalidate nobody's cache.
// A test that needs a jest-dom matcher imports
// `@testing-library/jest-dom/vitest` itself.
export {};
