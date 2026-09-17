/**
 * `vite/client` is what declares a side-effect import of a `.css` file. The
 * browser tier imports a real stylesheet — it has to, or every colour assertion
 * measures an unstyled document — and without this `tsc` rejects the import
 * while vitest runs it happily, which is the worst pair of behaviours to have.
 *
 * Scoped to `tests/` rather than `src/`: the package itself ships no CSS and
 * should not start looking as though it might.
 */
/// <reference types="vite/client" />
