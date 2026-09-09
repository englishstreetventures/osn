---
"@pulse/landing": patch
"@osn/landing": patch
---

Move the root `svgo` override from `^4.0.2` to `^4.1.0`, clearing
GHSA-w27v-7q3p-w38r. `svgo` reaches these packages through Astro, which runs it
over SVG assets at build time, so the optimiser they build with changes.

The version-less `@cire/*` Astro packages take the same upgrade and are not
named here, because a changeset may not mix versioned and version-less
packages.
