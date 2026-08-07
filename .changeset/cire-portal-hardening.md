---
"@cire/host": patch
"@cire/vendor": patch
"@cire/theme": patch
---

Housekeeping behind the host-portal redesign: dependency overrides, a type-check
gate for `@cire/host`, and a Content-Security-Policy for both portals.

**Dependency overrides.** `bun audit` reported 7 vulnerabilities (2 high, 5
moderate) against transitive `undici`, `fast-uri` and `postcss`. All three are
pinned by root `overrides`; bumping them within their current majors
(`undici ^7.28.0 → ^7.29.0`, `fast-uri ^3.1.4 → ^3.1.5`,
`postcss ^8.5.18 → ^8.5.25`) clears the report to `No vulnerabilities found`.

**`astro check` for `@cire/host`.** The portal had no type-check script, so
its 167 files sat outside CI's `bun run check` — and had accumulated 163 errors.
All fixed, none by loosening a type:

- 135 of them were the jest-dom matchers. Vitest 4 ships `toBeInTheDocument`
  and friends at runtime but not their types, so every assertion using one was
  an error. A six-line types-only `.d.ts` pulls in
  `@testing-library/jest-dom/vitest`; no test behaviour changes.
- 15 more were `Array.prototype.toSorted` under `lib: ES2022` (plus the
  implicit-any cascade onto the comparators). Bumped to `ES2023`.
- The rest were real: `vi.fn()` mocks needing an explicit `Mock` annotation,
  two `WeddingList` fixtures carrying an invalid `role: "host"` and missing
  `entitlements`/`guestCap`, and a `resolveSeeds` signature in `@cire/theme`
  that declared `Partial<PaletteSeeds>` while its own `??` chain had always
  accepted a per-role `null` — widened at the definition instead of cast at the
  one real caller.

**CSP on the organiser and vendor portals** (CHR-S-L3 / VP-S-L3). Both shipped
`frame-ancestors 'none'` and nothing else. They now carry an enforced line with
only the directives that cannot break a working page (`frame-ancestors`,
`object-src 'none'`, `base-uri 'self'`) plus the real lock-down in
`Content-Security-Policy-Report-Only`, reporting to cire-api's existing
first-party collector — the same staging `cire/invites` used. Source lists were
audited from the code rather than guessed: cire-api is the only `connect-src`
origin (sign-in is a top-level redirect, which no `connect-src` governs), the
organiser needs `data:`/`blob:` images for the crop editor and CSV export, and
it needs no Google Font origins because the redesign self-hosts its faces. A
`_headers` unit test in each package pins the directive set against drift.
